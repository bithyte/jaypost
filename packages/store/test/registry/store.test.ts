import {
  existsSync,
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
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import {
  createEmptyRegistry,
  ensureAdminKey,
  migrateLegacyBotFiles,
  RegistryStore,
  resolveAdminKey,
  resolveAdminKeyPath,
  resolveBotFiles,
  resolveRegistryPath,
  resolveSeedAuditPath,
  writeAdminKeyFile,
} from '../../src/registry/index.ts'
import type { Registry } from '../../src/registry/index.ts'
import { StateStore } from '../../src/state/index.ts'

const CREATED = '2026-10-26T10:00:00.000Z'
const ADMIN_KEY = `jpa_${'a'.repeat(43)}`
const OTHER_ADMIN_KEY = `jpa_${'b'.repeat(43)}`
const REQUEST = { id: 'r1', reference: { chatId: 1, messageId: 2 }, text: 'Deploy?' }
const NOTIFICATION = {
  id: 'n1',
  reference: { chatId: 1, messageId: 3 },
  expiresAtMs: 1_792_400_000_000,
}

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

let directory: string
let configPath: string
let registryPath: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jaypost-registry-'))
  configPath = join(directory, 'config.json')
  registryPath = join(directory, 'registry.json')
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function writeLegacyState(): void {
  const state = { version: 1, provider: 'telegram', requests: [REQUEST], notifications: [] }
  writeFileSync(join(directory, 'state.json'), JSON.stringify(state))
}

function listTempFiles(path: string): readonly string[] {
  return readdirSync(path).filter((name) => name.endsWith('.tmp'))
}

test('registry, admin key and bot files live next to config.json', () => {
  expect(resolveRegistryPath('/data/config.json')).toBe('/data/registry.json')
  expect(resolveAdminKeyPath('/data/config.json')).toBe('/data/admin-key')
  expect(resolveBotFiles('/data/config.json', 'b2')).toEqual({
    directory: '/data/bots/b2',
    statePath: '/data/bots/b2/state.json',
    auditPath: '/data/bots/b2/audit.jsonl',
  })
})

test('the registry round-trips through the file with mode 0600', () => {
  const store = new RegistryStore(registryPath)
  store.save(REGISTRY)
  expect(new RegistryStore(registryPath).load()).toEqual(REGISTRY)
  expect(readFileSync(registryPath, 'utf8')).toBe(`${JSON.stringify(REGISTRY, null, 2)}\n`)
  expect(statSync(registryPath).mode & 0o777).toBe(0o600)
})

test('fields a newer version adds survive a load and save', () => {
  writeFileSync(registryPath, JSON.stringify({ ...REGISTRY, future: { x: 1 } }))
  const store = new RegistryStore(registryPath)
  store.save(store.load())
  expect(JSON.parse(readFileSync(registryPath, 'utf8'))).toEqual({ ...REGISTRY, future: { x: 1 } })
})

test('a missing registry file loads as an empty registry and writes nothing', () => {
  expect(new RegistryStore(registryPath).load()).toEqual(createEmptyRegistry())
  expect(existsSync(registryPath)).toBe(false)
})

test('a corrupt registry throws without quoting the file', () => {
  writeFileSync(registryPath, '{"bots": [ "jpk_secret"')
  expect(() => new RegistryStore(registryPath).load()).toThrow(/registry .* contains invalid JSON/)
  expect(() => new RegistryStore(registryPath).load()).not.toThrow(/jpk_secret/)
})

test('a registry with invalid fields throws without quoting the file', () => {
  writeFileSync(registryPath, JSON.stringify({ ...REGISTRY, bots: ['jpk_secret'] }))
  expect(() => new RegistryStore(registryPath).load()).toThrow(
    /registry .* has invalid or missing fields/,
  )
  expect(() => new RegistryStore(registryPath).load()).not.toThrow(/jpk_secret/)
})

test('read errors other than a missing file are rethrown', () => {
  mkdirSync(registryPath)
  expect(() => new RegistryStore(registryPath).load()).toThrow(/EISDIR/)
})

test('a failed save leaves the old file', () => {
  const store = new RegistryStore(registryPath)
  store.save(REGISTRY)
  // A directory where the temp file goes makes the write fail before the rename.
  mkdirSync(`${registryPath}.${process.pid}.tmp`)
  expect(() => store.save(createEmptyRegistry())).toThrow()
  expect(new RegistryStore(registryPath).load()).toEqual(REGISTRY)
  expect(statSync(registryPath).mode & 0o777).toBe(0o600)
})

test('migration moves state and both audit files into bots/b1 once', () => {
  writeLegacyState()
  writeFileSync(join(directory, 'audit.jsonl'), 'current\n')
  writeFileSync(join(directory, 'audit.jsonl.1'), 'rotated\n')
  const files = resolveBotFiles(configPath, 'b1')
  migrateLegacyBotFiles(configPath, 'b1')
  expect(readdirSync(directory).toSorted()).toEqual(['bots'])
  expect(readdirSync(files.directory).toSorted()).toEqual([
    'audit.jsonl',
    'audit.jsonl.1',
    'state.json',
  ])
  expect(readFileSync(files.auditPath, 'utf8')).toBe('current\n')
  expect(readFileSync(`${files.auditPath}.1`, 'utf8')).toBe('rotated\n')
  migrateLegacyBotFiles(configPath, 'b1')
  expect(readdirSync(directory).toSorted()).toEqual(['bots'])
  expect(readFileSync(files.auditPath, 'utf8')).toBe('current\n')
  writeFileSync(join(directory, 'audit.jsonl'), 'stray\n')
  migrateLegacyBotFiles(configPath, 'b1')
  expect(readFileSync(files.auditPath, 'utf8')).toBe('current\n')
  expect(readFileSync(join(directory, 'audit.jsonl'), 'utf8')).toBe('stray\n')
})

test('migration moves only the legacy files that exist', () => {
  writeFileSync(join(directory, 'audit.jsonl'), 'current\n')
  migrateLegacyBotFiles(configPath, 'b1')
  expect(readdirSync(resolveBotFiles(configPath, 'b1').directory)).toEqual(['audit.jsonl'])
})

test('migration without legacy files creates nothing', () => {
  migrateLegacyBotFiles(configPath, 'b1')
  expect(readdirSync(directory)).toEqual([])
})

test('pending requests saved before the upgrade are still found after migration', () => {
  writeLegacyState()
  migrateLegacyBotFiles(configPath, 'b1')
  const log = vi.fn()
  const store = new StateStore(resolveBotFiles(configPath, 'b1').statePath, 'telegram', log)
  expect(store.load()).toEqual({ requests: [REQUEST], notifications: [] })
  store.addNotification(NOTIFICATION)
  store.removeRequest('r1')
  expect(store.load()).toEqual({ requests: [], notifications: [NOTIFICATION] })
  expect(existsSync(join(directory, 'state.json'))).toBe(false)
  expect(log).not.toHaveBeenCalled()
})

test('the seed audit path is the seed bot one, or the legacy one without a registry', () => {
  expect(resolveSeedAuditPath(configPath)).toBe(join(directory, 'audit.jsonl'))
  new RegistryStore(registryPath).save({ ...REGISTRY, seed: { ...SEED, botId: 'b3' } })
  expect(resolveSeedAuditPath(configPath)).toBe(join(directory, 'bots', 'b3', 'audit.jsonl'))
})

test('a registry without a seed record gives the legacy audit path', () => {
  const { seed: _seed, ...withoutSeed } = REGISTRY
  new RegistryStore(registryPath).save(withoutSeed)
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
