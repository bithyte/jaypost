import type {
  MessageEnding,
  OwnerCommand,
  RequestResult,
  RequestState,
  RoundEnd,
  Settlement,
  VoteResult,
  VoteRule,
} from './types.ts'

/** Timeout when the client sends none, in seconds. */
export const DEFAULT_TIMEOUT_SECONDS = 300
/** Hard cap on a request's timeout, in seconds (24 h); longer values are clamped. */
export const MAX_TIMEOUT_SECONDS = 86_400
/** Longest a single wait for a result may block, in seconds. */
export const MAX_WAIT_SECONDS = 120
/** How long a settled result is kept for later retrieval, in milliseconds (24 h). */
export const RESULT_TTL_MS = 24 * 60 * 60 * 1000
/** Longest allowed option label, in characters. */
export const MAX_OPTION_LENGTH = 64
/** Longest allowed project name, in characters. */
export const MAX_PROJECT_LENGTH = 100
/** Largest attachment accepted by the API, in decoded bytes (10 MiB). */
export const MAX_ATTACHMENT_BYTES = 10_485_760
/** Longest allowed attachment file name, in characters. */
export const MAX_ATTACHMENT_NAME_LENGTH = 255
/** Characters a file name must not contain: path separators and control characters. */
// eslint-disable-next-line no-control-regex -- control characters are the point
export const ATTACHMENT_NAME_FORBIDDEN_PATTERN = /[\u0000-\u001f\u007f/\\]/
/**
 * Characters of standard base64 with up to two trailing `=`; flat on purpose, since a grouped
 * pattern overflows the stack on megabytes of input. Length and padding are checked in the parser.
 */
export const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/
/** Whitespace removed from base64 before validation (line wrapping). */
export const ASCII_WHITESPACE_PATTERN = /[\t\n\f\r ]+/g
/** Shared settlement for a request cancelled before an answer. */
export const CANCELLED_SETTLEMENT = { kind: 'cancelled' } as const satisfies Settlement
/** Ending for a request message whose service restarted before it was answered. */
export const EXPIRED_ENDING = { kind: 'expired' } as const satisfies MessageEnding
/** Ending for a request message whose question was asked again after a timeout. */
export const REASKED_ENDING = { kind: 'reasked' } as const satisfies MessageEnding
/** Shared result for `ApprovalService.request` when its signal aborted. */
export const CANCELLED_RESULT = { kind: 'cancelled' } as const satisfies RequestResult
/** Shared result for `runVote` when its signal aborted. */
export const CANCELLED_VOTE = { kind: 'cancelled' } as const satisfies VoteResult
/** A vote round that ended with a message cancelled. */
export const CANCELLED_ROUND = { kind: 'cancelled' } as const satisfies RoundEnd
/** A vote round whose open messages all timed out undecided. */
export const TIMED_OUT_ROUND = { kind: 'timedOut' } as const satisfies RoundEnd
/** Shared state for a background question that was cancelled. */
export const CANCELLED_STATE = { kind: 'cancelled' } as const satisfies RequestState
/** How many settled requests the service remembers; the oldest drop first. */
export const HISTORY_LIMIT = 20
/** Longest request summary in a command reply, in UTF-16 code units. */
export const SUMMARY_MAX_LENGTH = 80
/** Longest typed answer in a result line, in UTF-16 code units; keeps the final text under 4096. */
export const MAX_REPLY_ANSWER_LENGTH = 180
/** How many history entries `/history` shows without an argument. */
export const DEFAULT_HISTORY_COUNT = 10
/** The commands the owner can send, in menu order. */
export const OWNER_COMMANDS: readonly OwnerCommand[] = [
  { name: 'pending', description: 'List open requests' },
  { name: 'cancel', description: 'Reject all open requests with their timeout answers' },
  { name: 'history', description: 'Show recent answers' },
]
/** The vote rules the CLI accepts for `--require` and /vote for `require`. */
export const VOTE_RULES = ['all', 'majority'] as const satisfies readonly VoteRule[]
/** Most re-asks `send request --retry` and the API's `retry` accept. */
export const MAX_RETRY_COUNT = 100
/** Most voters a /vote body may list. */
export const MAX_VOTER_COUNT = 25
