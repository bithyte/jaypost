import { describeEndpoint } from '@jaypost/client'
import { decodeInvite, findBot, saveBot, writeInbox } from '@jaypost/store'
import type { Progress } from '../progress/index.ts'
import { loadInbox } from './remote.ts'
import type { InboxDeps, FetchStatus, WaitForPairing } from './types.ts'

/** What `join` takes; `as` is the alias to save under instead of the bot's name. */
type JoinArgs = { readonly invite: string; readonly as?: string }

/** Everything `runJoin` touches outside itself, injected for tests. */
export type JoinDeps = InboxDeps & {
  readonly fetchStatus: FetchStatus
  readonly wait: WaitForPairing
  readonly progress: Progress
  readonly signal?: AbortSignal
}

const INTERRUPTED_CODE = 130

const INVALID_INVITE_MESSAGE = "that isn't a valid invite; ask for a new one"

const REJECTED_KEY_MESSAGE = 'the service rejected the key in this invite'

const STOPPED_MESSAGE = 'the service stopped answering; the key works once you send the code'

/**
 * Saves the bot an invite names after the service accepts its key. Nothing is saved when the
 * invite is bad, the inbox is corrupt, the service refuses or can't be reached, or a taken alias
 * isn't replaced. When the bot isn't paired yet, waits for the pairing code to be used; Ctrl-C
 * then keeps the saved entry and returns 130. Returns the exit code; no message holds the key or
 * the invite.
 */
export async function runJoin(args: JoinArgs, deps: JoinDeps): Promise<number> {
  const invite = decodeInvite(args.invite)
  if (invite === undefined) {
    deps.printError(INVALID_INVITE_MESSAGE)
    return 1
  }
  const inbox = loadInbox(deps)
  if (inbox === undefined) {
    return 1
  }
  const url = new URL(invite.url)
  const fetched = await deps.fetchStatus(url, invite.key)
  if (fetched.kind === 'unauthorized') {
    deps.printError(REJECTED_KEY_MESSAGE)
    return 1
  }
  if (fetched.kind === 'unreachable') {
    deps.printError(`couldn't reach ${describeEndpoint(url)}`)
    return 1
  }
  const alias = args.as ?? fetched.status.displayName?.replace(/^@/, '') ?? url.host
  if (findBot(inbox, alias) !== undefined) {
    if (!deps.isInteractive) {
      deps.printError(
        `a bot is already named "${alias}"; pass --as <alias> to save it under another name`,
      )
      return 1
    }
    if (!(await deps.prompt.confirm(`Replace "${alias}" in your inbox?`, false))) {
      deps.printError('Cancelled.')
      return 1
    }
  }
  const isFirst = inbox.bots.length === 0
  const saved = saveBot(inbox, { alias, url: invite.url, key: invite.key })
  writeInbox(deps.inboxPath, saved)
  deps.print(
    `Added ${alias} (${describeEndpoint(url)}) to your inbox${isFirst ? ', set as default.' : '.'}`,
  )
  const tryLine = saved.default === alias ? 'Try: jaypost ping' : `Try: jaypost ping -b ${alias}`
  if (fetched.status.paired) {
    deps.print(tryLine)
    return 0
  }
  const result = await deps.wait({
    url,
    token: invite.key,
    isRunning: async () => true,
    logsHint: '',
    progress: deps.progress,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  })
  switch (result) {
    case 'paired':
      deps.print(tryLine)
      return 0
    case 'interrupted':
      return INTERRUPTED_CODE
    case 'unauthorized':
      deps.printError(REJECTED_KEY_MESSAGE)
      return 1
    case 'notStarted':
    case 'stopped':
      deps.printError(STOPPED_MESSAGE)
      return 1
  }
}
