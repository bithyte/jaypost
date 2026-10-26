/** How long a notification stays before it's deleted: 8 hours. */
export const NOTIFICATION_TTL_MS = 28_800_000

/** The largest delay `setTimeout` accepts; larger values overflow and fire immediately. */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

/**
 * The longest a notification may live after it's sent: 47 hours. Telegram won't let a bot delete a
 * message older than 48 hours, so leave an hour of margin; past this a quiet notification stays
 * until dismissed.
 */
export const MAX_NOTIFICATION_TTL_MS = 169_200_000

/** Client-facing error for a `deleteAfter` that is neither seconds nor a zoned ISO 8601 timestamp. */
export const DELETE_AFTER_ERROR =
  'deleteAfter must be a positive number of seconds or an ISO 8601 timestamp with a timezone'

/** Client-facing error for a `deleteAfter` timestamp that is already past. */
export const DELETE_AFTER_PAST_ERROR = 'deleteAfter is in the past'

/** A string `deleteAfter` that is plain seconds, e.g. `300` or `1.5`. */
export const SECONDS_PATTERN = /^\d+(\.\d+)?$/

/** A string `deleteAfter` that is an ISO 8601 timestamp with `Z` or an offset. */
export const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/
