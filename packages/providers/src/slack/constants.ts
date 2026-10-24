/** Slack's Web API root; the client appends the method name. */
export const SLACK_API_ROOT = 'https://slack.com/api'
/** How long `validateTokens` waits for Slack before giving up. */
export const TOKEN_CHECK_TIMEOUT_MS = 10_000
/** How long each Web API request may take at runtime. */
export const REQUEST_TIMEOUT_MS = 30_000
/** Longest wait a rate-limited request honours before retrying once. */
export const MAX_RETRY_AFTER_MS = 30_000
/** First and longest wait between Socket Mode reconnects; doubles from the first to the longest. */
export const RECONNECT_DELAYS_MS = { first: 1000, longest: 30_000 } as const
/** How many delivered event ids the client remembers to drop Slack's retries. */
export const SEEN_EVENT_LIMIT = 200
/** Most buttons in one Block Kit actions block, which is also the most options a request can have. */
export const SLACK_MAX_OPTION_COUNT = 25
/** Longest button label Slack accepts (plain_text in a button). */
export const BUTTON_LABEL_LIMIT = 75
/** Ellipsis that ends a shortened button label. */
export const ELLIPSIS = '…'
/** Most characters of request text; well under the 4000 Slack advises for one message. */
export const SLACK_MAX_TEXT_LENGTH = 3000
/** Longest notification fallback `text`, which Slack shows in push notifications. */
export const FALLBACK_TEXT_LIMIT = 4000
/** Largest attachment jaypost uploads to Slack (10 MiB, like the other providers). */
export const SLACK_MAX_ATTACHMENT_BYTES = 10_485_760
/** A Slack user id: `U` or `W` then letters and digits. */
export const USER_ID_PATTERN = /^[UW][A-Z0-9]{2,}$/
/** A bare link; turned into a link element so Slack makes it clickable. */
export const URL_PATTERN = /https?:\/\/[^\s<>]+/g
/** `<target|label>` or `<target>` in incoming mrkdwn: links, mentions and channel references. */
export const MRKDWN_REFERENCE_PATTERN = /<([^<>|]+)(?:\|([^<>]*))?>/g
/** Bot scopes the app manifest grants; a token missing one is reported by name at init. */
export const REQUIRED_SCOPES: readonly string[] = [
  'chat:write',
  'commands',
  'files:write',
  'im:history',
  'im:write',
  'users:read',
]
/** Web API errors that mean the bot token stopped working for good. */
export const FATAL_API_ERRORS: readonly string[] = [
  'invalid_auth',
  'not_authed',
  'account_inactive',
  'token_revoked',
  'token_expired',
]
/** The first whitespace character, which ends the command name in slash command text. */
export const WHITESPACE_PATTERN = /\s/
/** The one slash command the manifest defines; owner commands are its first word. */
export const SLASH_COMMAND = '/jaypost'
/** Answer to the slash command from anyone but the owner. */
export const NOT_OWNER_COMMAND_REPLY = "This app isn't paired with you."
/** Fatal message for a bot token Slack refuses; never includes the token. */
export const REJECTED_BOT_TOKEN_FATAL = 'Slack rejected the bot token; check it with `jaypost init`'
/** Fatal message for an app-level token Slack refuses; never includes the token. */
export const REJECTED_APP_TOKEN_FATAL =
  'Slack rejected the app-level token; check it with `jaypost init`'
/** Fatal message when Socket Mode was turned off in the app's settings. */
export const SOCKET_MODE_DISABLED_FATAL =
  'Socket Mode was turned off for the Slack app; turn it back on in the app settings'
