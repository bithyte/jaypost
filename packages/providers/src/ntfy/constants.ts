/** Server used when no `ntfyServer` is set. */
export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh'
/** Appended to the topic to name the topic that button taps and typed answers are published to. */
export const REPLY_TOPIC_SUFFIX = '-replies'
/** ntfy topic names; 56 characters at most so the reply topic stays within ntfy's 64. */
export const TOPIC_PATTERN = /^[-_A-Za-z0-9]{1,56}$/
/**
 * Shortest topic accepted without an access token: with no token the topic name is the only
 * thing keeping others from reading and answering questions.
 */
export const MIN_OPEN_TOPIC_LENGTH = 16
/** Most action buttons ntfy shows on one notification. */
export const NTFY_MAX_OPTION_COUNT = 3
/**
 * Most characters of request text. ntfy turns a message over 4096 bytes into an attachment; at up
 * to 3 UTF-8 bytes per UTF-16 unit this leaves room for the reply hint.
 */
export const NTFY_MAX_TEXT_LENGTH = 1200
/** Title a button tap is published with, which tells it apart from a typed answer. */
export const TAP_TITLE = 'jaypost-tap'
/** ntfy priorities: 4 high, 3 default, 2 low (no sound or vibration), 1 min. */
export const REQUEST_PRIORITY = 4
export const NOTIFICATION_PRIORITY = 3
export const QUIET_PRIORITY = 2
export const FINAL_PRIORITY = 1
/** How long one publish, clear, delete or access check waits for the server. */
export const REQUEST_TIMEOUT_MS = 10_000
/** ntfy sends a keepalive every 45 s; a stream silent for this long is reopened. */
export const STREAM_STALL_MS = 120_000
/** First wait before reopening a dropped stream; doubles up to `MAX_RETRY_DELAY_MS`. */
export const FIRST_RETRY_DELAY_MS = 1000
export const MAX_RETRY_DELAY_MS = 60_000
/** Sender id the conversation knows the topic's owner by; whoever can publish to it. */
export const NTFY_OWNER_ID = 'topic'
/** Answer to a typed message while several questions take one; ntfy can't reply to a message. */
export const AMBIGUOUS_TEXT_REPLY =
  "Several open questions take a typed answer, so this can't tell which one you meant. Answer the others with their buttons first."
/** Answer to a typed message when no question takes a typed answer. */
export const NO_TEXT_QUESTION_REPLY = 'No question is waiting for a typed answer.'
/** Fatal message for a token or topic the server refuses; never includes either. */
export const REJECTED_FATAL = 'ntfy refused access to the reply topic; check it with `jaypost init`'
