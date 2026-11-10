import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vite-plus/test'
import {
  AUDIT_RETENTION_MS,
  AuditLog,
  formatAuditLines,
  parseAuditLog,
  pruneAuditLog,
  readAuditEntries,
  readSeedAuditLog,
} from '../../src/audit/index.ts'
import { openDatabase, resolveDatabasePath } from '../../src/database/index.ts'

const AT = new Date('2026-10-18T21:41:07.312Z')
const NOW = new Date('2026-10-18T22:00:00.000Z')
const REQUEST = {
  message: { text: '[deploy]\n\nForce-push main?', spans: [] },
  question: 'Force-push main?',
  project: 'deploy',
  allowText: false,
  options: ['Approve', 'Decline'],
  timeoutOption: 'Decline',
  timeoutSeconds: 300,
  attachment: undefined,
}
const CALLER = { key: 'k1', contact: 'c1' }

let directory: string
const log = vi.fn()

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'tab-audit-'))
  log.mockReset()
})

function createDatabase(): DatabaseSync {
  return openDatabase(join(directory, 'jaypost.db'))
}

test('logs a settled question with its answer', () => {
  const database = createDatabase()
  const audit = new AuditLog(database, 'b1', { log })
  const settledAt = new Date('2026-10-18T21:41:52.004Z')
  audit.asked('5f0c', { ...REQUEST, caller: CALLER }, AT)
  audit.settled('5f0c', { kind: 'answered', answer: 'Approve' }, settledAt, CALLER)
  expect(readAuditEntries(database, NOW)).toEqual({
    entries: [
      {
        botId: 'b1',
        entry: {
          id: '5f0c',
          askedAt: AT.toISOString(),
          project: 'deploy',
          text: 'Force-push main?',
          options: ['Approve', 'Decline'],
          timeoutOption: 'Decline',
          timeoutSeconds: 300,
          status: 'answered',
          answer: 'Approve',
          settledAt: settledAt.toISOString(),
          key: 'k1',
          contact: 'c1',
        },
      },
    ],
    skippedCount: 0,
  })
  expect(log).not.toHaveBeenCalled()
})

test('marks an unsettled question pending, then interrupted after its timeout', () => {
  const database = createDatabase()
  new AuditLog(database, 'b1', { log }).asked('a', REQUEST, AT)
  const statusAt = (now: Date) =>
    readAuditEntries(database, now).entries.map(({ entry }) => entry.status)
  expect(statusAt(new Date(AT.getTime() + 60_000))).toEqual(['pending'])
  expect(statusAt(new Date(AT.getTime() + 301_000))).toEqual(['interrupted'])
})

test('keeps the first settlement', () => {
  const database = createDatabase()
  const audit = new AuditLog(database, 'b1', { log })
  audit.asked('a', REQUEST, AT)
  audit.settled('a', { kind: 'answered', answer: 'Approve' }, AT, undefined)
  audit.settled('a', { kind: 'cancelled' }, new Date(AT.getTime() + 1000), undefined)
  const [only] = readAuditEntries(database, NOW).entries
  expect(only?.entry).toMatchObject({ status: 'answered', answer: 'Approve' })
})

test('keeps the first asked row for an id', () => {
  const database = createDatabase()
  const audit = new AuditLog(database, 'b1', { log })
  audit.asked('a', REQUEST, AT)
  audit.asked('a', { ...REQUEST, question: 'Other?' }, AT)
  expect(readAuditEntries(database, NOW).entries.map(({ entry }) => entry.text)).toEqual([
    'Force-push main?',
  ])
})

test('ignores a settlement with no asked question', () => {
  const database = createDatabase()
  const audit = new AuditLog(database, 'b1', { log })
  expect(() => audit.settled('ghost', { kind: 'cancelled' }, AT, undefined)).not.toThrow()
  expect(readAuditEntries(database, NOW)).toEqual({ entries: [], skippedCount: 0 })
  expect(log).not.toHaveBeenCalled()
})

test('reads one bot or every bot, oldest first', () => {
  const database = createDatabase()
  const first = new AuditLog(database, 'b1', { log })
  const second = new AuditLog(database, 'b2', { log })
  first.asked('late', REQUEST, new Date('2026-10-18T21:50:00.000Z'))
  second.asked('early', REQUEST, new Date('2026-10-18T21:40:00.000Z'))
  second.asked('tie', REQUEST, new Date('2026-10-18T21:50:00.000Z'))
  expect(
    readAuditEntries(database, NOW).entries.map(({ botId, entry }) => [botId, entry.id]),
  ).toEqual([
    ['b2', 'early'],
    ['b1', 'late'],
    ['b2', 'tie'],
  ])
  expect(readAuditEntries(database, NOW, 'b2').entries.map(({ entry }) => entry.id)).toEqual([
    'early',
    'tie',
  ])
  expect(readAuditEntries(database, NOW, 'gone')).toEqual({ entries: [], skippedCount: 0 })
})

test('counts a row whose options are not a string array as skipped', () => {
  const database = createDatabase()
  const audit = new AuditLog(database, 'b1', { log })
  audit.asked('good', REQUEST, AT)
  audit.asked('bad', REQUEST, AT)
  database.prepare("UPDATE questions SET options = '{\"a\":1}' WHERE id = 'bad'").run()
  const result = readAuditEntries(database, NOW)
  expect(result.entries.map(({ entry }) => entry.id)).toEqual(['good'])
  expect(result.skippedCount).toBe(1)
})

test('round-trips through the jsonl format', () => {
  const database = createDatabase()
  const audit = new AuditLog(database, 'b1', { log })
  const { project: _project, ...bare } = REQUEST
  audit.asked('a', { ...REQUEST, caller: CALLER }, AT)
  audit.settled('a', { kind: 'answered', answer: 'Approve' }, new Date(AT.getTime() + 5000), CALLER)
  audit.asked('b', REQUEST, new Date(AT.getTime() + 1000))
  audit.asked('c', bare, new Date(AT.getTime() + 2000))
  audit.settled('c', { kind: 'cancelled' }, new Date(AT.getTime() + 3000), undefined)
  new AuditLog(database, 'b2', { log }).asked('other', REQUEST, AT)
  const lines = formatAuditLines(database, 'b1')
  expect(lines.endsWith('\n')).toBe(true)
  expect(parseAuditLog(lines, NOW).entries).toEqual(
    readAuditEntries(database, NOW, 'b1').entries.map(({ entry }) => entry),
  )
  expect(parseAuditLog(lines, NOW).entries).toHaveLength(3)
  expect(formatAuditLines(database, 'nobody')).toBe('')
})

test('prunes questions asked before the cutoff', () => {
  const database = createDatabase()
  const audit = new AuditLog(database, 'b1', { log })
  audit.asked('old', REQUEST, new Date(NOW.getTime() - 31 * 86_400_000))
  audit.asked('new', REQUEST, new Date(NOW.getTime() - 29 * 86_400_000))
  expect(pruneAuditLog(database, new Date(NOW.getTime() - AUDIT_RETENTION_MS))).toBe(1)
  expect(readAuditEntries(database, NOW).entries.map(({ entry }) => entry.id)).toEqual(['new'])
})

test("reads the seed bot's log next to the config", () => {
  const configPath = join(directory, 'config.json')
  const database = openDatabase(resolveDatabasePath(configPath))
  database
    .prepare(
      "INSERT INTO bots (id, provider, settings, created_at) VALUES ('seedbot', 'telegram', '{}', '2026-10-01T00:00:00.000Z'), ('other', 'telegram', '{}', '2026-10-01T00:00:00.000Z')",
    )
    .run()
  database
    .prepare(
      "INSERT INTO contacts (id, bot_id, created_at) VALUES ('c', 'seedbot', '2026-10-01T00:00:00.000Z')",
    )
    .run()
  database
    .prepare(
      "INSERT INTO keys (id, contact_id, created_at) VALUES ('k', 'c', '2026-10-01T00:00:00.000Z')",
    )
    .run()
  database
    .prepare(
      "INSERT INTO seed (only, fingerprint, bot_id, contact_id, key_id, is_open) VALUES (1, 'f', 'seedbot', 'c', 'k', 0)",
    )
    .run()
  new AuditLog(database, 'seedbot', { log }).asked('mine', REQUEST, AT)
  new AuditLog(database, 'other', { log }).asked('theirs', REQUEST, AT)
  const expected = formatAuditLines(database, 'seedbot')
  database.close()
  const raw = readSeedAuditLog(configPath)
  expect(raw).toBe(expected)
  expect(raw).toContain('"id":"mine"')
  expect(raw).not.toContain('theirs')
})

test('reads nothing and creates no db when the service never ran', () => {
  const configPath = join(directory, 'config.json')
  expect(readSeedAuditLog(configPath)).toBe('')
  expect(existsSync(resolveDatabasePath(configPath))).toBe(false)
})

test('reads nothing from a db with no seed', () => {
  const configPath = join(directory, 'config.json')
  openDatabase(resolveDatabasePath(configPath)).close()
  expect(readSeedAuditLog(configPath)).toBe('')
})

test('logs and keeps going when a write fails', () => {
  const database = createDatabase()
  const audit = new AuditLog(database, 'b1', { log })
  database.close()
  expect(() => audit.asked('a', REQUEST, AT)).not.toThrow()
  expect(log).toHaveBeenCalledTimes(1)
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/^failed to write audit log: /))
})

test('an invalid date does not throw and reports through log', () => {
  const audit = new AuditLog(createDatabase(), 'b1', { log })
  expect(() => audit.asked('a', REQUEST, new Date(Number.NaN))).not.toThrow()
  expect(log).toHaveBeenCalledTimes(1)
})
