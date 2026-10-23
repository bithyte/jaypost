import { expect, test } from 'vite-plus/test'
import { formatAuditJsonLines, formatAuditTable } from '../../src/audit/index.ts'
import type { AuditEntry } from '../../src/audit/index.ts'

function entry(hour: number, minute: number, extra: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: `id-${hour}-${minute}`,
    askedAt: new Date(2026, 9, 19, hour, minute).toISOString(),
    text: 'Q?',
    options: ['Approve', 'Decline'],
    timeoutOption: 'Decline',
    timeoutSeconds: 300,
    status: 'answered',
    ...extra,
  }
}

const DEPLOY = entry(0, 41, {
  project: 'deploy',
  text: 'Force-push main to origin?',
  answer: 'Approve',
})
const NAS = entry(1, 12, {
  project: 'nas',
  text: 'Delete 14 old snapshots?',
  status: 'timedOut',
  answer: 'Decline',
})
const MIGRATIONS = entry(2, 3, {
  text: 'Run migrations on prod?',
  status: 'cancelled',
})
const CI = entry(3, 30, {
  project: 'ci',
  text: 'Merge #212?',
  status: 'interrupted',
})

test('formats the spec example table', () => {
  expect(formatAuditTable([DEPLOY, NAS, MIGRATIONS, CI])).toBe(
    [
      '2026-10-19 00:41  deploy  Approve              Force-push main to origin?',
      '2026-10-19 01:12  nas     Decline (timed out)  Delete 14 old snapshots?',
      '2026-10-19 02:03          cancelled            Run migrations on prod?',
      '2026-10-19 03:30  ci      interrupted          Merge #212?',
    ].join('\n'),
  )
})

test('shows rejected, expired, pending and unknown outcomes', () => {
  const rows = formatAuditTable([
    entry(1, 0, { status: 'rejected', answer: 'Decline' }),
    entry(2, 0, { status: 'expired' }),
    entry(3, 0, { status: 'pending' }),
    entry(4, 0, { status: 'replied', answer: 'tomorrow' }),
    entry(5, 0, { status: 'weird' }),
  ]).split('\n')
  expect(rows.map((row) => row.slice(18))).toEqual([
    'Decline (rejected)  Q?',
    'expired             Q?',
    'pending             Q?',
    'replied: tomorrow   Q?',
    'weird               Q?',
  ])
})

test('drops the project column when no entry has a project', () => {
  expect(formatAuditTable([entry(1, 0, { answer: 'Approve' })])).toBe(
    '2026-10-19 01:00  Approve  Q?',
  )
})

test('cuts the question at 80, the answer at 30 and the project at 20 with ...', () => {
  const row = formatAuditTable([
    entry(1, 0, {
      project: 'p'.repeat(30),
      text: 'q'.repeat(100),
      answer: 'a'.repeat(50),
    }),
  ])
  expect(row).toBe(
    `2026-10-19 01:00  ${'p'.repeat(17)}...  ${'a'.repeat(27)}...  ${'q'.repeat(77)}...`,
  )
})

test('does not split a surrogate pair when cutting', () => {
  const row = formatAuditTable([entry(1, 0, { text: '\u{1F600}'.repeat(60), answer: 'x' })])
  const question = row.slice('2026-10-19 01:00  x  '.length)
  expect(question).toBe(`${'\u{1F600}'.repeat(38)}...`)
  expect(question.length).toBeLessThanOrEqual(80)
})

test('shows only the first line of a multi-line question and answer', () => {
  expect(
    formatAuditTable([entry(1, 0, { text: '\n  First line\nsecond\n', answer: 'one\ntwo' })]),
  ).toBe('2026-10-19 01:00  one  First line')
})

test('replaces control characters so escapes cannot reach the terminal', () => {
  const row = formatAuditTable([
    entry(1, 0, {
      project: 'a\u001bb',
      text: '\u001b[31mRed\u0007?',
      answer: 'x\u0085y',
    }),
  ])
  expect(row).toBe('2026-10-19 01:00  a b  x y   [31mRed ?')
})

test('formatAuditJsonLines prints one entry per line in the spec key order', () => {
  const full: AuditEntry = {
    id: '5f0c…',
    askedAt: '2026-10-18T21:41:07.312Z',
    project: 'deploy',
    text: 'Force-push main?',
    options: ['Approve', 'Decline'],
    timeoutOption: 'Decline',
    timeoutSeconds: 300,
    status: 'answered',
    answer: 'Approve',
    settledAt: '2026-10-18T21:41:52.004Z',
  }
  const lines = formatAuditJsonLines([full, CI]).split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[0]).toBe(
    '{"id":"5f0c…","askedAt":"2026-10-18T21:41:07.312Z","project":"deploy","text":"Force-push main?","options":["Approve","Decline"],"timeoutOption":"Decline","timeoutSeconds":300,"status":"answered","answer":"Approve","settledAt":"2026-10-18T21:41:52.004Z"}',
  )
  expect(JSON.parse(lines[1] ?? '')).toEqual(CI)
})
