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
