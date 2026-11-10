import { AdminCaller, describeEndpoint } from '@jaypost/client'
import {
  parseToken,
  readInbox,
  removeRemote,
  saveRemote,
  toServiceUrl,
  writeInbox,
} from '@jaypost/store'
import type { Inbox } from '@jaypost/store'
import { formatTable } from './admin.ts'
import type { InboxDeps } from './types.ts'

/** What `remote add` takes; `adminKey` is checked against the service and never printed. */
type RemoteAddArgs = {
  readonly name: string
  readonly url: string
  readonly adminKey: string
}

/**
 * Checks the admin key against the service, then saves the remote. Nothing is saved when the url
 * or key is bad or the service refuses or can't be reached. An existing name is replaced after a
 * confirmation on a terminal and is an error otherwise. Returns the exit code; no message holds
 * the key.
 */
export async function runRemoteAdd(
  args: RemoteAddArgs,
  deps: InboxDeps & { readonly fetchTimeoutMs?: number },
): Promise<number> {
  const serviceUrl = toServiceUrl(args.url)
  if (serviceUrl === undefined) {
    deps.printError(`"${args.url}" isn't an http or https URL`)
    return 1
  }
  const adminKey = parseToken(args.adminKey)
  if (adminKey === undefined) {
    deps.printError("that isn't a valid admin key")
    return 1
  }
  const inbox = loadInbox(deps)
  if (inbox === undefined) {
    return 1
  }
  // By name only, as saveRemote matches; findRemote would also match another remote's host.
  if (inbox.remotes.some((remote) => remote.name.toLowerCase() === args.name.toLowerCase())) {
    if (!deps.isInteractive) {
      deps.printError(`a remote is already named "${args.name}"`)
      return 1
    }
    if (!(await deps.prompt.confirm(`Replace remote "${args.name}"?`, false))) {
      deps.printError('Cancelled.')
      return 1
    }
  }
  const url = new URL(serviceUrl)
  const caller = new AdminCaller({
    endpoint: { kind: 'url', url },
    adminKey,
    ...(deps.fetchTimeoutMs === undefined ? {} : { fetchTimeoutMs: deps.fetchTimeoutMs }),
  })
  const checked = await caller.listBots()
  if (checked.kind === 'failed') {
    deps.printError(checked.message)
    return 1
  }
  writeInbox(deps.inboxPath, saveRemote(inbox, { name: args.name, url: serviceUrl, adminKey }))
  deps.print(`Added remote "${args.name}" (${describeEndpoint(url)}).`)
  return 0
}

/** Drops a remote; bots on its url stay. Returns the exit code. */
export function runRemoteRemove(args: { readonly name: string }, deps: InboxDeps): Promise<number> {
  const inbox = loadInbox(deps)
  if (inbox === undefined) {
    return Promise.resolve(1)
  }
  const change = removeRemote(inbox, args.name)
  if (change.kind === 'failed') {
    deps.printError(change.message)
    return Promise.resolve(1)
  }
  writeInbox(deps.inboxPath, change.inbox)
  deps.print(`Removed remote "${args.name}".`)
  return Promise.resolve(0)
}

/** Prints each remote's name and url, never its admin key. Returns the exit code. */
export function runRemoteList(deps: InboxDeps): Promise<number> {
  const inbox = loadInbox(deps)
  if (inbox === undefined) {
    return Promise.resolve(1)
  }
  if (inbox.remotes.length === 0) {
    deps.print('No remotes.')
    return Promise.resolve(0)
  }
  deps.print(
    formatTable(
      ['NAME', 'URL'],
      inbox.remotes.map((remote) => [remote.name, remote.url]),
    ),
  )
  return Promise.resolve(0)
}

// A corrupt inbox is reported, not thrown; its message names the file, never a value.
export function loadInbox(deps: InboxDeps): Inbox | undefined {
  try {
    return readInbox(deps.inboxPath)
  } catch (error) {
    deps.printError(error instanceof Error ? error.message : String(error))
    return undefined
  }
}
