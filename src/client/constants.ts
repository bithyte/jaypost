/** The service listens on loopback by default. */
export const HOST = '127.0.0.1'
/** Shown when `JAYPOST_URL` isn't a usable service URL; never repeats the value. */
export const INVALID_URL_MESSAGE =
  'JAYPOST_URL must be an http or https URL without credentials, query or fragment'
/** Fixed copy for failures, shown to agents and scripts as is. */
export const CANCELLED_MESSAGE = 'cancelled'
export const TOO_OLD_MESSAGE =
  'jaypost service is too old for notifications (run jaypost init to upgrade)'
export const NOT_SUPPORTED_MESSAGE = 'notifications not supported by this provider'
export const NOT_PAIRED_MESSAGE = "jaypost isn't paired yet (run jaypost status)"
export const SEND_FAILED_MESSAGE = "couldn't send the message to the user"
/** Extra time the HTTP call gets beyond the approval timeout, so the service answers first. */
export const FETCH_GRACE_MS = 30_000
/** Shown when the service answers 401 and no token was sent. */
export const TOKEN_REQUIRED_MESSAGE =
  'jaypost service needs a token; set JAYPOST_TOKEN to the contents of ~/.config/jaypost/token on the host'
/** Shown when the service answers 401 to a token that was sent. */
export const TOKEN_REJECTED_MESSAGE =
  'jaypost service rejected the token; check JAYPOST_TOKEN, or re-run jaypost init if the token file changed'
/** Services before long timeouts capped /request at this many seconds. */
export const LEGACY_MAX_TIMEOUT_SECONDS = 300
/** Shown when a long /request timed out early, which only a service without long timeouts does. */
export const TIMEOUT_TOO_OLD_MESSAGE =
  'jaypost service is too old for timeouts over 300 s (run jaypost init to upgrade)'
/** Shown when the service has no /request/async. */
export const BACKGROUND_TOO_OLD_MESSAGE =
  'jaypost service is too old for background questions (run jaypost init to upgrade)'
/** Shown when a question with `retry` timed out without the service saying it re-asked. */
export const RETRY_TOO_OLD_MESSAGE =
  'jaypost service is too old to re-ask after a timeout (run jaypost init to upgrade)'
/** Shown when the service has no /vote. */
export const VOTE_TOO_OLD_MESSAGE =
  'jaypost service is too old for votes (run jaypost init to upgrade)'
/** Extra time a call with an attachment gets, for the upload and the service's send. */
export const ATTACHMENT_GRACE_MS = 120_000
/** Name for an attachment with no name of its own, such as text piped to the CLI. */
export const DEFAULT_ATTACHMENT_NAME = 'attachment.txt'
/** Shown when the service's /status doesn't report an attachment limit. */
export const ATTACHMENT_TOO_OLD_MESSAGE =
  'jaypost service is too old for attachments (run jaypost init to upgrade)'
/** Shown when the provider can't send attachments. */
export const ATTACHMENT_NOT_SUPPORTED_MESSAGE = 'attachments not supported by this provider'
