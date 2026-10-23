/** A daily window in minutes after local midnight; wraps past midnight when start is after end. */
export type QuietHours = {
  readonly startMinute: number
  readonly endMinute: number
}

export type QuietHoursParseResult =
  | { readonly ok: true; readonly value: QuietHours }
  | { readonly ok: false; readonly error: string }

/** `value` is the duration in milliseconds. */
export type MuteDurationParseResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: string }

/** What silences notifications: a daily window, a one-off mute, or both. */
export type QuietState = {
  readonly quietHours?: QuietHours
  readonly mutedUntil?: Date
}

/** A config change to persist; `null` deletes the key. */
export type QuietPatch = {
  readonly quietHours?: string | null
  readonly mutedUntil?: string | null
}

export type QuietServiceOptions = {
  readonly quietHours?: QuietHours
  readonly mutedUntil?: Date
  readonly timeZone?: string
  readonly now?: () => Date
  readonly log?: (line: string) => void
}
