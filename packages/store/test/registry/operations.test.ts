import type { Provider, ProviderSetting } from '@jaypost/core'
import { expect, test } from 'vite-plus/test'
import {
  addBot,
  applySeed,
  claimPairing,
  createEmptyRegistry,
  createKey,
  createPairing,
  findKeyByHash,
  removeBot,
  removePairing,
  resetPairing,
  revokeKey,
  updateKey,
  updatePairingQuiet,
} from '../../src/registry/index.ts'
import type { Registry, SeedInput } from '../../src/registry/index.ts'

const AT = new Date('2026-10-26T10:00:00.000Z')
const LATER = new Date('2026-10-27T10:00:00.000Z')
const CREATED = AT.toISOString()
const CREATED_LATER = LATER.toISOString()

const parseString = (raw: unknown) => (typeof raw === 'string' && raw !== '' ? raw : undefined)

const BOT_TOKEN_SETTING: ProviderSetting = {
  configKey: 'botToken',
  envVar: 'BOT_TOKEN',
  description: 'bot token',
  secret: true,
  owner: false,
  required: true,
  parse: parseString,
}

const OWNER_SETTING: ProviderSetting = {
  configKey: 'ownerId',
  envVar: 'OWNER_ID',
  description: 'owner id',
  secret: false,
  owner: true,
  required: false,
  parse: parseString,
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

const TELEGRAM_LIKE = createProvider('telegramlike', [BOT_TOKEN_SETTING, OWNER_SETTING])
const OTHER_TELEGRAM_LIKE = createProvider('othertelegramlike', [BOT_TOKEN_SETTING, OWNER_SETTING])
const TERMINAL_LIKE = createProvider('terminallike', [])

const EMPTY: Registry = {
  version: 1,
  lastIds: { bot: 0, pairing: 0, key: 0 },
  bots: [],
  pairings: [],
  keys: [],
}

const BOT_1 = {
  id: 'b1',
  provider: 'telegramlike',
  settings: { botToken: 't' },
  createdAt: CREATED,
}

const SEED: SeedInput = {
  fingerprint: 'f1',
  provider: 'telegramlike',
  settings: { botToken: 't' },
  owner: '111',
  tokenHash: 'h1',
}

function expectKind<T extends { readonly kind: string }, K extends T['kind']>(
  result: T,
  kind: K,
): Extract<T, { readonly kind: K }> {
  if (result.kind !== kind) {
    throw new Error(`expected ${kind}, got ${JSON.stringify(result)}`)
  }
  return result as Extract<T, { readonly kind: K }>
}

function createBotRegistry(): Registry {
  return expectKind(
    addBot(createEmptyRegistry(), { provider: TELEGRAM_LIKE, settings: { botToken: 't' } }, AT),
    'added',
  ).registry
}

function createTerminalRegistry(): Registry {
  return expectKind(
    addBot(createEmptyRegistry(), { provider: TERMINAL_LIKE, settings: {} }, AT),
    'added',
  ).registry
}

/** Bot b1, pairing p1 claimed by `111` with keys k1 and k2, and pending pairing p2 with key k3. */
function createPairedRegistry(): Registry {
  let registry = createBotRegistry()
  registry = expectKind(
    createKey(registry, { kind: 'newPairing', botId: 'b1' }, 'h1', {}, 'CODE0001', true, AT),
    'created',
  ).registry
  registry = expectKind(claimPairing(registry, 'p1', '111'), 'claimed').registry
  registry = expectKind(
    createKey(registry, { kind: 'pairing', pairingId: 'p1' }, 'h2', {}, 'UNUSED01', true, AT),
    'created',
  ).registry
  return expectKind(
    createKey(registry, { kind: 'newPairing', botId: 'b1' }, 'h3', {}, 'CODE0002', true, AT),
    'created',
  ).registry
}

const PAIRED: Registry = {
  version: 1,
  lastIds: { bot: 1, pairing: 2, key: 3 },
  bots: [BOT_1],
  pairings: [
    { id: 'p1', botId: 'b1', person: '111', createdAt: CREATED },
    { id: 'p2', botId: 'b1', code: 'CODE0002', createdAt: CREATED },
  ],
  keys: [
    { id: 'k1', pairingId: 'p1', hash: 'h1', createdAt: CREATED },
    { id: 'k2', pairingId: 'p1', hash: 'h2', createdAt: CREATED },
    { id: 'k3', pairingId: 'p2', hash: 'h3', createdAt: CREATED },
  ],
}

const SEEDED: Registry = {
  version: 1,
  lastIds: { bot: 1, pairing: 1, key: 1 },
  bots: [BOT_1],
  pairings: [{ id: 'p1', botId: 'b1', person: '111', createdAt: CREATED }],
  keys: [{ id: 'k1', pairingId: 'p1', hash: 'h1', createdAt: CREATED }],
  seed: { fingerprint: 'f1', botId: 'b1', pairingId: 'p1', keyId: 'k1', isOpen: false },
}

function createCodes(...codes: string[]): () => string {
  const remaining = [...codes]
  return () => remaining.shift() ?? 'NOCODE00'
}

test('an empty registry has no records and zeroed ids', () => {
  expect(createEmptyRegistry()).toStrictEqual(EMPTY)
})

test('adding a bot stores it without the owner setting', () => {
  const result = addBot(
    createEmptyRegistry(),
    { provider: TELEGRAM_LIKE, settings: { botToken: 't', ownerId: '111' }, label: 'main' },
    AT,
  )
  const bot = { ...BOT_1, label: 'main' }
  expect(result).toStrictEqual({
    kind: 'added',
    registry: { ...EMPTY, lastIds: { bot: 1, pairing: 0, key: 0 }, bots: [bot] },
    bot,
  })
})

test('a duplicate bot token is refused', () => {
  const registry = createBotRegistry()
  expect(
    addBot(registry, { provider: TELEGRAM_LIKE, settings: { botToken: 't', ownerId: '2' } }, AT),
  ).toStrictEqual({ kind: 'duplicate', botId: 'b1' })
})

test('another token or another provider with the same token is a new bot', () => {
  const registry = createBotRegistry()
  const other = expectKind(
    addBot(registry, { provider: TELEGRAM_LIKE, settings: { botToken: 'u' } }, LATER),
    'added',
  )
  const otherProvider = expectKind(
    addBot(other.registry, { provider: OTHER_TELEGRAM_LIKE, settings: { botToken: 't' } }, LATER),
    'added',
  )
  expect(otherProvider.registry).toStrictEqual({
    ...EMPTY,
    lastIds: { bot: 3, pairing: 0, key: 0 },
    bots: [
      BOT_1,
      { id: 'b2', provider: 'telegramlike', settings: { botToken: 'u' }, createdAt: CREATED_LATER },
      {
        id: 'b3',
        provider: 'othertelegramlike',
        settings: { botToken: 't' },
        createdAt: CREATED_LATER,
      },
    ],
  })
})

test('a pairing on a pairing bot is pending with the code', () => {
  const result = createPairing(createBotRegistry(), 'b1', 'K7QM4XPD', true, AT)
  const pairing = { id: 'p1', botId: 'b1', code: 'K7QM4XPD', createdAt: CREATED }
  expect(result).toStrictEqual({
    kind: 'created',
    registry: {
      ...EMPTY,
      lastIds: { bot: 1, pairing: 1, key: 0 },
      bots: [BOT_1],
      pairings: [pairing],
    },
    pairing,
  })
})

test('a key for a new pairing on a pairing bot is pending with the code', () => {
  const result = createKey(
    createBotRegistry(),
    { kind: 'newPairing', botId: 'b1' },
    'h1',
    {},
    'K7QM4XPD',
    true,
    AT,
  )
  const key = { id: 'k1', pairingId: 'p1', hash: 'h1', createdAt: CREATED }
  const pairing = { id: 'p1', botId: 'b1', code: 'K7QM4XPD', createdAt: CREATED }
  expect(result).toStrictEqual({
    kind: 'created',
    registry: {
      ...EMPTY,
      lastIds: { bot: 1, pairing: 1, key: 1 },
      bots: [BOT_1],
      pairings: [pairing],
      keys: [key],
    },
    key,
    pairing,
  })
})

test('a key for an existing pairing or the same person as a key shares that pairing', () => {
  const byPairing = expectKind(
    createKey(
      createPairedRegistry(),
      { kind: 'pairing', pairingId: 'p2' },
      'h4',
      { label: 'ci', externalId: 'user-7' },
      'UNUSED02',
      true,
      LATER,
    ),
    'created',
  )
  const result = createKey(
    byPairing.registry,
    { kind: 'sameAsKey', keyId: 'k2' },
    'h5',
    {},
    'UNUSED03',
    true,
    LATER,
  )
  const key4 = {
    id: 'k4',
    pairingId: 'p2',
    hash: 'h4',
    label: 'ci',
    externalId: 'user-7',
    createdAt: CREATED_LATER,
  }
  const key5 = { id: 'k5', pairingId: 'p1', hash: 'h5', createdAt: CREATED_LATER }
  expect(byPairing.key).toStrictEqual(key4)
  expect(byPairing.pairing).toStrictEqual(PAIRED.pairings[1])
  expect(result).toStrictEqual({
    kind: 'created',
    registry: {
      ...PAIRED,
      lastIds: { bot: 1, pairing: 2, key: 5 },
      keys: [...PAIRED.keys, key4, key5],
    },
    key: key5,
    pairing: PAIRED.pairings[0],
  })
})

test('creating for an unknown bot, pairing or key is not found', () => {
  const registry = createPairedRegistry()
  expect(createPairing(registry, 'b9', 'CODE0003', true, AT)).toStrictEqual({
    kind: 'notFound',
    what: 'bot',
    id: 'b9',
  })
  expect(
    createKey(registry, { kind: 'newPairing', botId: 'b9' }, 'h', {}, 'CODE0003', true, AT),
  ).toStrictEqual({ kind: 'notFound', what: 'bot', id: 'b9' })
  expect(
    createKey(registry, { kind: 'pairing', pairingId: 'p9' }, 'h', {}, 'CODE0003', true, AT),
  ).toStrictEqual({ kind: 'notFound', what: 'pairing', id: 'p9' })
  expect(
    createKey(registry, { kind: 'sameAsKey', keyId: 'k9' }, 'h', {}, 'CODE0003', true, AT),
  ).toStrictEqual({ kind: 'notFound', what: 'key', id: 'k9' })
})

test('a terminal-like bot gets one local pairing and no code', () => {
  const first = expectKind(
    createPairing(createTerminalRegistry(), 'b1', 'CODE0001', false, AT),
    'created',
  )
  const again = expectKind(createPairing(first.registry, 'b1', 'CODE0002', false, LATER), 'created')
  const result = createKey(
    again.registry,
    { kind: 'newPairing', botId: 'b1' },
    'h1',
    {},
    'CODE0003',
    false,
    LATER,
  )
  const pairing = { id: 'p1', botId: 'b1', person: 'local', createdAt: CREATED }
  const key = { id: 'k1', pairingId: 'p1', hash: 'h1', createdAt: CREATED_LATER }
  expect(again.pairing).toStrictEqual(pairing)
  expect(again.registry).toBe(first.registry)
  expect(result).toStrictEqual({
    kind: 'created',
    registry: {
      ...EMPTY,
      lastIds: { bot: 1, pairing: 1, key: 1 },
      bots: [{ id: 'b1', provider: 'terminallike', settings: {}, createdAt: CREATED }],
      pairings: [pairing],
      keys: [key],
    },
    key,
    pairing,
  })
})

test('redeeming a code sets the person and drops the code', () => {
  const result = claimPairing(createPairedRegistry(), 'p2', '222')
  const pairing = { id: 'p2', botId: 'b1', person: '222', createdAt: CREATED }
  expect(result).toStrictEqual({
    kind: 'claimed',
    registry: { ...PAIRED, pairings: [PAIRED.pairings[0], pairing] },
    pairing,
  })
})

test('redeeming a second code on the same bot moves its keys to the existing pairing', () => {
  const result = claimPairing(createPairedRegistry(), 'p2', '111')
  expect(result).toStrictEqual({
    kind: 'merged',
    registry: {
      ...PAIRED,
      pairings: [PAIRED.pairings[0]],
      keys: [
        ...PAIRED.keys.slice(0, 2),
        { id: 'k3', pairingId: 'p1', hash: 'h3', createdAt: CREATED },
      ],
    },
    pairing: PAIRED.pairings[0],
  })
})

test('the same person on another bot is a separate pairing', () => {
  let registry = expectKind(
    addBot(createPairedRegistry(), { provider: TELEGRAM_LIKE, settings: { botToken: 'u' } }, AT),
    'added',
  ).registry
  registry = expectKind(createPairing(registry, 'b2', 'CODE0003', true, AT), 'created').registry
  const result = claimPairing(registry, 'p3', '111')
  const pairing = { id: 'p3', botId: 'b2', person: '111', createdAt: CREATED }
  expect(result).toStrictEqual({
    kind: 'claimed',
    registry: {
      ...PAIRED,
      lastIds: { bot: 2, pairing: 3, key: 3 },
      bots: [
        BOT_1,
        { id: 'b2', provider: 'telegramlike', settings: { botToken: 'u' }, createdAt: CREATED },
      ],
      pairings: [...PAIRED.pairings, pairing],
    },
    pairing,
  })
})

test('resetting a pairing drops the person and sets a new code', () => {
  const result = resetPairing(createPairedRegistry(), 'p1', 'CODE0009')
  const pairing = { id: 'p1', botId: 'b1', code: 'CODE0009', createdAt: CREATED }
  expect(result).toStrictEqual({
    kind: 'reset',
    registry: { ...PAIRED, pairings: [pairing, PAIRED.pairings[1]] },
    pairing,
  })
})

test('revoking a key leaves its pairing', () => {
  expect(revokeKey(createPairedRegistry(), 'k1')).toStrictEqual({
    kind: 'revoked',
    registry: { ...PAIRED, keys: PAIRED.keys.slice(1) },
  })
})

test('removing a pairing removes its keys and returns their ids', () => {
  expect(removePairing(createPairedRegistry(), 'p1')).toStrictEqual({
    kind: 'removed',
    registry: { ...PAIRED, pairings: [PAIRED.pairings[1]], keys: [PAIRED.keys[2]] },
    keyIds: ['k1', 'k2'],
  })
})

test('removing a bot removes its pairings and their keys', () => {
  const registry = expectKind(
    addBot(createPairedRegistry(), { provider: TELEGRAM_LIKE, settings: { botToken: 'u' } }, AT),
    'added',
  ).registry
  const bot2 = {
    id: 'b2',
    provider: 'telegramlike',
    settings: { botToken: 'u' },
    createdAt: CREATED,
  }
  expect(removeBot(registry, 'b1')).toStrictEqual({
    kind: 'removed',
    registry: { ...EMPTY, lastIds: { bot: 2, pairing: 2, key: 3 }, bots: [bot2] },
    keyIds: ['k1', 'k2', 'k3'],
  })
})

test('ids are never reused after a removal', () => {
  const removed = expectKind(revokeKey(createPairedRegistry(), 'k3'), 'revoked')
  const result = createKey(
    removed.registry,
    { kind: 'pairing', pairingId: 'p2' },
    'h4',
    {},
    'UNUSED04',
    true,
    AT,
  )
  const key = { id: 'k4', pairingId: 'p2', hash: 'h4', createdAt: CREATED }
  expect(result).toStrictEqual({
    kind: 'created',
    registry: {
      ...PAIRED,
      lastIds: { bot: 1, pairing: 2, key: 4 },
      keys: [...PAIRED.keys.slice(0, 2), key],
    },
    key,
    pairing: PAIRED.pairings[1],
  })
})

test('updating a key sets given fields and deletes null ones', () => {
  const labeled = expectKind(
    updateKey(createPairedRegistry(), 'k2', { label: 'ci', externalId: 'user-7' }),
    'updated',
  )
  const result = updateKey(labeled.registry, 'k2', { label: null })
  const key = { id: 'k2', pairingId: 'p1', hash: 'h2', externalId: 'user-7', createdAt: CREATED }
  expect(result).toStrictEqual({
    kind: 'updated',
    registry: { ...PAIRED, keys: [PAIRED.keys[0], key, PAIRED.keys[2]] },
    key,
  })
})

test('removing, resetting, revoking or updating something unknown is not found', () => {
  const registry = createPairedRegistry()
  expect(removeBot(registry, 'b9')).toStrictEqual({ kind: 'notFound', what: 'bot', id: 'b9' })
  expect(removePairing(registry, 'p9')).toStrictEqual({
    kind: 'notFound',
    what: 'pairing',
    id: 'p9',
  })
  expect(claimPairing(registry, 'p9', '1')).toStrictEqual({
    kind: 'notFound',
    what: 'pairing',
    id: 'p9',
  })
  expect(resetPairing(registry, 'p9', 'C')).toStrictEqual({
    kind: 'notFound',
    what: 'pairing',
    id: 'p9',
  })
  expect(revokeKey(registry, 'k9')).toStrictEqual({ kind: 'notFound', what: 'key', id: 'k9' })
  expect(updateKey(registry, 'k9', {})).toStrictEqual({ kind: 'notFound', what: 'key', id: 'k9' })
})

test('quiet settings are set and deleted per pairing', () => {
  const quiet = updatePairingQuiet(createPairedRegistry(), 'p1', {
    quietHours: '22:00-07:00',
    mutedUntil: '2026-10-27T10:00:00.000Z',
  })
  const result = updatePairingQuiet(quiet, 'p1', { mutedUntil: null })
  const pairing = { ...PAIRED.pairings[0], quietHours: '22:00-07:00' }
  expect(result).toStrictEqual({ ...PAIRED, pairings: [pairing, PAIRED.pairings[1]] })
})

test('quiet settings for an unknown pairing leave the registry as it was', () => {
  const registry = createPairedRegistry()
  expect(updatePairingQuiet(registry, 'p9', { quietHours: '22:00-07:00' })).toBe(registry)
})

test('a key is found by its hash', () => {
  const registry = createPairedRegistry()
  expect(findKeyByHash(registry, 'h2')).toStrictEqual(PAIRED.keys[1])
  expect(findKeyByHash(registry, 'h9')).toBeUndefined()
})

test('seeding an empty registry makes bot 1, pairing 1 and key 1', () => {
  const result = applySeed(
    createEmptyRegistry(),
    { ...SEED, quietHours: '22:00-07:00', mutedUntil: '2026-10-27T10:00:00.000Z' },
    true,
    createCodes('CODE0001'),
    AT,
  )
  expect(result).toStrictEqual({
    registry: {
      ...SEEDED,
      pairings: [
        {
          ...SEEDED.pairings[0],
          quietHours: '22:00-07:00',
          mutedUntil: '2026-10-27T10:00:00.000Z',
        },
      ],
    },
    isNew: true,
  })
})

test('seeding without an owner or a token makes a pending pairing and an open key 1', () => {
  const { owner: _owner, tokenHash: _tokenHash, ...seed } = SEED
  expect(applySeed(createEmptyRegistry(), seed, true, createCodes('CODE0001'), AT)).toStrictEqual({
    registry: {
      ...SEEDED,
      pairings: [{ id: 'p1', botId: 'b1', code: 'CODE0001', createdAt: CREATED }],
      keys: [{ id: 'k1', pairingId: 'p1', createdAt: CREATED }],
      seed: { ...SEEDED.seed, isOpen: true },
    },
    isNew: true,
  })
})

test('seeding a terminal-like provider makes a local pairing', () => {
  const seed = { fingerprint: 'f1', provider: 'terminallike', settings: {}, owner: '111' }
  expect(applySeed(createEmptyRegistry(), seed, false, createCodes('CODE0001'), AT)).toStrictEqual({
    registry: {
      ...SEEDED,
      bots: [{ id: 'b1', provider: 'terminallike', settings: {}, createdAt: CREATED }],
      pairings: [{ id: 'p1', botId: 'b1', person: 'local', createdAt: CREATED }],
      keys: [{ id: 'k1', pairingId: 'p1', createdAt: CREATED }],
      seed: { ...SEEDED.seed, isOpen: true },
    },
    isNew: true,
  })
})

test('seeding with the same fingerprint changes nothing, even after admin removed key 1', () => {
  const seeded = applySeed(createEmptyRegistry(), SEED, true, createCodes(), AT).registry
  const revoked = expectKind(revokeKey(seeded, 'k1'), 'revoked').registry
  const result = applySeed(revoked, { ...SEED, tokenHash: 'h9' }, true, createCodes(), LATER)
  expect(result.registry).toBe(revoked)
  expect(result).toStrictEqual({ registry: { ...SEEDED, keys: [] }, isNew: false })
})

test('seeding with a new fingerprint updates bot 1 and key 1 and keeps other keys', () => {
  let registry = applySeed(createEmptyRegistry(), SEED, true, createCodes(), AT).registry
  registry = expectKind(
    createKey(registry, { kind: 'pairing', pairingId: 'p1' }, 'h2', {}, 'UNUSED01', true, AT),
    'created',
  ).registry
  const result = applySeed(
    registry,
    { ...SEED, fingerprint: 'f2', settings: { botToken: 'u' }, owner: '222', tokenHash: 'h9' },
    true,
    createCodes(),
    LATER,
  )
  expect(result).toStrictEqual({
    registry: {
      ...SEEDED,
      lastIds: { bot: 1, pairing: 1, key: 2 },
      bots: [{ ...BOT_1, settings: { botToken: 'u' } }],
      keys: [
        { id: 'k1', pairingId: 'p1', hash: 'h9', createdAt: CREATED },
        { id: 'k2', pairingId: 'p1', hash: 'h2', createdAt: CREATED },
      ],
      seed: { ...SEEDED.seed, fingerprint: 'f2' },
    },
    isNew: false,
  })
})

test('seeding with a new fingerprint and no token opens key 1', () => {
  const registry = applySeed(createEmptyRegistry(), SEED, true, createCodes(), AT).registry
  const { tokenHash: _tokenHash, ...seed } = SEED
  expect(
    applySeed(registry, { ...seed, fingerprint: 'f2' }, true, createCodes(), LATER),
  ).toStrictEqual({
    registry: {
      ...SEEDED,
      keys: [{ id: 'k1', pairingId: 'p1', createdAt: CREATED }],
      seed: { ...SEEDED.seed, fingerprint: 'f2', isOpen: true },
    },
    isNew: false,
  })
})

test('seeding with a new fingerprint re-creates a revoked key 1 under a new id', () => {
  const seeded = applySeed(createEmptyRegistry(), SEED, true, createCodes(), AT).registry
  const revoked = expectKind(revokeKey(seeded, 'k1'), 'revoked').registry
  const result = applySeed(revoked, { ...SEED, fingerprint: 'f2' }, true, createCodes(), LATER)
  expect(result).toStrictEqual({
    registry: {
      ...SEEDED,
      lastIds: { bot: 1, pairing: 1, key: 2 },
      keys: [{ id: 'k2', pairingId: 'p1', hash: 'h1', createdAt: CREATED_LATER }],
      seed: { ...SEEDED.seed, fingerprint: 'f2', keyId: 'k2' },
    },
    isNew: false,
  })
})

test('seeding with a new fingerprint re-creates a removed bot 1 with its pairing and key', () => {
  const seeded = applySeed(createEmptyRegistry(), SEED, true, createCodes(), AT).registry
  const removed = expectKind(removeBot(seeded, 'b1'), 'removed').registry
  const result = applySeed(removed, { ...SEED, fingerprint: 'f2' }, true, createCodes(), LATER)
  expect(result).toStrictEqual({
    registry: {
      ...SEEDED,
      lastIds: { bot: 2, pairing: 2, key: 2 },
      bots: [{ ...BOT_1, id: 'b2', createdAt: CREATED_LATER }],
      pairings: [{ id: 'p2', botId: 'b2', person: '111', createdAt: CREATED_LATER }],
      keys: [{ id: 'k2', pairingId: 'p2', hash: 'h1', createdAt: CREATED_LATER }],
      seed: { fingerprint: 'f2', botId: 'b2', pairingId: 'p2', keyId: 'k2', isOpen: false },
    },
    isNew: false,
  })
})

test('seeding with a new fingerprint sets the owner only on a pending seed pairing', () => {
  const { owner: _owner, ...seed } = SEED
  const pending = applySeed(createEmptyRegistry(), seed, true, createCodes('CODE0001'), AT)
  const result = applySeed(
    pending.registry,
    { ...SEED, fingerprint: 'f2' },
    true,
    createCodes(),
    LATER,
  )
  expect(result).toStrictEqual({
    registry: { ...SEEDED, seed: { ...SEEDED.seed, fingerprint: 'f2' } },
    isNew: false,
  })
})

test('seeding a different provider resets the bot pairings', () => {
  let registry = applySeed(createEmptyRegistry(), SEED, true, createCodes(), AT).registry
  registry = expectKind(
    createKey(registry, { kind: 'newPairing', botId: 'b1' }, 'h2', {}, 'CODE0001', true, AT),
    'created',
  ).registry
  registry = expectKind(claimPairing(registry, 'p2', '222'), 'claimed').registry
  const { owner: _owner, ...seed } = SEED
  const result = applySeed(
    registry,
    { ...seed, fingerprint: 'f2', provider: 'othertelegramlike' },
    true,
    createCodes('CODE0002', 'CODE0003'),
    LATER,
  )
  expect(result).toStrictEqual({
    registry: {
      ...SEEDED,
      lastIds: { bot: 1, pairing: 2, key: 2 },
      bots: [{ ...BOT_1, provider: 'othertelegramlike' }],
      pairings: [
        { id: 'p1', botId: 'b1', code: 'CODE0002', createdAt: CREATED },
        { id: 'p2', botId: 'b1', code: 'CODE0003', createdAt: CREATED },
      ],
      keys: [...SEEDED.keys, { id: 'k2', pairingId: 'p2', hash: 'h2', createdAt: CREATED }],
      seed: { ...SEEDED.seed, fingerprint: 'f2' },
    },
    isNew: false,
  })
})

test('seeding a provider that does not pair moves every key to one local pairing', () => {
  let registry = applySeed(createEmptyRegistry(), SEED, true, createCodes(), AT).registry
  registry = expectKind(
    createKey(registry, { kind: 'newPairing', botId: 'b1' }, 'h2', {}, 'CODE0001', true, AT),
    'created',
  ).registry
  const result = applySeed(
    registry,
    { fingerprint: 'f2', provider: 'terminallike', settings: {}, tokenHash: 'h1' },
    false,
    createCodes(),
    LATER,
  )
  expect(result).toStrictEqual({
    registry: {
      ...SEEDED,
      lastIds: { bot: 1, pairing: 2, key: 2 },
      bots: [{ ...BOT_1, provider: 'terminallike', settings: {} }],
      pairings: [{ id: 'p1', botId: 'b1', person: 'local', createdAt: CREATED }],
      keys: [...SEEDED.keys, { id: 'k2', pairingId: 'p1', hash: 'h2', createdAt: CREATED }],
      seed: { ...SEEDED.seed, fingerprint: 'f2' },
    },
    isNew: false,
  })
})
