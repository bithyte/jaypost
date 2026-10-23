/** A button that publishes `body` to `url` when tapped; `clear` dismisses the notification on success. */
export type NtfyAction = {
  readonly action: 'http'
  readonly label: string
  readonly url: string
  readonly method: 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly clear: boolean
}

/**
 * A message to publish. A `sequenceId` lets a later publish replace it and `clear`/`remove` act on
 * it (ntfy 2.16 and later).
 */
export type NtfyMessage = {
  readonly topic: string
  readonly message: string
  readonly priority: number
  readonly sequenceId?: string
  readonly actions: readonly NtfyAction[]
}

/** What an access check found: allowed, refused with `status`, or no answer at all. */
export type NtfyAccess =
  | { readonly kind: 'ok' }
  | { readonly kind: 'rejected'; readonly status: number }
  | { readonly kind: 'unreachable' }

/** One message from the subscription stream; `title` is absent when it was published without one. */
export type NtfyIncoming = {
  readonly id: string
  readonly message: string
  readonly title: string | undefined
}

/** Stream callbacks; `fatal` means the server refused the subscription and it won't be retried. */
export type NtfyStreamEvents = {
  readonly message: (message: NtfyIncoming) => void
  readonly fatal: (message: string) => void
}

/** Where the client connects; `token` is sent as a bearer token when given. */
export type NtfyConnection = {
  readonly server: string
  readonly token: string | undefined
}

/**
 * Tests shorten the stream's stall and retry delays and fix the clock (epoch ms) the first
 * subscription starts from.
 */
export type NtfyClientOptions = {
  readonly stallMs?: number
  readonly firstRetryDelayMs?: number
  readonly maxRetryDelayMs?: number
  readonly now?: () => number
}

/**
 * The narrow seam over ntfy's HTTP API. `publish`, `clear` and `remove` reject on a failed
 * request; `checkAccess` never does. Nothing it rejects or reports contains the token.
 */
export type NtfyClient = {
  readonly publish: (message: NtfyMessage) => Promise<void>
  /** Marks a sequence read and dismisses its notification. */
  readonly clear: (topic: string, sequenceId: string) => Promise<void>
  /** Deletes a sequence's notification. */
  readonly remove: (topic: string, sequenceId: string) => Promise<void>
  readonly checkAccess: (topic: string) => Promise<NtfyAccess>
  /**
   * Streams messages published to `topic` from now on, reopening the stream when it drops and
   * resuming after the last message seen. Returns a function that ends it.
   */
  readonly subscribe: (topic: string, events: NtfyStreamEvents) => () => void
}

/** What `MessageReference` holds for ntfy; cast back at the runtime's edge. */
export type NtfyMessageReference = {
  readonly sequenceId: string
}
