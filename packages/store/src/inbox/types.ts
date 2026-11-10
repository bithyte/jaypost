/** The local install: its service url and, when this machine administers it, the admin key. */
export type InboxLocal = { readonly url: string; readonly adminKey?: string }

/** A hosted service the user administers. */
export type InboxRemote = {
  readonly name: string
  readonly url: string
  readonly adminKey: string
}

/** A bot in the inbox: an alias for one bot's service url and, when known, its key. */
export type InboxBot = { readonly alias: string; readonly url: string; readonly key?: string }

/** The contents of `inbox.json`. */
export type Inbox = {
  readonly version: 1
  readonly default?: string
  readonly local?: InboxLocal
  readonly remotes: readonly InboxRemote[]
  readonly bots: readonly InboxBot[]
}

/** Result of an operation that can fail on user input. */
export type InboxChange =
  | { readonly kind: 'changed'; readonly inbox: Inbox }
  | { readonly kind: 'failed'; readonly message: string }

/** What an invite carries: a service url and a bot key. */
export type Invite = { readonly url: string; readonly key: string }
