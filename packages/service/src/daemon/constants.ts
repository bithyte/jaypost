/** First delay before a failed bot is started again; it doubles after each failure. */
export const INITIAL_RETRY_DELAY_MS = 5_000

/** Longest delay between two attempts to start a failed bot. */
export const MAX_RETRY_DELAY_MS = 300_000

/** How long a bot must keep running before its retry delay starts over. */
export const STABLE_RUN_MS = 60_000
