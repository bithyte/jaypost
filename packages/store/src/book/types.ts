/** The local install: its service url and, when this machine administers it, the admin key. */
export type BookLocal = { readonly url: string; readonly adminKey?: string }

/** A hosted service the user administers. */
export type BookRemote = {
  readonly name: string
  readonly url: string
  readonly adminKey: string
}

/** A contact: an alias for one bot's service url and, when known, its key. */
export type BookBot = { readonly alias: string; readonly url: string; readonly key?: string }

/** The contents of `bots.json`. */
export type Book = {
  readonly version: 1
  readonly default?: string
  readonly local?: BookLocal
  readonly remotes: readonly BookRemote[]
  readonly bots: readonly BookBot[]
}

/** Result of an operation that can fail on user input. */
export type BookChange =
  | { readonly kind: 'changed'; readonly book: Book }
  | { readonly kind: 'failed'; readonly message: string }

/** What an invite carries: a service url and a bot key. */
export type Invite = { readonly url: string; readonly key: string }
