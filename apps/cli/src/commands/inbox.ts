import { describeEndpoint } from '@jaypost/client'
import { findBot, removeInboxBot, renameBot, setDefaultBot, writeInbox } from '@jaypost/store'
import type { Inbox, InboxChange } from '@jaypost/store'
import { formatTable } from './admin.ts'
import { loadInbox } from './remote.ts'
import type { InboxDeps } from './types.ts'

/** Prints each bot's alias and service, marking the default with `*`; never a key. Returns the exit code. */
export function runInboxList(deps: InboxDeps): Promise<number> {
  const inbox = loadInbox(deps)
  if (inbox === undefined) {
    return Promise.resolve(1)
  }
  if (inbox.bots.length === 0) {
    deps.print('No bots. Run "jaypost service install" or "jaypost inbox join".')
    return Promise.resolve(0)
  }
  deps.print(
    formatTable(
      ['', 'ALIAS', 'SERVICE'],
      inbox.bots.map((bot) => [
        // A space, not '', because formatTable shows an empty cell as '-'.
        bot.alias === inbox.default ? '*' : ' ',
        bot.alias,
        describeEndpoint(new URL(bot.url)),
      ]),
    ),
  )
  return Promise.resolve(0)
}

/** Makes `alias` the default bot. Returns the exit code. */
export function runInboxDefault(
  args: { readonly alias: string },
  deps: InboxDeps,
): Promise<number> {
  return Promise.resolve(
    applyChange(
      deps,
      (inbox) => setDefaultBot(inbox, args.alias),
      (inbox) => {
        deps.print(`Default bot is now "${inbox.default}".`)
      },
    ),
  )
}

/** Renames a bot; the default follows it. Returns the exit code. */
export function runInboxRename(
  args: { readonly alias: string; readonly newAlias: string },
  deps: InboxDeps,
): Promise<number> {
  return Promise.resolve(
    applyChange(
      deps,
      (inbox) => renameBot(inbox, args.alias, args.newAlias),
      () => {
        deps.print(`Renamed "${args.alias}" to "${args.newAlias}".`)
      },
    ),
  )
}

/**
 * Removes a bot after a confirmation unless `yes`; declining leaves the inbox as it was. Removing
 * the default with others left asks which becomes the default on a terminal, and otherwise moves
 * it to the first remaining bot and says so. Returns the exit code.
 */
export async function runInboxRemove(
  args: { readonly alias: string; readonly yes?: boolean },
  deps: InboxDeps,
): Promise<number> {
  const inbox = loadInbox(deps)
  if (inbox === undefined) {
    return 1
  }
  const change = removeInboxBot(inbox, args.alias)
  if (change.kind === 'failed') {
    deps.printError(change.message)
    return 1
  }
  if (
    args.yes !== true &&
    !(await deps.prompt.confirm(`Remove "${args.alias}" from your inbox?`, false))
  ) {
    deps.printError('Cancelled.')
    return 1
  }
  const removed = findBot(inbox, args.alias)
  const wasDefault =
    removed !== undefined &&
    inbox.default !== undefined &&
    inbox.default.toLowerCase() === removed.alias.toLowerCase()
  const next =
    wasDefault && change.inbox.bots.length > 0
      ? await chooseDefault(change.inbox, deps)
      : change.inbox
  writeInbox(deps.inboxPath, next)
  deps.print(`Removed "${removed?.alias ?? args.alias}".`)
  if (wasDefault && next.default !== undefined) {
    deps.print(`Default bot is now "${next.default}".`)
  }
  return 0
}

// On a terminal the user picks the next default; otherwise removeBot's pick stands.
async function chooseDefault(inbox: Inbox, deps: InboxDeps): Promise<Inbox> {
  if (!deps.isInteractive || inbox.default === undefined) {
    return inbox
  }
  const alias = await deps.prompt.select(
    'Which bot is the new default?',
    inbox.bots.map((bot) => ({ value: bot.alias, label: bot.alias })),
    inbox.default,
  )
  const chosen = setDefaultBot(inbox, alias)
  return chosen.kind === 'changed' ? chosen.inbox : inbox
}

// Loads the inbox, applies one operation, writes it and reports; a failure prints and writes nothing.
function applyChange(
  deps: InboxDeps,
  change: (inbox: Inbox) => InboxChange,
  report: (inbox: Inbox) => void,
): number {
  const inbox = loadInbox(deps)
  if (inbox === undefined) {
    return 1
  }
  const result = change(inbox)
  if (result.kind === 'failed') {
    deps.printError(result.message)
    return 1
  }
  writeInbox(deps.inboxPath, result.inbox)
  report(result.inbox)
  return 0
}
