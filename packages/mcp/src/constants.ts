/** Matches whole-number JAYPOST_PORT env values. */
export const PORT_PATTERN = /^\d+$/
/** Highest valid TCP port. */
export const MAX_PORT = 65_535
/** Gap between progress notifications while a question waits. */
export const PROGRESS_INTERVAL_MS = 60_000
/** Text sent with each progress notification. */
export const PROGRESS_MESSAGE = 'waiting for the user'
/** How long the MCP server spends cancelling its open background questions on shutdown. */
export const CANCEL_TIMEOUT_MS = 2000
/** `wait_for_answer` text when `wait_seconds` ran out first. */
export const STILL_WAITING_TEXT = 'still waiting for the user'
/** `wait_for_answer` text for a cancelled question. */
export const CANCELLED_QUESTION_TEXT = 'the question was cancelled'
