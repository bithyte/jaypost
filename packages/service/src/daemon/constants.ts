/** First delay before a failed bot is started again; it doubles after each failure. */
export const INITIAL_RETRY_DELAY_MS = 5_000

/** Longest delay between two attempts to start a failed bot. */
export const MAX_RETRY_DELAY_MS = 300_000
