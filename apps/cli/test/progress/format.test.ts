import { expect, test } from 'vite-plus/test'
import { formatDuration, resolveProgressMode } from '../../src/progress/index.ts'

test('formatDuration pads seconds and adds hours from one hour up', () => {
  expect(formatDuration(0)).toBe('0:00')
  expect(formatDuration(14_400)).toBe('0:14')
  expect(formatDuration(108_000)).toBe('1:48')
  expect(formatDuration(3_723_000)).toBe('1:02:03')
})

test('formatDuration floors partial seconds and clamps negatives to zero', () => {
  expect(formatDuration(1_999)).toBe('0:01')
  expect(formatDuration(-500)).toBe('0:00')
})

test('resolveProgressMode is live only on a tty that is not dumb and not ci', () => {
  expect(resolveProgressMode({ isTTY: true }, {}, 'plain')).toBe('live')
  expect(resolveProgressMode({ isTTY: false }, {}, 'plain')).toBe('plain')
  expect(resolveProgressMode({}, {}, 'silent')).toBe('silent')
  expect(resolveProgressMode({ isTTY: true }, { TERM: 'dumb' }, 'silent')).toBe('silent')
  expect(resolveProgressMode({ isTTY: true }, { CI: 'true' }, 'plain')).toBe('plain')
})
