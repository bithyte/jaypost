import { MAX_QUIET_JUMPS, MINUTE_MS, MINUTES_PER_DAY } from './constants.ts'
import type { QuietHours, QuietState } from './types.ts'

type LocalParts = {
  readonly date: string
  readonly weekday: string
  readonly minuteOfDay: number
}

/** True when `at` falls in the window in `timeZone`; start is inclusive, end exclusive. */
export function isInQuietHours(hours: QuietHours, at: Date, timeZone: string): boolean {
  return containsMinute(hours, readLocalParts(at, timeZone).minuteOfDay)
}

/**
 * When the current quiet stretch ends, chaining windows and mutes that touch; undefined when
 * not quiet at `at`.
 */
export function findQuietEnd(state: QuietState, at: Date, timeZone: string): Date | undefined {
  let cursor = at
  // See MAX_QUIET_JUMPS: window, mute, window is the longest chain.
  for (let jump = 0; jump < MAX_QUIET_JUMPS; jump += 1) {
    const next = findNextBoundary(state, cursor, timeZone)
    if (next === undefined) {
      break
    }
    cursor = next
  }
  return cursor === at ? undefined : cursor
}

/** `HH:MM` when `at` is on `now`'s local date, else a short weekday and time like `Thu 14:30`. */
export function formatClock(at: Date, now: Date, timeZone: string): string {
  const local = readLocalParts(at, timeZone)
  const hour = String(Math.floor(local.minuteOfDay / 60)).padStart(2, '0')
  const minute = String(local.minuteOfDay % 60).padStart(2, '0')
  const time = `${hour}:${minute}`
  return local.date === readLocalParts(now, timeZone).date ? time : `${local.weekday} ${time}`
}

function findNextBoundary(state: QuietState, at: Date, timeZone: string): Date | undefined {
  if (state.mutedUntil !== undefined && state.mutedUntil.getTime() > at.getTime()) {
    return state.mutedUntil
  }
  if (state.quietHours === undefined) {
    return undefined
  }
  const { minuteOfDay } = readLocalParts(at, timeZone)
  if (!containsMinute(state.quietHours, minuteOfDay)) {
    return undefined
  }
  const minutesLeft = (state.quietHours.endMinute - minuteOfDay + MINUTES_PER_DAY) % MINUTES_PER_DAY
  // Zone offsets are whole minutes, so UTC seconds match local seconds.
  const intoMinuteMs = at.getUTCSeconds() * 1000 + at.getUTCMilliseconds()
  return new Date(at.getTime() + minutesLeft * MINUTE_MS - intoMinuteMs)
}

function containsMinute(hours: QuietHours, minuteOfDay: number): boolean {
  if (hours.startMinute < hours.endMinute) {
    return hours.startMinute <= minuteOfDay && minuteOfDay < hours.endMinute
  }
  return minuteOfDay >= hours.startMinute || minuteOfDay < hours.endMinute
}

function readLocalParts(at: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(at)
  const byType = new Map(parts.map((part) => [part.type, part.value]))
  const hour = Number(byType.get('hour'))
  const minute = Number(byType.get('minute'))
  return {
    date: `${byType.get('year')}-${byType.get('month')}-${byType.get('day')}`,
    weekday: byType.get('weekday') ?? '',
    minuteOfDay: hour * 60 + minute,
  }
}
