import type { MessageFormat } from '../format/index.ts'

/** Where `Client` finds the service, and the project name its messages carry by default. */
export type ClientOptions = {
  /** Default `127.0.0.1`. */
  readonly host?: string
  /** Default 8787. */
  readonly port?: number
  /** Shown as `[project]` on the first line of every message, unless a call sets its own. */
  readonly project?: string
  /**
   * Sent as a bearer token. Default: `JAYPOST_TOKEN`, else `~/.config/jaypost/token`,
   * looked up on every call. Throws a `RangeError` at construction if it isn't a valid token.
   */
  readonly token?: string
}

/**
 * One file sent along with a message: read from `path` (named by its basename unless `name` is
 * set), or given as `text` or `data` under a `name`. At most 10 MiB, and never empty.
 */
export type AttachmentInput =
  | { readonly path: string; readonly name?: string }
  | { readonly name: string; readonly text: string }
  | { readonly name: string; readonly data: Uint8Array }

/** An `AttachmentInput`, or a stream (the CLI's stdin) to read to the end. */
export type AttachmentSource =
  | AttachmentInput
  | {
      readonly stream: AsyncIterable<Uint8Array | string>
      readonly name: string
    }

/** The wire shape of an attachment: `data` is base64. */
export type AttachmentBody =
  | { readonly name: string; readonly text: string }
  | { readonly name: string; readonly data: string }

/** Outcome of `prepareAttachment`; `message` is ready to show the caller. */
export type AttachmentResult =
  | { readonly kind: 'ok'; readonly attachment: AttachmentBody }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * A question answered by buttons and/or a typed reply; `timeout` in seconds, default 300, max 86400 (24 h); longer values are
 * capped.
 */
export type AskRequest = {
  readonly text: string
  /** Button labels; required unless `allowText`. */
  readonly options?: readonly string[]
  /** Let the owner answer with a text reply. */
  readonly allowText?: boolean
  /** Answer returned on timeout; one of `options`, or with `allowText` any short answer. */
  readonly timeoutOption: string
  readonly timeout?: number
  readonly project?: string
  /** Default plain; markdown renders a subset, see the README. */
  readonly format?: MessageFormat
  /** One file sent with the question. Needs a service that supports attachments. */
  readonly attachment?: AttachmentInput
  /** Aborting it cancels the question; the Telegram message is edited to a "cancelled" line. */
  readonly signal?: AbortSignal
}

/** The tapped option or typed reply, or `timeoutOption` with `timedOut` set. */
export type Answer = { readonly answer: string; readonly timedOut: boolean }

/** A message that doesn't need an answer. */
export type Notification = {
  readonly text: string
  readonly project?: string
  /** Default plain; markdown renders a subset, see the README. */
  readonly format?: MessageFormat
  /** One file sent with the message. Needs a service that supports attachments. */
  readonly attachment?: AttachmentInput
  readonly signal?: AbortSignal
}

/** HTTP methods the clients use. */
export type ApiMethod = 'GET' | 'POST' | 'DELETE'

/** Service endpoints the clients call. */
export type ApiPath = '/request' | '/notify' | '/request/async' | '/status' | `/request/${string}`

/** Outcome of a call to the local service; `message` is ready to show the caller. */
export type ApiResult =
  | { readonly kind: 'ok'; readonly body: unknown }
  | { readonly kind: 'failed'; readonly message: string }

export type ApiOptions = {
  /** Aborting it makes the call fail with "cancelled". */
  readonly signal: AbortSignal
  readonly timeoutMs: number
  /** Default `127.0.0.1`. */
  readonly host?: string
  /** Sent as `authorization: Bearer <token>` when set. */
  readonly token?: string
}

/** The body of a /request call. */
export type AskBody = {
  readonly text: string
  readonly options?: readonly string[]
  readonly allowText?: boolean
  readonly timeoutOption: string
  readonly timeout?: number
  readonly project?: string
  readonly format?: MessageFormat
  readonly attachment?: AttachmentBody
}

/** `now` returns milliseconds; default `performance.now`. */
export type AskOptions = Omit<ApiOptions, 'timeoutMs'> & {
  readonly now?: () => number
}

/** Outcome of `requestApi`; `message` is ready to show the caller. */
export type AskResult =
  | { readonly kind: 'ok'; readonly outcome: Answer }
  | { readonly kind: 'failed'; readonly message: string }

/** The body of GET /request/<id>. */
export type StateBody =
  | {
      readonly id: string
      readonly state: 'pending'
      readonly expiresAt: string
    }
  | {
      readonly id: string
      readonly state: 'done'
      readonly answer: string
      readonly timedOut: boolean
    }
  | { readonly id: string; readonly state: 'cancelled' }
