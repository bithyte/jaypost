/**
 * Request body cap; larger bodies get a 413. 14 MiB: the base64 of `MAX_ATTACHMENT_BYTES` is
 * 13_981_016 characters, plus room for the rest of the body.
 */
export const MAX_BODY_BYTES = 14_680_064

/** Paths of the form /request/:id, for the 405 Allow header. */
export const REQUEST_ID_PATH_PATTERN = /^\/request\/[^/]+$/

/** Body of the 404 for an id that was never created, expired or was lost to a restart. */
export const UNKNOWN_REQUEST_ERROR = 'unknown request'

/** Body of the 501 for a body with `attachment` when the provider can't send files. */
export const ATTACHMENTS_UNSUPPORTED_ERROR = 'attachments not supported'

/** Body of the 503 for a key whose bot isn't running. */
export const BOT_UNAVAILABLE_ERROR = 'bot unavailable'

/** Body of the 503 for a key whose pairing waits for its code. */
export const NOT_PAIRED_ERROR = 'not paired'

/** The bot id `createSingleBotRouter` names in its log lines. */
export const SINGLE_BOT_ID = 'b1'

/** The key and pairing `createSingleBotRouter` puts on every question. */
export const SINGLE_BOT_CALLER = { key: 'k1', pairing: 'p1' } as const

/** What /openapi.yaml shows with no bot stored: no attachments and Telegram's text limit. */
export const NO_BOT_LIMITS = { maxTextLength: 3900, maxAttachmentBytes: 0 } as const

/** Paths of GET-only routes, for the 405 Allow header. */
export const GET_ONLY_PATHS: readonly string[] = ['/status', '/openapi.yaml', '/log']

/** A GET /log `limit`: a positive integer. */
export const LOG_LIMIT_PATTERN = /^[1-9]\d{0,8}$/

/** The status an admin route answers for each kind of failure. */
export const ADMIN_FAILURE_STATUS = { invalid: 400, notFound: 404, duplicate: 409 } as const
