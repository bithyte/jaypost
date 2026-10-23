import { expect, test } from 'vite-plus/test'
import { findQuietEnd, formatClock, isInQuietHours } from '../../src/quiet/index.ts'

const ZONE = 'Europe/Bucharest'
const NIGHT = { startMinute: 1380, endMinute: 480 }
const LUNCH = { startMinute: 780, endMinute: 840 }
const at = (iso: string) => new Date(iso)

test('isInQuietHours: inside, outside, start inclusive, end exclusive', () => {
  expect(isInQuietHours(NIGHT, at('2026-07-15T20:30:00Z'), ZONE)).toBe(true) // 23:30
  expect(isInQuietHours(NIGHT, at('2026-07-15T12:00:00Z'), ZONE)).toBe(false) // 15:00
  expect(isInQuietHours(NIGHT, at('2026-07-15T20:00:00Z'), ZONE)).toBe(true) // 23:00
  expect(isInQuietHours(NIGHT, at('2026-07-16T04:59:00Z'), ZONE)).toBe(true) // 07:59
  expect(isInQuietHours(NIGHT, at('2026-07-16T05:00:00Z'), ZONE)).toBe(false) // 08:00
})

test('isInQuietHours: same-day window', () => {
  expect(isInQuietHours(LUNCH, at('2026-07-15T10:30:00Z'), ZONE)).toBe(true) // 13:30
  expect(isInQuietHours(LUNCH, at('2026-07-15T11:00:00Z'), ZONE)).toBe(false) // 14:00
})

test('isInQuietHours follows local time across the dst change', () => {
  // 2026-10-25 is EET (UTC+2) after 04:00; a fixed +3 offset would say 08:30 here
  expect(isInQuietHours(NIGHT, at('2026-10-25T05:30:00Z'), ZONE)).toBe(true) // 07:30
  expect(isInQuietHours(NIGHT, at('2026-10-25T06:00:00Z'), ZONE)).toBe(false) // 08:00
})

test('isInQuietHours uses the given zone', () => {
  expect(isInQuietHours(NIGHT, at('2026-07-15T20:30:00Z'), 'UTC')).toBe(false)
})

test('findQuietEnd is undefined when not quiet, including after a mute expired', () => {
  const now = at('2026-07-15T12:00:00Z') // 15:00
  expect(
    findQuietEnd({ quietHours: NIGHT, mutedUntil: at('2026-07-15T11:00:00Z') }, now, ZONE),
  ).toBe(undefined)
  expect(findQuietEnd({}, now, ZONE)).toBe(undefined)
})

test('findQuietEnd: mute only, window only', () => {
  expect(
    findQuietEnd(
      { mutedUntil: at('2026-07-15T14:00:00Z') },
      at('2026-07-15T12:00:00Z'),
      ZONE,
    )?.toISOString(),
  ).toBe('2026-07-15T14:00:00.000Z')
  expect(findQuietEnd({ quietHours: NIGHT }, at('2026-07-15T20:30:00Z'), ZONE)?.toISOString()).toBe(
    '2026-07-16T05:00:00.000Z',
  )
})

test('findQuietEnd lands on the minute boundary', () => {
  expect(
    findQuietEnd({ quietHours: NIGHT }, at('2026-07-16T04:59:30.500Z'), ZONE)?.toISOString(),
  ).toBe('2026-07-16T05:00:00.000Z')
})

test('findQuietEnd: mute ending inside the window, window ending inside the mute', () => {
  expect(
    findQuietEnd(
      { quietHours: NIGHT, mutedUntil: at('2026-07-15T21:00:00Z') },
      at('2026-07-15T19:00:00Z'),
      ZONE,
    )?.toISOString(),
  ).toBe('2026-07-16T05:00:00.000Z')
  expect(
    findQuietEnd(
      { quietHours: NIGHT, mutedUntil: at('2026-07-16T07:00:00Z') },
      at('2026-07-15T20:30:00Z'),
      ZONE,
    )?.toISOString(),
  ).toBe('2026-07-16T07:00:00.000Z')
})

test('findQuietEnd: window, then mute, then the next window', () => {
  expect(
    findQuietEnd(
      { quietHours: NIGHT, mutedUntil: at('2026-07-16T20:30:00Z') },
      at('2026-07-15T20:30:00Z'),
      ZONE,
    )?.toISOString(),
  ).toBe('2026-07-17T05:00:00.000Z')
})

test('formatClock shows HH:MM today and a weekday otherwise', () => {
  const now = at('2026-07-15T11:00:00Z') // Wed 14:00
  expect(formatClock(at('2026-07-15T11:30:00Z'), now, ZONE)).toBe('14:30')
  expect(formatClock(at('2026-07-16T11:30:00Z'), now, ZONE)).toBe('Thu 14:30')
  expect(formatClock(at('2026-07-15T21:30:00Z'), now, ZONE)).toBe('Thu 00:30')
})
