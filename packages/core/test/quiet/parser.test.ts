import { expect, test } from 'vite-plus/test'
import { formatQuietHours, parseMuteDuration, parseQuietHours } from '../../src/quiet/index.ts'

test('parseQuietHours reads wrapping and same-day windows', () => {
  expect(parseQuietHours('23:00-08:00')).toEqual({
    ok: true,
    value: { startMinute: 1380, endMinute: 480 },
  })
  expect(parseQuietHours('13:00-14:00')).toEqual({
    ok: true,
    value: { startMinute: 780, endMinute: 840 },
  })
})

test('parseQuietHours accepts bare and single-digit hours and spaces around the dash', () => {
  for (const [raw, normalized] of [
    ['23-8', '23:00-08:00'],
    ['7:30-9', '07:30-09:00'],
    [' 23:00 - 08:00 ', '23:00-08:00'],
  ] as const) {
    const result = parseQuietHours(raw)
    expect(result.ok && formatQuietHours(result.value)).toBe(normalized)
  }
})

test('parseQuietHours rejects equal ends', () => {
  expect(parseQuietHours('22:00-22')).toEqual({ ok: false, error: 'start and end are the same' })
})

test.each([
  '25:00-08:00',
  '24:00-08:00',
  '23:60-08:00',
  '23:0-08:00',
  '23:00',
  'night',
  '',
  '23:00-08:00-09:00',
])('parseQuietHours rejects %j', (raw) => {
  expect(parseQuietHours(raw)).toEqual({ ok: false, error: 'expected HH:MM-HH:MM' })
})

test('parseMuteDuration reads each unit and combinations in d-h-m order', () => {
  const cases = [
    ['30m', 1_800_000],
    ['2h', 7_200_000],
    ['1d', 86_400_000],
    ['1h30m', 5_400_000],
    ['1d12h', 129_600_000],
    ['7d', 604_800_000],
  ] as const
  for (const [raw, ms] of cases) {
    expect(parseMuteDuration(raw)).toEqual({ ok: true, value: ms })
  }
})

test('parseMuteDuration ignores case and inner spaces', () => {
  expect(parseMuteDuration('2H')).toEqual({ ok: true, value: 7_200_000 })
  expect(parseMuteDuration('1h 30m')).toEqual({ ok: true, value: 5_400_000 })
  expect(parseMuteDuration(' 1D ')).toEqual({ ok: true, value: 86_400_000 })
})

test.each(['0m', '0h0m', '8d', '6d25h', '2', '', '30m1h', 'm', '-1h', '1.5h', '1w'])(
  'parseMuteDuration rejects %j',
  (raw) => {
    expect(parseMuteDuration(raw).ok).toBe(false)
  },
)
