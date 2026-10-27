import { expect, test } from 'vite-plus/test'
import { parseAuditLog, parseSince, selectAuditEntries } from '../../src/audit/index.ts'
import type { AuditEntry } from '../../src/audit/index.ts'

const NOW = new Date('2026-10-19T08:00:00Z')

function asked(id: string, at: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    v: 1,
    event: 'asked',
    id,
    at,
    text: `question ${id}`,
    options: ['Approve', 'Decline'],
    timeoutOption: 'Decline',
    timeoutSeconds: 300,
    ...extra,
  })}\n`
}

function settled(id: string, at: string, outcome: string, answer?: string): string {
  return `${JSON.stringify({
    v: 1,
    event: 'settled',
    id,
    at,
    outcome,
    ...(answer === undefined ? {} : { answer }),
  })}\n`
}

function entry(id: string, askedAt: string, project?: string): AuditEntry {
  return {
    id,
    askedAt,
    ...(project === undefined ? {} : { project }),
    text: id,
    options: [],
    timeoutOption: 'Decline',
    timeoutSeconds: 300,
    status: 'answered',
  }
}

test('merges asked and settled by id across .1 and current, oldest first', () => {
  const raw =
    asked('a', '2026-10-18T10:00:00.000Z', { project: 'deploy' }) +
    asked('b', '2026-10-18T11:00:00.000Z') +
    settled('a', '2026-10-18T10:00:05.000Z', 'answered', 'Approve') +
    settled('b', '2026-10-18T11:05:00.000Z', 'timedOut')
  expect(parseAuditLog(raw, NOW)).toEqual({
    entries: [
      {
        id: 'a',
        askedAt: '2026-10-18T10:00:00.000Z',
        project: 'deploy',
        text: 'question a',
        options: ['Approve', 'Decline'],
        timeoutOption: 'Decline',
        timeoutSeconds: 300,
        status: 'answered',
        answer: 'Approve',
        settledAt: '2026-10-18T10:00:05.000Z',
      },
      {
        id: 'b',
        askedAt: '2026-10-18T11:00:00.000Z',
        text: 'question b',
        options: ['Approve', 'Decline'],
        timeoutOption: 'Decline',
        timeoutSeconds: 300,
        status: 'timedOut',
        settledAt: '2026-10-18T11:05:00.000Z',
      },
    ],
    skippedCount: 0,
  })
})

test('statuses: answered, timedOut, rejected, cancelled, expired come from the settled line', () => {
  const outcomes = ['answered', 'timedOut', 'rejected', 'cancelled', 'expired']
  const raw = outcomes
    .map((outcome) => asked(outcome, '2026-10-18T10:00:00.000Z'))
    .concat(outcomes.map((outcome) => settled(outcome, '2026-10-18T10:01:00.000Z', outcome)))
    .join('')
  expect(parseAuditLog(raw, NOW).entries.map((item) => item.status)).toEqual(outcomes)
})

test('no settled line: pending before the timeout, interrupted after it', () => {
  const raw =
    asked('p', new Date(NOW.getTime() - 10_000).toISOString()) +
    asked('i', new Date(NOW.getTime() - 301_000).toISOString())
  expect(parseAuditLog(raw, NOW).entries.map((item) => item.status)).toEqual([
    'pending',
    'interrupted',
  ])
})

test('an unknown outcome is kept as the status with its answer', () => {
  const raw =
    asked('a', '2026-10-18T10:00:00.000Z') +
    settled('a', '2026-10-18T10:00:09.000Z', 'replied', 'tomorrow')
  const [only] = parseAuditLog(raw, NOW).entries
  expect(only?.status).toBe('replied')
  expect(only?.answer).toBe('tomorrow')
})

test('accepts options: [] and keeps unknown fields out of the entry', () => {
  const raw = asked('a', '2026-10-18T10:00:00.000Z', { options: [], extra: 'x' })
  const result = parseAuditLog(raw, NOW)
  expect(result.skippedCount).toBe(0)
  expect(result.entries[0]?.options).toEqual([])
  expect(Object.keys(result.entries[0] ?? {})).not.toContain('extra')
})

test('a settled line whose asked line is gone is dropped silently', () => {
  expect(parseAuditLog(settled('gone', '2026-10-18T10:00:00.000Z', 'answered', 'x'), NOW)).toEqual({
    entries: [],
    skippedCount: 0,
  })
})

test('counts invalid JSON, schema mismatches and other versions as skipped', () => {
  const raw = `nope\n{"v":1,"event":"asked"}\n${asked('a', '2026-10-18T10:00:00.000Z', { v: 2 })}`
  expect(parseAuditLog(raw, NOW)).toEqual({ entries: [], skippedCount: 3 })
})

test('ignores a trailing line without a newline and empty lines', () => {
  const raw = `\n${asked('a', '2026-10-18T10:00:00.000Z')}\n{"v":1,"event":"ask`
  const result = parseAuditLog(raw, NOW)
  expect(result.skippedCount).toBe(0)
  expect(result.entries).toHaveLength(1)
})

test('empty input gives no entries', () => {
  expect(parseAuditLog('', NOW)).toEqual({ entries: [], skippedCount: 0 })
})

test('selectAuditEntries filters by since (inclusive) and exact project, then keeps the last limit', () => {
  const entries = [
    entry('1', '2026-10-18T10:00:00.000Z', 'deploy'),
    entry('2', '2026-10-18T11:00:00.000Z', 'deploy'),
    entry('3', '2026-10-18T12:00:00.000Z', 'other'),
    entry('4', '2026-10-18T13:00:00.000Z', 'deploy'),
    entry('5', '2026-10-18T14:00:00.000Z'),
  ]
  const since = new Date('2026-10-18T11:00:00.000Z')
  expect(selectAuditEntries(entries, {}).map((item) => item.id)).toEqual(['1', '2', '3', '4', '5'])
  expect(selectAuditEntries(entries, { since }).map((item) => item.id)).toEqual([
    '2',
    '3',
    '4',
    '5',
  ])
  expect(selectAuditEntries(entries, { project: 'deploy' }).map((item) => item.id)).toEqual([
    '1',
    '2',
    '4',
  ])
  expect(
    selectAuditEntries(entries, { since, project: 'deploy', limit: 1 }).map((item) => item.id),
  ).toEqual(['4'])
})

test('the entry takes key and pairing from the asked line', () => {
  const raw =
    asked('a', '2026-10-18T10:00:00.000Z', { key: 'k1', pairing: 'p1' }) +
    asked('b', '2026-10-18T11:00:00.000Z') +
    settled('a', '2026-10-18T10:00:05.000Z', 'answered', 'Approve')
  const { entries, skippedCount } = parseAuditLog(raw, NOW)
  expect(skippedCount).toBe(0)
  expect(entries[0]).toEqual({
    id: 'a',
    askedAt: '2026-10-18T10:00:00.000Z',
    text: 'question a',
    options: ['Approve', 'Decline'],
    timeoutOption: 'Decline',
    timeoutSeconds: 300,
    status: 'answered',
    answer: 'Approve',
    settledAt: '2026-10-18T10:00:05.000Z',
    key: 'k1',
    pairing: 'p1',
  })
  expect(Object.hasOwn(entries[1] ?? {}, 'key')).toBe(false)
  expect(Object.hasOwn(entries[1] ?? {}, 'pairing')).toBe(false)
})

test('an asked line with a non-string key is skipped', () => {
  const raw = asked('a', '2026-10-18T10:00:00.000Z', { key: 7 })
  expect(parseAuditLog(raw, NOW)).toEqual({ entries: [], skippedCount: 1 })
})

test('selectAuditEntries filters by key and pairing', () => {
  const askedAt = '2026-10-18T10:00:00.000Z'
  const entries: AuditEntry[] = [
    { ...entry('a', askedAt), key: 'k1', pairing: 'p1' },
    { ...entry('b', askedAt), key: 'k2', pairing: 'p2' },
    entry('c', askedAt),
  ]
  const ids = (filter: Parameters<typeof selectAuditEntries>[1]) =>
    selectAuditEntries(entries, filter).map((item) => item.id)
  expect(ids({ key: 'k1' })).toEqual(['a'])
  expect(ids({ pairing: 'p2' })).toEqual(['b'])
  expect(ids({})).toEqual(['a', 'b', 'c'])
})

test('selectAuditEntries filters by bot', () => {
  const askedAt = '2026-10-18T10:00:00.000Z'
  const entries: AuditEntry[] = [
    { ...entry('a', askedAt), bot: 'b1' },
    { ...entry('b', askedAt), bot: 'b2' },
    entry('c', askedAt),
  ]
  expect(selectAuditEntries(entries, { bot: 'b2' }).map((item) => item.id)).toEqual(['b'])
})

test('parseSince accepts 30m, 12h and 7d', () => {
  expect(parseSince('30m', NOW)).toEqual(new Date(NOW.getTime() - 30 * 60_000))
  expect(parseSince('12h', NOW)).toEqual(new Date(NOW.getTime() - 12 * 3_600_000))
  expect(parseSince('7d', NOW)).toEqual(new Date(NOW.getTime() - 7 * 86_400_000))
})

test('parseSince reads a plain date as local midnight', () => {
  expect(parseSince('2026-10-18', NOW)).toEqual(new Date(2026, 9, 18))
})

test('parseSince accepts an ISO date-time with or without a zone', () => {
  expect(parseSince('2026-10-18T09:30:00Z', NOW)).toEqual(new Date('2026-10-18T09:30:00Z'))
  expect(parseSince('2026-10-18T09:30:00', NOW)).toEqual(new Date(2026, 9, 18, 9, 30))
})

test('parseSince rejects anything else', () => {
  for (const raw of [
    '',
    'yesterday',
    '12',
    '12x',
    '2026-02-30',
    '2026-13-01',
    '2026-10-18T99:00',
    '2026-02-30T10:00',
    '2026-02-30T10:00:00Z',
    '2026-04-31T10:00:00+02:00',
    '2026-13-01T10:00',
  ]) {
    expect(parseSince(raw, NOW)).toBeUndefined()
  }
})

test('parseSince rejects a duration too large to be a date', () => {
  expect(parseSince('99999999999d', NOW)).toBeUndefined()
})
