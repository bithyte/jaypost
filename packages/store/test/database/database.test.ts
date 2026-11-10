import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vite-plus/test'
import { openDatabase, removeDatabaseFiles, resolveDatabasePath } from '../../src/database/index.ts'

const TABLE_NAMES = [
  'bots',
  'contacts',
  'counters',
  'keys',
  'notifications',
  'questions',
  'requests',
  'seed',
]

function createPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'tab-database-')), 'jaypost.db')
}

function readMode(path: string): number {
  return statSync(path).mode & 0o777
}

function listTables(database: DatabaseSync): string[] {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
  return rows.map((row) => String(row.name))
}

test('resolves jaypost.db next to the config', () => {
  expect(resolveDatabasePath('/data/config.json')).toBe('/data/jaypost.db')
})

test('sets the busy timeout before anything else can lock', () => {
  const database = openDatabase(createPath())
  try {
    expect(database.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
  } finally {
    database.close()
  }
})

test('creates the schema at version 1', () => {
  const database = openDatabase(createPath())
  try {
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
    expect(listTables(database)).toEqual(TABLE_NAMES)
    expect(database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
  } finally {
    database.close()
  }
})

test('keeps the db and its wal files owner-only', () => {
  const path = createPath()
  const previousMask = process.umask(0o022)
  const database = openDatabase(path)
  try {
    database.prepare("INSERT INTO counters (name, value) VALUES ('bot', 1)").run()
    expect(readMode(path)).toBe(0o600)
    expect(readMode(`${path}-wal`)).toBe(0o600)
    expect(readMode(`${path}-shm`)).toBe(0o600)
  } finally {
    database.close()
    process.umask(previousMask)
  }
})

test('reopens an existing db without touching its rows', () => {
  const path = createPath()
  const first = openDatabase(path)
  first.prepare("INSERT INTO counters (name, value) VALUES ('bot', 7)").run()
  first.close()
  const second = openDatabase(path)
  try {
    expect(second.prepare('SELECT name, value FROM counters').all()).toEqual([
      { name: 'bot', value: 7 },
    ])
  } finally {
    second.close()
  }
})

test('lets a second connection read while the first holds a write transaction', () => {
  const path = createPath()
  const writer = openDatabase(path)
  const reader = openDatabase(path)
  try {
    writer.exec('BEGIN IMMEDIATE')
    writer.prepare("INSERT INTO counters (name, value) VALUES ('bot', 1)").run()
    expect(reader.prepare('SELECT * FROM counters').all()).toEqual([])
    writer.exec('COMMIT')
    expect(reader.prepare('SELECT * FROM counters').all()).toEqual([{ name: 'bot', value: 1 }])
  } finally {
    writer.close()
    reader.close()
  }
})

test('refuses another schema version', () => {
  const path = createPath()
  openDatabase(path).close()
  const raw = new DatabaseSync(path)
  raw.exec('PRAGMA user_version = 2')
  raw.close()
  expect(() => openDatabase(path)).toThrow(JSON.stringify(path))
  expect(() => openDatabase(path)).toThrow('schema version 2')
})

test("refuses a file that isn't sqlite without quoting it", () => {
  const path = createPath()
  writeFileSync(path, 'SECRET-TOKEN-123'.repeat(20))
  let message = ''
  try {
    openDatabase(path).close()
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  expect(message).toContain(JSON.stringify(path))
  expect(message).not.toContain('SECRET-TOKEN-123')
})

test('removes the db and its wal files, missing ones too', () => {
  const path = createPath()
  openDatabase(path).close()
  writeFileSync(`${path}-wal`, '')
  writeFileSync(`${path}-shm`, '')
  removeDatabaseFiles(path)
  for (const suffix of ['', '-wal', '-shm']) {
    expect(() => statSync(`${path}${suffix}`)).toThrow()
  }
  expect(() => removeDatabaseFiles(path)).not.toThrow()
  rmSync(join(path, '..'), { recursive: true, force: true })
})
