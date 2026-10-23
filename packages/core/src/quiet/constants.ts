import type { OwnerCommand } from '../approval/index.ts'

/** Mute length when `/mute` has no argument: 1 hour. */
export const DEFAULT_MUTE_MS = 3_600_000

/** Longest accepted mute, inclusive: 7 days. */
export const MAX_MUTE_MS = 604_800_000

/** `H`, `HH`, `H:MM` or `HH:MM`, a dash, then the same; matched against trimmed input. */
export const QUIET_HOURS_PATTERN = /^(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?$/

/** Days, hours, minutes in that order; matched against lowercased input without whitespace. */
export const MUTE_DURATION_PATTERN = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/

export const MINUTES_PER_DAY = 1440

export const MINUTE_MS = 60_000

/** A chain of window, mute, window is the longest because a mute only ends once. */
export const MAX_QUIET_JUMPS = 3

/** Menu entries for the quiet commands, in display order. */
export const QUIET_COMMANDS: readonly OwnerCommand[] = [
  { name: 'mute', description: 'Silence notifications for a while (default 1h)' },
  { name: 'unmute', description: 'End the mute early' },
  { name: 'quiet', description: 'Show or set quiet hours' },
]
