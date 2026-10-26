import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Provider, ProviderSetting } from '@jaypost/core'
import { afterEach, beforeEach, expect, test } from 'vite-plus/test'
import { DEFAULT_PORT, loadServiceConfig } from '../../src/config/index.ts'
import { hashKey, loadSeed } from '../../src/registry/index.ts'
import type { SeedLoad } from '../../src/registry/index.ts'

const API_TOKEN = 't'.repeat(43)
const OTHER_API_TOKEN = 'u'.repeat(43)
const MUTED_UNTIL = '2026-10-27T08:00:00.000Z'

const parseWord = (raw: unknown) => (typeof raw === 'string' && /^\w+$/.test(raw) ? raw : undefined)

const parseInteger = (raw: unknown) => {
  const value = typeof raw === 'string' ? Number(raw) : raw
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

const BOT_TOKEN_SETTING: ProviderSetting = {
  configKey: 'botToken',
  envVar: 'FAKE_BOT_TOKEN',
  description: 'bot token',
  secret: true,
  owner: false,
  required: true,
  parse: parseWord,
}

const REGION_SETTING: ProviderSetting = {
  configKey: 'region',
  envVar: 'FAKE_REGION',
  description: 'region',
  secret: false,
  owner: false,
  required: false,
  parse: parseWord,
}

const OWNER_SETTING: ProviderSetting = {
  configKey: 'ownerId',
  envVar: 'FAKE_OWNER_ID',
  description: 'owner id',
  secret: false,
  owner: true,
  required: false,
  parse: parseInteger,
}

function createProvider(name: string, settings: readonly ProviderSetting[]): Provider {
  return {
    name,
    label: name,
    maxTextLength: 100,
    settings,
    setup: {
      checkCredentials: async () => ({ ok: true, displayName: name }),
      text: { leftoverFound: '', reusing: () => '', rejected: '' },
    },
    createRuntime: () => {
      throw new Error('not used')
    },
  }
}

const FAKE = createProvider('fake', [BOT_TOKEN_SETTING, REGION_SETTING, OWNER_SETTING])
const PLAIN = createProvider('plain', [BOT_TOKEN_SETTING])
const PROVIDERS = [FAKE, PLAIN]

let directory: string
let configPath: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jaypost-seed-'))
  configPath = join(directory, 'config.json')
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function writeConfig(config: Readonly<Record<string, unknown>>): void {
  writeFileSync(configPath, JSON.stringify(config))
}

function fingerprint(provider: string, settings: object, token: string | null): string {
  return createHash('sha256').update(JSON.stringify({ provider, settings, token })).digest('hex')
}

function loadSeedFor(config: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv = {}) {
  writeConfig(config)
  return loadSeed({ JAYPOST_CONFIG: configPath, ...env }, PROVIDERS)
}

function requireFingerprint(load: SeedLoad): string {
  if (load.kind !== 'seed') {
    throw new Error(`expected a seed, got ${load.kind}`)
  }
  return load.seed.fingerprint
}

test('loadSeed reads bot 1, pairing 1 and key 1 from config.json', () => {
  const load = loadSeedFor({
    provider: 'fake',
    botToken: 'tok',
    region: 'eu',
    ownerId: 7,
    apiToken: API_TOKEN,
    quietHours: '22-7',
    mutedUntil: MUTED_UNTIL,
    port: 9000,
  })
  expect(load).toEqual({
    kind: 'seed',
    provider: FAKE,
    seed: {
      fingerprint: fingerprint('fake', { botToken: 'tok', region: 'eu' }, API_TOKEN),
      provider: 'fake',
      settings: { botToken: 'tok', region: 'eu' },
      owner: '7',
      tokenHash: hashKey(API_TOKEN),
      quietHours: '22:00-07:00',
      mutedUntil: MUTED_UNTIL,
    },
  })
})

test('env values override config.json', () => {
  const load = loadSeedFor(
    { provider: 'plain', botToken: 'tok', apiToken: API_TOKEN },
    {
      JAYPOST_PROVIDER: 'fake',
      FAKE_BOT_TOKEN: 'envtok',
      FAKE_OWNER_ID: '8',
      JAYPOST_TOKEN: OTHER_API_TOKEN,
    },
  )
  expect(load).toEqual({
    kind: 'seed',
    provider: FAKE,
    seed: {
      fingerprint: fingerprint('fake', { botToken: 'envtok' }, OTHER_API_TOKEN),
      provider: 'fake',
      settings: { botToken: 'envtok' },
      owner: '8',
      tokenHash: hashKey(OTHER_API_TOKEN),
    },
  })
})

test('without a token or owner the seed leaves them out and the fingerprint has a null token', () => {
  expect(loadSeedFor({ provider: 'plain', botToken: 'tok', apiToken: '' })).toEqual({
    kind: 'seed',
    provider: PLAIN,
    seed: {
      fingerprint: fingerprint('plain', { botToken: 'tok' }, null),
      provider: 'plain',
      settings: { botToken: 'tok' },
    },
  })
})

test('the fingerprint changes with the token and bot token, not with the owner', () => {
  const base = { provider: 'fake', botToken: 'tok', apiToken: API_TOKEN }
  const original = requireFingerprint(loadSeedFor({ ...base, ownerId: 7 }))
  expect(requireFingerprint(loadSeedFor({ ...base, ownerId: 8 }))).toBe(original)
  expect(requireFingerprint(loadSeedFor(base))).toBe(original)
  expect(requireFingerprint(loadSeedFor({ ...base, quietHours: '1-2' }))).toBe(original)
  expect(requireFingerprint(loadSeedFor({ ...base, apiToken: OTHER_API_TOKEN }))).not.toBe(original)
  expect(requireFingerprint(loadSeedFor({ ...base, apiToken: undefined }))).not.toBe(original)
  expect(requireFingerprint(loadSeedFor({ ...base, botToken: 'other' }))).not.toBe(original)
  expect(requireFingerprint(loadSeedFor({ ...base, provider: 'plain' }))).not.toBe(original)
})

test('a missing bot token is a missing seed, an invalid one throws', () => {
  expect(loadSeedFor({ provider: 'fake' })).toEqual({
    kind: 'missing',
    message: 'missing bot token; run `jaypost init` to set up the bot (or set FAKE_BOT_TOKEN)',
  })
  expect(loadSeedFor({ provider: 'fake', botToken: '' })).toEqual({
    kind: 'missing',
    message: 'missing bot token; run `jaypost init` to set up the bot (or set FAKE_BOT_TOKEN)',
  })
  expect(() => loadSeedFor({ provider: 'fake', botToken: 'bad secret' })).toThrow(
    'invalid bot token; run `jaypost init` to set up the bot (or set FAKE_BOT_TOKEN)',
  )
  expect(() => loadSeedFor({ provider: 'fake', botToken: 'bad secret' })).not.toThrow(/secret/)
})

test('an invalid owner, api token or quiet hours throws', () => {
  const base = { provider: 'fake', botToken: 'tok' }
  expect(() => loadSeedFor({ ...base, ownerId: 'x' })).toThrow(/^invalid owner id;/)
  expect(() => loadSeedFor({ ...base, apiToken: 'short-secret' })).toThrow(/^invalid api token;/)
  expect(() => loadSeedFor({ ...base, apiToken: 'short-secret' })).not.toThrow(/short-secret/)
  expect(() => loadSeedFor({ ...base, quietHours: '25-7' })).toThrow(/^invalid quiet hours "25-7"/)
})

test('an unknown provider throws', () => {
  expect(() => loadSeedFor({ provider: 'nope', botToken: 'tok' })).toThrow(
    /unknown provider "nope"/,
  )
})

test('blank quiet hours and an invalid mutedUntil are left out of the seed', () => {
  const load = loadSeedFor({
    provider: 'plain',
    botToken: 'tok',
    quietHours: '  ',
    mutedUntil: 'never',
  })
  expect(load).toEqual({
    kind: 'seed',
    provider: PLAIN,
    seed: {
      fingerprint: fingerprint('plain', { botToken: 'tok' }, null),
      provider: 'plain',
      settings: { botToken: 'tok' },
    },
  })
})

test('a missing config file with env values is a seed', () => {
  const env = { JAYPOST_CONFIG: configPath, JAYPOST_PROVIDER: 'fake', FAKE_BOT_TOKEN: 'tok' }
  const load = loadSeed(env, PROVIDERS)
  expect(load).toEqual({
    kind: 'seed',
    provider: FAKE,
    seed: {
      fingerprint: fingerprint('fake', { botToken: 'tok' }, null),
      provider: 'fake',
      settings: { botToken: 'tok' },
    },
  })
})

test('loadServiceConfig takes port and host from the env, then config.json, then defaults', () => {
  expect(loadServiceConfig({ JAYPOST_CONFIG: configPath })).toEqual({
    port: DEFAULT_PORT,
    host: '127.0.0.1',
  })
  writeConfig({ port: 9000 })
  expect(loadServiceConfig({ JAYPOST_CONFIG: configPath })).toEqual({
    port: 9000,
    host: '127.0.0.1',
  })
  expect(
    loadServiceConfig({
      JAYPOST_CONFIG: configPath,
      JAYPOST_PORT: '9001',
      JAYPOST_HOST: '0.0.0.0',
    }),
  ).toEqual({ port: 9001, host: '0.0.0.0' })
})

test('loadServiceConfig needs no provider settings', () => {
  writeConfig({ provider: 'nope', port: 9000 })
  expect(loadServiceConfig({ JAYPOST_CONFIG: configPath })).toEqual({
    port: 9000,
    host: '127.0.0.1',
  })
})

test('loadServiceConfig throws on a bad port', () => {
  expect(() => loadServiceConfig({ JAYPOST_CONFIG: configPath, JAYPOST_PORT: '70000' })).toThrow(
    'invalid port "70000": must be an integer 1-65535',
  )
  writeConfig({ port: 1.5 })
  expect(() => loadServiceConfig({ JAYPOST_CONFIG: configPath })).toThrow(
    'invalid port "1.5": must be an integer 1-65535',
  )
})
