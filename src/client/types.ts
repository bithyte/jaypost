import type { ClientToken } from '../auth/index.ts'
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
  | Failure

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
  /** Aborting it cancels the question; the chat message is edited to a "cancelled" line. */
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
export type ApiResult = { readonly kind: 'ok'; readonly body: unknown } | Failure

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
export type AskResult = { readonly kind: 'ok'; readonly outcome: Answer } | Failure

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

export type CallerOptions = {
  readonly port: number
  /** Default `127.0.0.1`. */
  readonly host?: string
  /** Called once per operation, before any I/O; `unusable` fails that operation only. */
  readonly readToken: () => ClientToken
  /** Milliseconds; default `performance.now`. Drives the wait deadline and the too-old check. */
  readonly now?: () => number
}

/** Aborting `signal` ends the operation with reason `cancelled`. */
export type CallOptions = { readonly signal: AbortSignal }

/** `AskRequest` without the per-call bits; the attachment is read and checked before sending. */
export type Question = Omit<AskRequest, 'attachment' | 'signal'> & {
  readonly attachment?: AttachmentSource
}

export type Message = Omit<Notification, 'attachment' | 'signal'> & {
  readonly attachment?: AttachmentSource
}

/** `rejected` is a 400 with the daemon's own text; `attachment` is a local read or size failure. */
export type FailureReason =
  | 'unusableToken'
  | 'unreachable'
  | 'cancelled'
  | 'httpTimeout'
  | 'unauthorized'
  | 'rejected'
  | 'tooOld'
  | 'notSupported'
  | 'notPaired'
  | 'sendFailed'
  | 'unknownRequest'
  | 'unreadable'
  | 'attachment'
  | 'unexpected'

/** `message` is the copy shown today, ready for an agent or a terminal. */
export type Failure = {
  readonly kind: 'failed'
  readonly reason: FailureReason
  readonly message: string
}

export type Pending = { readonly kind: 'pending'; readonly id: string; readonly expiresAt: string }

export type Done = { readonly kind: 'done'; readonly answer: string; readonly timedOut: boolean }

export type QuestionState =
  | Pending
  | (Done & { readonly id: string })
  | { readonly kind: 'cancelled'; readonly id: string }
  | Failure
