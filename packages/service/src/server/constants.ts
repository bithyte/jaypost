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
