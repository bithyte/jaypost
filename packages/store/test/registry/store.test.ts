import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import { openDatabase, resolveDatabasePath } from '../../src/database/index.ts'
import {
  createEmptyRegistry,
  ensureAdminKey,
  RegistryStore,
  removeBot,
  resolveAdminKey,
  resolveAdminKeyPath,
  resolveBotFiles,
  resolveSeedAuditPath,
  writeAdminKeyFile,
} from '../../src/registry/index.ts'
import type { Registry } from '../../src/registry/index.ts'

const CREATED = '2026-10-26T10:00:00.000Z'
const ADMIN_KEY = `jpa_${'a'.repeat(43)}`
const OTHER_ADMIN_KEY = `jpa_${'b'.repeat(43)}`

const SEED = {
  fingerprint: 'e'.repeat(64),
  botId: 'b1',
  pairingId: 'p1',
  keyId: 'k1',
  isOpen: false,
}

const REGISTRY: Registry = {
  version: 1,
  lastIds: { bot: 1, pairing: 1, key: 1 },
  bots: [{ id: 'b1', provider: 'telegram', settings: { botToken: 'tok' }, createdAt: CREATED }],
  pairings: [{ id: 'p1', botId: 'b1', person: '7', quietHours: '22:00-07:00', createdAt: CREATED }],
  keys: [{ id: 'k1', pairingId: 'p1', hash: 'f'.repeat(64), createdAt: CREATED }],
  seed: SEED,
}

const FULL_REGISTRY: Registry = {
  version: 1,
  lastIds: { bot: 12, pairing: 3, key: 4 },
  bots: [
    { id: 'b1', provider: 'telegram', settings: { botToken: 'tok' }, createdAt: CREATED },
    {
      id: 'b12',
      provider: 'discord',
      settings: { botToken: 'other', guild: 5 },
      label: 'ops',
      createdAt: CREATED,
    },
  ],
  pairings: [
    { id: 'p1', botId: 'b1', person: '7', quietHours: '22:00-07:00', createdAt: CREATED },
    {
      id: 'p3',
      botId: 'b12',
      code: 'ABCD-EFGH',
      mutedUntil: '2026-10-27T00:00:00.000Z',
      createdAt: CREATED,
    },
  ],
  keys: [
    { id: 'k1', pairingId: 'p1', createdAt: CREATED },
    {
      id: 'k4',
      pairingId: 'p3',
      hash: 'f'.repeat(64),
      label: 'ci',
      externalId: 'x-1',
      createdAt: CREATED,
    },
  ],
  seed: { ...SEED, isOpen: true },
}

const TWO_BOTS: Registry = {
  version: 1,
  lastIds: { bot: 2, pairing: 2, key: 2 },
  bots: [
    { id: 'b1', provider: 'telegram', settings: { botToken: 'one' }, createdAt: CREATED },
    {
      id: 'b2',
      provider: 'telegram',
      settings: { botToken: 'two' },
      label: 'two',
      createdAt: CREATED,
    },
  ],
  pairings: [
    { id: 'p1', botId: 'b1', person: '7', createdAt: CREATED },
    { id: 'p2', botId: 'b2', person: '8', createdAt: CREATED },
  ],
  keys: [
    { id: 'k1', pairingId: 'p1', hash: '1'.repeat(64), createdAt: CREATED },
    { id: 'k2', pairingId: 'p2', hash: '2'.repeat(64), createdAt: CREATED },
  ],
}

let directory: string
let configPath: string
let databasePath: string
let opened: DatabaseSync[]

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jaypost-registry-'))
  configPath = join(directory, 'config.json')
  databasePath = resolveDatabasePath(configPath)
  opened = []
})
afterEach(() => {
  for (const database of opened) {
    database.close()
  }
  rmSync(directory, { recursive: true, force: true })
})

function openTestDatabase(): DatabaseSync {
  const database = openDatabase(databasePath)
  opened.push(database)
  return database
}

function loadFresh(): Registry {
  return new RegistryStore(openTestDatabase()).load()
}

function seedStateRows(database: DatabaseSync, botId: string): void {
  for (const table of ['requests', 'notifications']) {
    database
      .prepare(
        `INSERT INTO ${table} (bot_id, id, provider, record) VALUES (?, ?, 'telegram', '{}')`,
      )
      .run(botId, `${botId}-row`)
  }
}

function listStateRows(database: DatabaseSync, table: string): readonly string[] {
  return database
    .prepare(`SELECT bot_id FROM ${table} ORDER BY bot_id`)
    .all()
    .map((row) => String(row.bot_id))
}

function listTempFiles(path: string): readonly string[] {
  return readdirSync(path).filter((name) => name.endsWith('.tmp'))
}

test('admin key and bot files live next to config.json', () => {
  expect(resolveAdminKeyPath('/data/config.json')).toBe('/data/admin-key')
  expect(resolveBotFiles('/data/config.json', 'b2')).toEqual({
    directory: '/data/bots/b2',
    statePath: '/data/bots/b2/state.json',
    auditPath: '/data/bots/b2/audit.jsonl',
  })
})

test('loads an empty registry from a new db', () => {
  expect(new RegistryStore(openTestDatabase()).load()).toEqual(createEmptyRegistry())
})

test('round-trips a registry with bots, pairings, keys, counters and a seed', () => {
  new RegistryStore(openTestDatabase()).save(FULL_REGISTRY)
  const loaded = loadFresh()
  expect(loaded).toStrictEqual(FULL_REGISTRY)
  expect(Object.keys(loaded.bots[0] ?? {})).not.toContain('label')
  expect(Object.keys(loaded.keys[0] ?? {})).not.toContain('hash')
})

test('a registry without a seed round-trips without one', () => {
  const { seed: _seed, ...withoutSeed } = FULL_REGISTRY
  const store = new RegistryStore(openTestDatabase())
  store.save(FULL_REGISTRY)
  store.save(withoutSeed)
  expect(loadFresh()).toStrictEqual(withoutSeed)
})

test('writes only the rows a change touches', () => {
  const database = openTestDatabase()
  const store = new RegistryStore(database)
  store.save(TWO_BOTS)
  database.prepare("UPDATE bots SET label = 'raw' WHERE id = 'b2'").run()
  const withPairing: Registry = {
    ...TWO_BOTS,
    lastIds: { ...TWO_BOTS.lastIds, pairing: 3 },
    pairings: [...TWO_BOTS.pairings, { id: 'p3', botId: 'b1', code: 'WXYZ', createdAt: CREATED }],
  }
  store.save(withPairing)
  const loaded = loadFresh()
  expect(loaded.bots[1]).toEqual({ ...TWO_BOTS.bots[1], label: 'raw' })
  expect(loaded.pairings).toEqual(withPairing.pairings)
  expect(loaded.lastIds).toEqual(withPairing.lastIds)
})

test('moving keys into another pairing keeps them when the old pairing goes', () => {
  const store = new RegistryStore(openTestDatabase())
  store.save(TWO_BOTS)
  const merged: Registry = {
    ...TWO_BOTS,
    pairings: TWO_BOTS.pairings.filter((pairing) => pairing.id !== 'p2'),
    keys: TWO_BOTS.keys.map((key) => ({ ...key, pairingId: 'p1' })),
  }
  store.save(merged)
  expect(loadFresh()).toEqual(merged)
})

test('removing a bot deletes its pairings, keys, requests and notifications', () => {
  const database = openTestDatabase()
  const store = new RegistryStore(database)
  store.save(TWO_BOTS)
  seedStateRows(database, 'b1')
  seedStateRows(database, 'b2')
  const removed = removeBot(TWO_BOTS, 'b1')
  if (removed.kind !== 'removed') {
    throw new Error('expected b1 to be removed')
  }
  store.save(removed.registry)
  expect(loadFresh()).toEqual(removed.registry)
  expect(listStateRows(database, 'requests')).toEqual(['b2'])
  expect(listStateRows(database, 'notifications')).toEqual(['b2'])
  expect(
    database
      .prepare('SELECT id FROM pairings')
      .all()
      .map((row) => row.id),
  ).toEqual(['p2'])
  expect(
    database
      .prepare('SELECT id FROM keys')
      .all()
      .map((row) => row.id),
  ).toEqual(['k2'])
})

test('a failed save changes nothing and the next save still applies', () => {
  const store = new RegistryStore(openTestDatabase())
  store.save(TWO_BOTS)
  const clash: Registry = {
    ...TWO_BOTS,
    lastIds: { ...TWO_BOTS.lastIds, key: 3 },
    bots: TWO_BOTS.bots.map((bot) => ({ ...bot, label: 'changed' })),
    keys: [
      ...TWO_BOTS.keys,
      { id: 'k3', pairingId: 'p1', hash: '1'.repeat(64), createdAt: CREATED },
    ],
  }
  expect(() => store.save(clash)).toThrow()
  expect(loadFresh()).toEqual(TWO_BOTS)
  const valid: Registry = {
    ...TWO_BOTS,
    bots: [TWO_BOTS.bots[0], { ...TWO_BOTS.bots[1], label: 'x' }],
  }
  store.save(valid)
  expect(loadFresh()).toEqual(valid)
})

test('a store over a db it has not read saves against what the db holds', () => {
  new RegistryStore(openTestDatabase()).save(TWO_BOTS)
  const changed: Registry = {
    ...TWO_BOTS,
    bots: TWO_BOTS.bots.slice(0, 1),
    pairings: TWO_BOTS.pairings.slice(0, 1),
    keys: TWO_BOTS.keys.slice(0, 1),
  }
  new RegistryStore(openTestDatabase()).save(changed)
  expect(loadFresh()).toEqual(changed)
})

test('refuses a corrupt registry without quoting it', () => {
  const database = openTestDatabase()
  database
    .prepare(
      "INSERT INTO bots (id, provider, settings, created_at) VALUES ('b1', 'telegram', ?, ?)",
    )
    .run('{"token":"SECRET-1', CREATED)
  const load = (): Registry => new RegistryStore(database).load()
  expect(load).toThrow(`database ${JSON.stringify(databasePath)} has an invalid registry`)
  expect(load).not.toThrow(/SECRET-1/)
})

test('refuses rows that break the schema without quoting them', () => {
  const database = openTestDatabase()
  database
    .prepare(
      "INSERT INTO bots (id, provider, settings, created_at) VALUES ('b1', 'telegram', ?, ?)",
    )
    .run('{"token":["SECRET-2"]}', CREATED)
  const load = (): Registry => new RegistryStore(database).load()
  expect(load).toThrow(`database ${JSON.stringify(databasePath)} has an invalid registry`)
  expect(load).not.toThrow(/SECRET-2/)
})

test('the seed audit path is the seed bot one, or the legacy one without a db', () => {
  expect(resolveSeedAuditPath(configPath)).toBe(join(directory, 'audit.jsonl'))
  expect(readdirSync(directory)).toEqual([])
  new RegistryStore(openTestDatabase()).save({ ...REGISTRY, seed: { ...SEED, botId: 'b3' } })
  expect(resolveSeedAuditPath(configPath)).toBe(join(directory, 'bots', 'b3', 'audit.jsonl'))
})

test('a registry without a seed record gives the legacy audit path', () => {
  const { seed: _seed, ...withoutSeed } = REGISTRY
  new RegistryStore(openTestDatabase()).save(withoutSeed)
  expect(resolveSeedAuditPath(configPath)).toBe(join(directory, 'audit.jsonl'))
})

test('ensureAdminKey writes a jpa_ key once and returns the same key after', () => {
  const path = resolveAdminKeyPath(configPath)
  const log = vi.fn()
  const key = ensureAdminKey(path, log)
  expect(key).toMatch(/^jpa_[A-Za-z0-9_-]{43}$/)
  expect(readFileSync(path, 'utf8')).toBe(`${key}\n`)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(log).toHaveBeenCalledTimes(1)
  expect(String(log.mock.calls[0]?.[0])).not.toContain(key)
  expect(ensureAdminKey(path, log)).toBe(key)
  expect(log).toHaveBeenCalledTimes(1)
  expect(listTempFiles(directory)).toEqual([])
})

test('ensureAdminKey keeps a hand-written key and trims it', () => {
  const path = resolveAdminKeyPath(configPath)
  writeFileSync(path, `  ${ADMIN_KEY}\r\n`)
  const log = vi.fn()
  expect(ensureAdminKey(path, log)).toBe(ADMIN_KEY)
  expect(readFileSync(path, 'utf8')).toBe(`  ${ADMIN_KEY}\r\n`)
  expect(log).not.toHaveBeenCalled()
})

test('ensureAdminKey replaces an invalid key file without logging its contents', () => {
  const path = resolveAdminKeyPath(configPath)
  writeFileSync(path, 'jpa_short-secret\n')
  const log = vi.fn()
  const key = ensureAdminKey(path, log)
  expect(key).toMatch(/^jpa_[A-Za-z0-9_-]{43}$/)
  expect(readFileSync(path, 'utf8')).toBe(`${key}\n`)
  expect(log).toHaveBeenCalledTimes(1)
  const line = String(log.mock.calls[0]?.[0])
  expect(line).toContain(path)
  expect(line).not.toContain('short-secret')
  expect(line).not.toContain(key)
})

test('ensureAdminKey rethrows read errors other than a missing file', () => {
  const path = resolveAdminKeyPath(configPath)
  mkdirSync(path)
  expect(() => ensureAdminKey(path, vi.fn())).toThrow(/EISDIR/)
})

test('writeAdminKeyFile replaces the key with mode 0600', () => {
  const path = resolveAdminKeyPath(configPath)
  writeFileSync(path, `${ADMIN_KEY}\n`, { mode: 0o644 })
  writeAdminKeyFile(path, OTHER_ADMIN_KEY)
  expect(readFileSync(path, 'utf8')).toBe(`${OTHER_ADMIN_KEY}\n`)
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test('resolveAdminKey prefers the env var and never echoes the value', () => {
  const path = resolveAdminKeyPath(configPath)
  writeAdminKeyFile(path, ADMIN_KEY)
  expect(resolveAdminKey({ JAYPOST_ADMIN_KEY: OTHER_ADMIN_KEY }, path)).toEqual({
    kind: 'token',
    token: OTHER_ADMIN_KEY,
    source: 'env',
  })
  expect(resolveAdminKey({ JAYPOST_ADMIN_KEY: '' }, path)).toEqual({
    kind: 'token',
    token: ADMIN_KEY,
    source: 'file',
  })
  const badEnv = resolveAdminKey({ JAYPOST_ADMIN_KEY: 'jpa_bad secret' }, path)
  expect(badEnv).toEqual({
    kind: 'unusable',
    message: "JAYPOST_ADMIN_KEY isn't a valid jaypost admin key",
  })
  writeFileSync(path, 'jpa_bad secret\n')
  const badFile = resolveAdminKey({}, path)
  expect(badFile).toEqual({
    kind: 'unusable',
    message: `admin key file ${JSON.stringify(path)} isn't a valid jaypost admin key`,
  })
  expect(JSON.stringify([badEnv, badFile])).not.toContain('bad secret')
})

test('resolveAdminKey without the env var or the file finds none', () => {
  expect(resolveAdminKey({}, resolveAdminKeyPath(configPath))).toEqual({ kind: 'none' })
})

test('resolveAdminKey reports an unreadable file', () => {
  const path = resolveAdminKeyPath(configPath)
  mkdirSync(path)
  expect(resolveAdminKey({}, path)).toEqual({
    kind: 'unusable',
    message: expect.stringMatching(/^admin key file ".*" couldn't be read: .*EISDIR/),
  })
})
