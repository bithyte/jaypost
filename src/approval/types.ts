import type { FormattedText } from '../format/index.ts'
import type { RequestRecord } from '../state/index.ts'

/** A file sent along with a message; `content` is never empty and `name` is a safe file name. */
export type Attachment = {
  readonly name: string
  readonly content: Uint8Array
}

/**
 * As produced by `parseApprovalRequest`: timeout is clamped; without `allowText`, `timeoutOption`
 * is in `options`.
 */
export type ApprovalRequest = {
  /** The message sent to the chat: the question, with a `[project]` line first when there is a project. */
  readonly message: FormattedText
  /** The question as the caller sent it, without the `[project]` prefix; markdown source unrendered. */
  readonly question: string
  /** Trimmed project name; omitted when the caller sent none. */
  readonly project?: string
  readonly allowText: boolean
  readonly options: readonly string[]
  readonly timeoutOption: string
  readonly timeoutSeconds: number
  /** The decoded file to send with the question; `undefined` when the caller sent none. */
  readonly attachment: Attachment | undefined
  /** User id to send to; omitted means the owner. Never set by `parseApprovalRequest`. */
  readonly recipient?: string
  /**
   * On timeout the message is finalized as `reasked` instead of `timedOut`; the result is still
   * `timedOut: true`. Never set by `parseApprovalRequest`.
   */
  readonly reaskOnTimeout?: boolean
}

/**
 * An `ApprovalRequest` once sent, without the attachment so a long wait doesn't keep its bytes.
 */
export type SentRequest = Omit<ApprovalRequest, 'attachment'>

/** The answer sent back to the HTTP client. */
export type Outcome = {
  readonly answer: string
  readonly timedOut: boolean
}

/** What `ApprovalService.request` resolves to; `cancelled` when its signal aborted. */
export type RequestResult =
  | { readonly kind: 'completed'; readonly outcome: Outcome }
  | { readonly kind: 'cancelled' }

/**
 * How a pending request ended; `answer` is the tapped option, the typed reply, or the timeout option
 * for `timedOut` and `rejected`.
 */
export type Settlement =
  | { readonly kind: 'answered'; readonly answer: string }
  | { readonly kind: 'timedOut'; readonly answer: string }
  | { readonly kind: 'rejected'; readonly answer: string }
  | { readonly kind: 'replied'; readonly answer: string }
  | { readonly kind: 'cancelled' }
  /** A vote was decided without this voter; `answer` is the vote's answer. */
  | { readonly kind: 'closed'; readonly answer: string }

/**
 * How a request message ends; `expired` is only used by startup recovery, never by `PendingRequests`,
 * and `reasked` replaces `timedOut` for a request that is asked again.
 */
export type MessageEnding = Settlement | { readonly kind: 'expired' } | { readonly kind: 'reasked' }

/**
 * State of a background question as `ApprovalService.get` reports it; `done` covers a tap, the
 * timeout and the owner's /cancel, with `timedOut` telling the timeout apart.
 */
export type RequestState =
  | { readonly kind: 'pending'; readonly expiresAt: Date }
  | { readonly kind: 'done'; readonly outcome: Outcome }
  | { readonly kind: 'cancelled' }

/** What `ApprovalService.send` resolves to once the message is sent; `result` settles later. */
export type SentQuestion = {
  readonly id: string
  readonly result: Promise<RequestResult>
}

/** What `ApprovalService.start` resolves to; `expiresAt` is when the timeout fires. */
export type StartedRequest = {
  readonly id: string
  readonly expiresAt: Date
}

/** Outcome of validating a `wait` query value; `error` is the client-facing message. */
export type WaitParseResult =
  | { readonly ok: true; readonly seconds: number }
  | { readonly ok: false; readonly error: string }

/** Outcome of validating a request body; `error` is the client-facing message. */
export type ParseResult =
  | { readonly ok: true; readonly value: ApprovalRequest }
  | { readonly ok: false; readonly error: string }

/**
 * Opaque handle to a sent message; the core only hands it back to the messenger. Must be
 * JSON-serializable, since references are saved to the state file.
 */
export type MessageReference = unknown

/** Chat transport the service uses, so the approval logic stays independent of any provider. */
export type Messenger = {
  /** The returned reference must be JSON-serializable (it's saved to the state file). */
  readonly sendRequest: (
    id: string,
    message: FormattedText,
    options: readonly string[],
    /** The owner may answer with a text reply. */
    allowText: boolean,
    /** The file to send with the message; `undefined` when there is none. */
    attachment: Attachment | undefined,
    /** The user id to send to; `undefined` means the owner. */
    recipient: string | undefined,
  ) => Promise<MessageReference>
  /** Request ended: show the final text and stop accepting answers. Absent means skipped. */
  readonly finalize?: (
    reference: MessageReference,
    message: FormattedText,
    ending: MessageEnding,
  ) => Promise<void>
}

/** Where in-flight requests are saved so a restart can expire them; calls must not throw. */
export type RequestStore = {
  readonly addRequest: (record: RequestRecord) => void
  readonly removeRequest: (id: string) => void
}

/** Optional collaborators of `ApprovalService`. */
export type ApprovalServiceOptions = {
  readonly store?: RequestStore
  readonly audit?: AuditSink
}

/** Records what happened to each request; implementations must not throw. */
export type AuditSink = {
  readonly asked: (id: string, request: SentRequest, at: Date) => void
  /** `ending` is a `Settlement`, or `expired` from startup recovery. */
  readonly settled: (id: string, ending: MessageEnding, at: Date) => void
}

/** A pending request with its timeout timer and the resolver that settles it. */
export type PendingEntry = {
  readonly request: SentRequest
  readonly openedAt: Date
  readonly timer: ReturnType<typeof setTimeout>
  readonly resolve: (settlement: Settlement) => void
}

/** A sent request now waiting in `PendingRequests`; `settlement` resolves once it settles. */
export type OpenedRequest = {
  readonly id: string
  readonly request: SentRequest
  readonly reference: MessageReference
  readonly openedAt: Date
  readonly settlement: Promise<Settlement>
}

/**
 * A background question's current state; `settled` resolves with the final state as soon as it is
 * recorded, before the final edit.
 */
export type BackgroundEntry = {
  readonly state: RequestState
  readonly settled: Promise<RequestState>
}

/** A settled request as kept in the service's in-memory history; `text` is the rendered text. */
export type HistoryEntry = {
  readonly text: string
  readonly settlement: Settlement
  readonly settledAt: Date
}

/** An open request as listed to the owner, oldest first. */
export type PendingSummary = {
  readonly id: string
  readonly request: SentRequest
  readonly openedAt: Date
}

/** A command the owner can send to the bot; `description` is its menu text. */
export type OwnerCommand = {
  readonly name: 'pending' | 'cancel' | 'history' | 'mute' | 'unmute' | 'quiet'
  readonly description: string
}

/** Inputs `runOwnerCommand` can't get from the service: the clock and the reply length limit. */
export type OwnerCommandOptions = {
  readonly now: () => Date
  readonly maxTextLength: number
}

/** How a vote is decided: `all` voters must approve, or `majority` of all listed voters. */
export type VoteRule = 'all' | 'majority'

/** Tally of a vote; voters who haven't answered are in neither count. */
export type VoteCounts = {
  readonly voterCount: number
  readonly approveCount: number
  readonly rejectCount: number
}

export type VoteDecision = 'approved' | 'rejected' | 'undecided'

/**
 * A vote over a two-way question: `request.options` is `[approve, reject]` and
 * `request.timeoutOption` is the reject answer. `voters` is non-empty and duplicate-free.
 */
export type Vote = {
  readonly request: ApprovalRequest
  readonly voters: readonly string[]
  readonly rule: VoteRule
  /** Rounds after the first; only voters who haven't voted are asked again. */
  readonly retryCount: number
}

/** One voter's answer; `undefined` when they never voted. */
export type VoterAnswer = {
  readonly voter: string
  readonly answer: string | undefined
}

/**
 * What `runVote` resolves to; `cancelled` when its signal aborted. `votes` is in `voters` order and
 * `timedOut` means the rounds ran out, which always rejects.
 */
export type VoteResult =
  | {
      readonly kind: 'decided'
      readonly approved: boolean
      readonly answer: string
      readonly votes: readonly VoterAnswer[]
      readonly roundCount: number
      readonly timedOut: boolean
    }
  | { readonly kind: 'cancelled' }

/** How one round of a vote ended; `timedOut` means every open message timed out undecided. */
export type RoundEnd =
  | { readonly kind: 'decided'; readonly approved: boolean }
  | { readonly kind: 'timedOut' }
  | { readonly kind: 'cancelled' }

/** A vote message sent to `voter` in the current round. */
export type VoterQuestion = SentQuestion & { readonly voter: string }
