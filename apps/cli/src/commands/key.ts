import { encodeInvite, findBot, saveBot, writeBook } from '@jaypost/store'
import type { Book } from '@jaypost/store'
import type { AdminCaller, AdminResult } from '@jaypost/client'
import type { CreatedKey, KeysBody } from '@jaypost/protocol'
import { loadBook, openAdmin, openAdminCaller } from './admin-access.ts'
import { formatTable, printResult, runAdminCommand } from './admin.ts'
import { KEY_SHOWN_ONCE_NOTE } from './constants.ts'
import { formatInvite } from './pairing.ts'
import type { AdminDeps, AdminIdArgs, KeyCreateArgs, KeyLabelArgs, KeyListArgs } from './types.ts'

function formatKeys(body: KeysBody): string {
  if (body.keys.length === 0) {
    return 'No keys.'
  }
  return formatTable(
    ['ID', 'BOT', 'PAIRING', 'LABEL', 'EXTERNAL ID', 'CREATED'],
    body.keys.map((key) => [
      key.id,
      key.bot,
      key.pairing,
      key.label,
      key.externalId,
      key.createdAt.slice(0, 10),
    ]),
  )
}

/** Whether a book alias may be written: free, replacing it was confirmed, or not. */
type AliasClaim = 'free' | 'taken' | 'declined'

/** The pairing code and how to use it while the pairing waits; nothing once paired. */
function formatPairingLines(created: CreatedKey): readonly string[] {
  return created.code === undefined
    ? []
    : [
        formatInvite(created.code, created.instructions),
        'The key works once someone sends that code to the bot.',
      ]
}

/** The key, once, then the pairing code and how to use it while the pairing waits. */
function formatCreatedKey(created: CreatedKey): string {
  return [
    `Key ${created.id} (pairing ${created.pairing}): ${created.key}`,
    KEY_SHOWN_ONCE_NOTE,
    ...formatPairingLines(created),
  ].join('\n')
}

/** The `jaypost join` line to send in place of the key, then the pairing code as usual. */
function formatInvitedKey(created: CreatedKey, invite: string, label: string | undefined): string {
  return [
    `Send this to ${label ?? 'them'} (it holds their key, send it privately):`,
    '',
    `  jaypost join ${invite}`,
    KEY_SHOWN_ONCE_NOTE,
    ...formatPairingLines(created),
  ].join('\n')
}

/**
 * Checks `alias` against the book: free, or taken and replaced after a confirmation on a terminal.
 * Off a terminal a taken alias is refused with a hint to pick another with `--as`.
 */
async function claimAlias(book: Book, alias: string, deps: AdminDeps): Promise<AliasClaim> {
  if (findBot(book, alias) === undefined) {
    return 'free'
  }
  if (!deps.isInteractive) {
    deps.printError(`a bot is already named "${alias}"; pick another with --as`)
    return 'taken'
  }
  return (await deps.prompt.confirm(`Replace "${alias}" in your contacts?`, false))
    ? 'free'
    : 'declined'
}

/**
 * The alias `--save` gives a key: the label of its bot, else the bot's display name, else its id.
 * The bot is `--bot`, else the one the new key belongs to.
 */
async function resolveSaveAlias(
  caller: AdminCaller,
  created: CreatedKey,
  args: KeyCreateArgs,
): Promise<AdminResult<string>> {
  let botId = args.bot
  if (botId === undefined) {
    const keys = await caller.listKeys({})
    if (keys.kind === 'failed') {
      return keys
    }
    botId = keys.value.keys.find((key) => key.id === created.id)?.bot
    if (botId === undefined) {
      return {
        kind: 'failed',
        reason: 'unexpected',
        message: `the service didn't list key ${created.id}, so it wasn't saved`,
      }
    }
  }
  const bots = await caller.listBots()
  if (bots.kind === 'failed') {
    return bots
  }
  const bot = bots.value.bots.find((each) => each.id === botId)
  return { kind: 'ok', value: bot?.label ?? bot?.displayName ?? botId }
}

/** An empty string clears the field (null on the wire); absent keeps it. */
function toUpdatedField(
  name: 'label' | 'externalId',
  value: string | undefined,
): { readonly label?: string | null } | { readonly externalId?: string | null } {
  if (value === undefined) {
    return {}
  }
  return { [name]: value === '' ? null : value }
}

/**
 * Creates an API key for a new pairing on `bot`, an existing `pairing`, or the pairing of the key
 * `sameAs`, and prints it once. `save` also writes it to the book as a bot; `invite` prints a
 * `jaypost join` line holding it instead, for a remote only. The pairing code prints either way.
 * Returns 0, 1 on failure, 2 on bad flags.
 */
export function runKeyCreate(args: KeyCreateArgs, deps: AdminDeps): Promise<number> {
  return runAdminCommand(deps, async () => {
    const targets = [args.bot, args.pairing, args.sameAs].filter((target) => target !== undefined)
    if (targets.length !== 1) {
      deps.printError('give exactly one of --bot, --pairing and --same-as')
      return 2
    }
    if (args.save === true && args.invite === true) {
      deps.printError('give at most one of --save and --invite')
      return 2
    }
    if (args.as !== undefined && args.save !== true) {
      deps.printError('give --as only with --save')
      return 2
    }
    const opened = await openAdmin(deps)
    if (opened.kind !== 'opened') {
      deps.printError(opened.message)
      return 1
    }
    const { endpoint } = opened.endpoint
    if (endpoint.kind === 'invalid') {
      deps.printError(endpoint.message)
      return 1
    }
    if (args.invite === true && opened.endpoint.kind !== 'remote') {
      deps.printError('invites need a remote; add one with "jaypost remote add" and use -s')
      return 1
    }
    // Read before the key is made, so a corrupt book or a refused --as alias costs no key.
    const loaded = args.save === true ? loadBook(deps.bookPath) : undefined
    if (loaded?.kind === 'failed') {
      deps.printError(loaded.message)
      return 1
    }
    if (loaded !== undefined && args.as !== undefined) {
      const claim = await claimAlias(loaded.book, args.as, deps)
      if (claim !== 'free') {
        if (claim === 'declined') {
          deps.printError('Cancelled.')
        }
        return 1
      }
    }
    const result = await opened.caller.createKey({
      ...(args.bot === undefined ? {} : { bot: args.bot }),
      ...(args.pairing === undefined ? {} : { pairing: args.pairing }),
      ...(args.sameAs === undefined ? {} : { sameAsKey: args.sameAs }),
      ...(args.label === undefined ? {} : { label: args.label }),
      ...(args.externalId === undefined ? {} : { externalId: args.externalId }),
    })
    if (result.kind === 'failed') {
      deps.printError(result.message)
      return 1
    }
    const created = result.value
    const url = endpoint.url.href
    if (args.invite === true) {
      const invite = encodeInvite({ url, key: created.key })
      printCreatedKey({ ...created, invite }, args, deps, () =>
        formatInvitedKey(created, invite, args.label),
      )
      return 0
    }
    printCreatedKey(created, args, deps, () => formatCreatedKey(created))
    if (loaded === undefined) {
      return 0
    }
    return saveCreatedKey(opened.caller, created, url, loaded.book, args, deps)
  })
}

/**
 * Prints the created key: JSON on stdout with the shown-once note on stderr, so stdout stays
 * parseable, or `format()`'s lines.
 */
function printCreatedKey(
  value: CreatedKey & { readonly invite?: string },
  args: KeyCreateArgs,
  deps: AdminDeps,
  format: () => string,
): void {
  if (!args.json) {
    deps.print(format())
    return
  }
  deps.print(JSON.stringify(value, null, 2))
  deps.printError(KEY_SHOWN_ONCE_NOTE)
}

/**
 * Saves the key, already printed, to the book as a bot on `url`. A taken alias is replaced only
 * after a confirmation on a terminal (`--as` was confirmed before the key was made). Returns the
 * exit code.
 */
async function saveCreatedKey(
  caller: AdminCaller,
  created: CreatedKey,
  url: string,
  book: Book,
  args: KeyCreateArgs,
  deps: AdminDeps,
): Promise<number> {
  let alias = args.as
  if (alias === undefined) {
    const resolved = await resolveSaveAlias(caller, created, args)
    if (resolved.kind === 'failed') {
      deps.printError(resolved.message)
      return 1
    }
    alias = resolved.value
    const claim = await claimAlias(book, alias, deps)
    if (claim === 'taken') {
      return 1
    }
    if (claim === 'declined') {
      deps.printError('Not saved to your contacts.')
      return 0
    }
  }
  writeBook(deps.bookPath, saveBot(book, { alias, url, key: created.key }))
  const saved = `Saved as "${alias}" in your contacts.`
  if (args.json) {
    deps.printError(saved)
  } else {
    deps.print(saved)
  }
  return 0
}

/** Prints the keys, all or those of one bot or pairing; never a key itself. */
export function runKeyList(args: KeyListArgs, deps: AdminDeps): Promise<number> {
  return runAdminCommand(deps, async () => {
    const caller = await openAdminCaller(deps)
    if (caller === undefined) {
      return 1
    }
    const result = await caller.listKeys({
      ...(args.bot === undefined ? {} : { bot: args.bot }),
      ...(args.pairing === undefined ? {} : { pairing: args.pairing }),
    })
    return printResult(result, args, deps, formatKeys)
  })
}

/** Sets or clears a key's label and external id. Returns 2 when neither is given. */
export function runKeyLabel(args: KeyLabelArgs, deps: AdminDeps): Promise<number> {
  return runAdminCommand(deps, async () => {
    if (args.label === undefined && args.externalId === undefined) {
      deps.printError('give --label, --external-id or both (an empty value clears it)')
      return 2
    }
    const caller = await openAdminCaller(deps)
    if (caller === undefined) {
      return 1
    }
    const result = await caller.updateKey(args.id, {
      ...toUpdatedField('label', args.label),
      ...toUpdatedField('externalId', args.externalId),
    })
    return printResult(result, args, deps, ({ key }) => formatKeys({ keys: [key] }))
  })
}

/** Revokes a key; its open questions end with their timeout answer. Its pairing stays. */
export function runKeyRevoke(args: AdminIdArgs, deps: AdminDeps): Promise<number> {
  return runAdminCommand(deps, async () => {
    const caller = await openAdminCaller(deps)
    if (caller === undefined) {
      return 1
    }
    return printResult(await caller.revokeKey(args.id), args, deps, () => `Revoked key ${args.id}.`)
  })
}
