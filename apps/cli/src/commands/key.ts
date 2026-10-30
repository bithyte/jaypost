import { encodeInvite, findBot, saveBot, writeInbox } from '@jaypost/store'
import type { Inbox } from '@jaypost/store'
import { isLoopbackEndpoint } from '@jaypost/client'
import type { AdminCaller, AdminResult } from '@jaypost/client'
import type { CreatedKey, KeysBody } from '@jaypost/protocol'
import { loadInbox, openAdmin, openAdminCaller } from './admin-access.ts'
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

/** Whether an inbox alias may be written: free, replacing it was confirmed, or not. */
type AliasClaim = 'free' | 'taken' | 'declined'

/** The inbox and alias `--save` writes, or refused (reason printed) before any key is made. */
type SavePlan =
  | { readonly kind: 'ready'; readonly inbox: Inbox; readonly alias: string }
  | { readonly kind: 'refused' }

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

/** The `jaypost inbox join` line to send in place of the key, then the pairing code as usual. */
function formatInvitedKey(created: CreatedKey, invite: string, label: string | undefined): string {
  return [
    `Send this to ${label ?? 'them'} (it holds their key, send it privately):`,
    '',
    `  jaypost inbox join ${invite}`,
    KEY_SHOWN_ONCE_NOTE,
    ...formatPairingLines(created),
  ].join('\n')
}

/**
 * Checks `alias` against the inbox: free, or taken and replaced after a confirmation on a terminal.
 * Off a terminal a taken alias is refused with a hint to pick another with `--as`.
 */
async function claimAlias(inbox: Inbox, alias: string, deps: AdminDeps): Promise<AliasClaim> {
  if (findBot(inbox, alias) === undefined) {
    return 'free'
  }
  if (!deps.isInteractive) {
    deps.printError(`a bot is already named "${alias}"; pick another with --as`)
    return 'taken'
  }
  return (await deps.prompt.confirm(`Replace "${alias}" in your inbox?`, false))
    ? 'free'
    : 'declined'
}

/** A lookup that found nothing, worded like the service's own unknown-id errors. */
function toUnknown(kind: 'bot' | 'pairing' | 'key', id: string): AdminResult<never> {
  return { kind: 'failed', reason: 'notFound', message: `unknown ${kind} "${id}"` }
}

/**
 * The bot the new key will belong to: `--bot`, else the bot of `--pairing`, else the bot of the
 * `--same-as` key. Asked before the key is made, so nothing is created for a refused alias.
 */
async function resolveTargetBot(
  caller: AdminCaller,
  args: KeyCreateArgs,
): Promise<AdminResult<string>> {
  if (args.bot !== undefined) {
    return { kind: 'ok', value: args.bot }
  }
  if (args.pairing !== undefined) {
    const { pairing } = args
    const pairings = await caller.listPairings({})
    if (pairings.kind === 'failed') {
      return pairings
    }
    const found = pairings.value.pairings.find((each) => each.id === pairing)
    return found === undefined ? toUnknown('pairing', pairing) : { kind: 'ok', value: found.bot }
  }
  const { sameAs } = args
  if (sameAs === undefined) {
    return {
      kind: 'failed',
      reason: 'unexpected',
      message: 'give exactly one of --bot, --pairing and --same-as',
    }
  }
  const keys = await caller.listKeys({})
  if (keys.kind === 'failed') {
    return keys
  }
  const found = keys.value.keys.find((each) => each.id === sameAs)
  return found === undefined ? toUnknown('key', sameAs) : { kind: 'ok', value: found.bot }
}

/**
 * The alias `--save` gives the new key: `--as`, else its bot's label, else the bot's display
 * name, else its id.
 */
async function resolveSaveAlias(
  caller: AdminCaller,
  args: KeyCreateArgs,
): Promise<AdminResult<string>> {
  if (args.as !== undefined) {
    return { kind: 'ok', value: args.as }
  }
  const botId = await resolveTargetBot(caller, args)
  if (botId.kind === 'failed') {
    return botId
  }
  const bots = await caller.listBots()
  if (bots.kind === 'failed') {
    return bots
  }
  const bot = bots.value.bots.find((each) => each.id === botId.value)
  if (bot === undefined) {
    return toUnknown('bot', botId.value)
  }
  return { kind: 'ok', value: bot.label ?? bot.displayName ?? bot.id }
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
 * `sameAs`, and prints it once. `save` also writes it to the inbox as a bot; `invite` prints a
 * `jaypost inbox join` line holding it instead, for a remote only. The pairing code prints either way.
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
    // An env-mode JAYPOST_URL on this machine is the local service in disguise; a named remote is
    // the user's choice (a tunnel, say) and stays allowed.
    const isLocalInDisguise =
      opened.endpoint.kind === 'remote' &&
      opened.endpoint.name === undefined &&
      isLoopbackEndpoint(endpoint.url)
    if (args.invite === true && (opened.endpoint.kind !== 'remote' || isLocalInDisguise)) {
      deps.printError('invites need a remote; add one with "jaypost admin remote add" and use -s')
      return 1
    }
    // Everything --save needs is settled before the key is made, so a refusal creates no key.
    const save = args.save === true ? await prepareSave(opened.caller, args, deps) : undefined
    if (save?.kind === 'refused') {
      return 1
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
    if (save === undefined) {
      return 0
    }
    writeInbox(deps.inboxPath, saveBot(save.inbox, { alias: save.alias, url, key: created.key }))
    const saved = `Saved as "${save.alias}" in your inbox.`
    if (args.json) {
      deps.printError(saved)
    } else {
      deps.print(saved)
    }
    return 0
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
 * Reads the inbox and resolves the `--save` alias, checking it is free or, on a terminal, that
 * replacing it is confirmed. `refused` once the reason is printed.
 */
async function prepareSave(
  caller: AdminCaller,
  args: KeyCreateArgs,
  deps: AdminDeps,
): Promise<SavePlan> {
  const loaded = loadInbox(deps.inboxPath)
  if (loaded.kind === 'failed') {
    deps.printError(loaded.message)
    return { kind: 'refused' }
  }
  const alias = await resolveSaveAlias(caller, args)
  if (alias.kind === 'failed') {
    deps.printError(alias.message)
    return { kind: 'refused' }
  }
  const claim = await claimAlias(loaded.inbox, alias.value, deps)
  if (claim === 'declined') {
    deps.printError('Cancelled.')
  }
  return claim === 'free'
    ? { kind: 'ready', inbox: loaded.inbox, alias: alias.value }
    : { kind: 'refused' }
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
