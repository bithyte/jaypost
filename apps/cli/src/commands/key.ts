import {
  BOT_ID_PREFIX,
  CONTACT_ID_PREFIX,
  KEY_ID_PREFIX,
  encodeInvite,
  findBot,
  saveBot,
  writeInbox,
} from '@jaypost/store'
import type { Inbox } from '@jaypost/store'
import type { AdminCaller, AdminResult } from '@jaypost/client'
import type { CreatedKey } from '@jaypost/protocol'
import { isInviteAllowed, loadInbox, openAdmin, openAdminCaller } from './admin-access.ts'
import { printResult, runAdminCommand } from './admin.ts'
import { KEY_SHOWN_ONCE_NOTE } from './constants.ts'
import { formatInvite } from './contact.ts'
import type { AdminDeps, AdminIdArgs, KeyAddArgs } from './types.ts'

/** Whether an inbox alias may be written: free, replacing it was confirmed, or not. */
type AliasClaim = 'free' | 'taken' | 'declined'

/** The inbox and alias `--save` writes, or refused (reason printed) before any key is made. */
type SavePlan =
  | { readonly kind: 'ready'; readonly inbox: Inbox; readonly alias: string }
  | { readonly kind: 'refused' }

/** What `key add` was given: a bot (new contact), a contact, or a key whose contact to reuse. */
type KeyAddTarget =
  | { readonly kind: 'bot'; readonly botId: string }
  | { readonly kind: 'contact'; readonly contactId: string }
  | { readonly kind: 'sameAsKey'; readonly keyId: string }

const KEY_TARGET_PATTERN = new RegExp(
  `^(${BOT_ID_PREFIX}|${CONTACT_ID_PREFIX}|${KEY_ID_PREFIX})\\d+$`,
)

/** Reads a bot, contact or key id by its prefix; `undefined` for any other shape. */
function parseKeyTarget(raw: string): KeyAddTarget | undefined {
  const prefix = KEY_TARGET_PATTERN.exec(raw)?.[1]
  switch (prefix) {
    case BOT_ID_PREFIX:
      return { kind: 'bot', botId: raw }
    case CONTACT_ID_PREFIX:
      return { kind: 'contact', contactId: raw }
    case KEY_ID_PREFIX:
      return { kind: 'sameAsKey', keyId: raw }
    default:
      return undefined
  }
}

/** The pairing code and how to use it while the contact waits; nothing once paired. */
function formatPairingLines(created: CreatedKey): readonly string[] {
  return created.code === undefined
    ? []
    : [
        formatInvite(created.code, created.instructions),
        'The key works once someone sends that code to the bot.',
      ]
}

/** The key, once, then the pairing code and how to use it while the contact waits. */
function formatCreatedKey(created: CreatedKey): string {
  return [
    `Key ${created.id} (contact ${created.contact}): ${created.key}`,
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
 * Off a terminal a taken alias is refused with a hint to pick another with `--save ALIAS`.
 */
async function claimAlias(inbox: Inbox, alias: string, deps: AdminDeps): Promise<AliasClaim> {
  if (findBot(inbox, alias) === undefined) {
    return 'free'
  }
  if (!deps.isInteractive) {
    deps.printError(`a bot is already named "${alias}"; pick another with --save ALIAS`)
    return 'taken'
  }
  return (await deps.prompt.confirm(`Replace "${alias}" in your inbox?`, false))
    ? 'free'
    : 'declined'
}

/** A lookup that found nothing, worded like the service's own unknown-id errors. */
function toUnknown(kind: 'bot' | 'contact' | 'key', id: string): AdminResult<never> {
  return { kind: 'failed', reason: 'notFound', message: `unknown ${kind} "${id}"` }
}

/**
 * The bot the new key will belong to: the bot itself, the bot of the contact, or the bot of the
 * key. Asked before the key is made, so nothing is created for a refused alias.
 */
async function resolveTargetBot(
  caller: AdminCaller,
  target: KeyAddTarget,
): Promise<AdminResult<string>> {
  switch (target.kind) {
    case 'bot':
      return { kind: 'ok', value: target.botId }
    case 'contact': {
      const contacts = await caller.listContacts({})
      if (contacts.kind === 'failed') {
        return contacts
      }
      const found = contacts.value.contacts.find((each) => each.id === target.contactId)
      return found === undefined
        ? toUnknown('contact', target.contactId)
        : { kind: 'ok', value: found.bot }
    }
    case 'sameAsKey': {
      const keys = await caller.listKeys({})
      if (keys.kind === 'failed') {
        return keys
      }
      const found = keys.value.keys.find((each) => each.id === target.keyId)
      return found === undefined ? toUnknown('key', target.keyId) : { kind: 'ok', value: found.bot }
    }
  }
}

/**
 * The alias `--save` gives the new key: `--save ALIAS`, else its bot's label, else the bot's
 * display name, else its id.
 */
async function resolveSaveAlias(
  caller: AdminCaller,
  args: KeyAddArgs,
  target: KeyAddTarget,
): Promise<AdminResult<string>> {
  if (typeof args.save === 'string') {
    return { kind: 'ok', value: args.save }
  }
  const botId = await resolveTargetBot(caller, target)
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

/**
 * Adds an API key for a new contact on a bot, an existing contact, or the contact of a key, by
 * the target's id, and prints it once. `save` also writes it to the inbox as a bot (under the
 * alias when it's a string); `invite` prints a `jaypost inbox join` line holding it instead, for a
 * remote only. The pairing code prints either way. Returns 0, 1 on failure, 2 on bad flags.
 */
export function runKeyAdd(args: KeyAddArgs, deps: AdminDeps): Promise<number> {
  return runAdminCommand(deps, async () => {
    const target = parseKeyTarget(args.target)
    if (target === undefined) {
      deps.printError(
        `key add needs a bot, contact or key id, such as b1, c2 or k3, got ${JSON.stringify(args.target)}`,
      )
      return 2
    }
    if (args.save !== undefined && args.save !== false && args.invite === true) {
      deps.printError('give at most one of --save and --invite')
      return 2
    }
    if (args.save === '') {
      deps.printError('--save needs a non-empty alias, or no value for the default')
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
    if (args.invite === true && !isInviteAllowed(opened)) {
      deps.printError('invites need a remote; add one with "jaypost admin remote add" and use -s')
      return 1
    }
    // Everything --save needs is settled before the key is made, so a refusal creates no key.
    const save =
      args.save === undefined || args.save === false
        ? undefined
        : await prepareSave(opened.caller, args, target, deps)
    if (save?.kind === 'refused') {
      return 1
    }
    const result = await opened.caller.createKey({
      ...toKeyOwner(target),
      ...(args.label === undefined ? {} : { label: args.label }),
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

/** The one `createKey` field the target sets. */
function toKeyOwner(
  target: KeyAddTarget,
): { readonly bot: string } | { readonly contact: string } | { readonly sameAsKey: string } {
  switch (target.kind) {
    case 'bot':
      return { bot: target.botId }
    case 'contact':
      return { contact: target.contactId }
    case 'sameAsKey':
      return { sameAsKey: target.keyId }
  }
}

/**
 * Prints the created key: JSON on stdout with the shown-once note on stderr, so stdout stays
 * parseable, or `format()`'s lines.
 */
function printCreatedKey(
  value: CreatedKey & { readonly invite?: string },
  args: KeyAddArgs,
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
  args: KeyAddArgs,
  target: KeyAddTarget,
  deps: AdminDeps,
): Promise<SavePlan> {
  const loaded = loadInbox(deps.inboxPath)
  if (loaded.kind === 'failed') {
    deps.printError(loaded.message)
    return { kind: 'refused' }
  }
  const alias = await resolveSaveAlias(caller, args, target)
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

/** Revokes a key; its open questions end with their timeout answer. Its contact stays. */
export function runKeyRevoke(args: AdminIdArgs, deps: AdminDeps): Promise<number> {
  return runAdminCommand(deps, async () => {
    const caller = await openAdminCaller(deps)
    if (caller === undefined) {
      return 1
    }
    return printResult(await caller.revokeKey(args.id), args, deps, () => `Revoked key ${args.id}.`)
  })
}
