import { MAX_MUTE_MS, MINUTE_MS, MUTE_DURATION_PATTERN, QUIET_HOURS_PATTERN } from './constants.ts'
import type { MuteDurationParseResult, QuietHours, QuietHoursParseResult } from './types.ts'

const FORMAT_ERROR = 'expected HH:MM-HH:MM'

/** Parses `HH:MM-HH:MM` (minutes and leading zeros optional); never throws. */
export function parseQuietHours(raw: string): QuietHoursParseResult {
  const match = QUIET_HOURS_PATTERN.exec(raw.trim())
  if (match === null) {
    return { ok: false, error: FORMAT_ERROR }
  }
  const startMinute = toMinute(match[1], match[2])
  const endMinute = toMinute(match[3], match[4])
  if (startMinute === undefined || endMinute === undefined) {
    return { ok: false, error: FORMAT_ERROR }
  }
  if (startMinute === endMinute) {
    return { ok: false, error: 'start and end are the same' }
  }
  return { ok: true, value: { startMinute, endMinute } }
}

/** Normalizes to `HH:MM-HH:MM`. */
export function formatQuietHours(hours: QuietHours): string {
  return `${formatMinute(hours.startMinute)}-${formatMinute(hours.endMinute)}`
}

/** Parses `1d12h30m` style durations (1 ms to 7 days) into milliseconds; never throws. */
export function parseMuteDuration(raw: string): MuteDurationParseResult {
  const compact = raw.toLowerCase().replace(/\s+/g, '')
  const match = compact === '' ? null : MUTE_DURATION_PATTERN.exec(compact)
  if (match === null) {
    return { ok: false, error: 'expected a duration like 30m, 2h or 1d12h' }
  }
  const days = Number(match[1] ?? 0)
  const hours = Number(match[2] ?? 0)
  const minutes = Number(match[3] ?? 0)
  const value = ((days * 24 + hours) * 60 + minutes) * MINUTE_MS
  if (value <= 0) {
    return { ok: false, error: 'duration must be more than zero' }
  }
  if (value > MAX_MUTE_MS) {
    return { ok: false, error: 'duration must be at most 7d' }
  }
  return { ok: true, value }
}

function toMinute(
  hourText: string | undefined,
  minuteText: string | undefined,
): number | undefined {
  const hour = Number(hourText)
  const minute = Number(minuteText ?? 0)
  if (hour > 23 || minute > 59) {
    return undefined
  }
  return hour * 60 + minute
}

function formatMinute(minuteOfDay: number): string {
  const hour = String(Math.floor(minuteOfDay / 60)).padStart(2, '0')
  const minute = String(minuteOfDay % 60).padStart(2, '0')
  return `${hour}:${minute}`
}
