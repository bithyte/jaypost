import type { Provider, ProviderSetting } from '@jaypost/core'
import { expect, test } from 'vite-plus/test'
import {
  addBot,
  applySeed,
  claimCode,
  claimContact,
  createEmptyRegistry,
  createKey,
  createContact,
  removeBot,
  removeContact,
  resetContact,
  revokeKey,
  updateKey,
  updateContactQuiet,
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
  lastIds: { bot: 0, contact: 0, key: 0 },
  bots: [],
  contacts: [],
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

/** Bot b1, contact c1 claimed by `111` with keys k1 and k2, and pending contact c2 with key k3. */
function createPairedRegistry(): Registry {
  let registry = createBotRegistry()
  registry = expectKind(
    createKey(registry, { kind: 'newContact', botId: 'b1' }, 'h1', {}, 'CODE0001', true, AT),
    'created',
  ).registry
  registry = expectKind(claimContact(registry, 'b1', 'c1', '111'), 'claimed').registry
  registry = expectKind(
    createKey(registry, { kind: 'contact', contactId: 'c1' }, 'h2', {}, 'UNUSED01', true, AT),
    'created',
  ).registry
  return expectKind(
    createKey(registry, { kind: 'newContact', botId: 'b1' }, 'h3', {}, 'CODE0002', true, AT),
    'created',
  ).registry
}

const PAIRED: Registry = {
  version: 1,
  lastIds: { bot: 1, contact: 2, key: 3 },
  bots: [BOT_1],
  contacts: [
    { id: 'c1', botId: 'b1', person: '111', createdAt: CREATED },
    { id: 'c2', botId: 'b1', code: 'CODE0002', createdAt: CREATED },
  ],
  keys: [
    { id: 'k1', contactId: 'c1', hash: 'h1', createdAt: CREATED },
    { id: 'k2', contactId: 'c1', hash: 'h2', createdAt: CREATED },
    { id: 'k3', contactId: 'c2', hash: 'h3', createdAt: CREATED },
  ],
}

const SEEDED: Registry = {
  version: 1,
  lastIds: { bot: 1, contact: 1, key: 1 },
  bots: [BOT_1],
  contacts: [{ id: 'c1', botId: 'b1', person: '111', createdAt: CREATED }],
  keys: [{ id: 'k1', contactId: 'c1', hash: 'h1', createdAt: CREATED }],
  seed: { fingerprint: 'f1', botId: 'b1', contactId: 'c1', keyId: 'k1', isOpen: false },
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
    registry: { ...EMPTY, lastIds: { bot: 1, contact: 0, key: 0 }, bots: [bot] },
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
    lastIds: { bot: 3, contact: 0, key: 0 },
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

test('a contact on a pairing bot is pending with the code', () => {
  const result = createContact(createBotRegistry(), 'b1', 'K7QM4XPD', true, AT)
  const contact = { id: 'c1', botId: 'b1', code: 'K7QM4XPD', createdAt: CREATED }
  expect(result).toStrictEqual({
    kind: 'created',
    registry: {
      ...EMPTY,
      lastIds: { bot: 1, contact: 1, key: 0 },
      bots: [BOT_1],
      contacts: [contact],
    },
    contact,
  })
})

test('a key for a new contact on a pairing bot is pending with the code', () => {
  const result = createKey(
    createBotRegistry(),
    { kind: 'newContact', botId: 'b1' },
    'h1',
    {},
    'K7QM4XPD',
    true,
    AT,
  )
  const key = { id: 'k1', contactId: 'c1', hash: 'h1', createdAt: CREATED }
  const contact = { id: 'c1', botId: 'b1', code: 'K7QM4XPD', createdAt: CREATED }
  expect(result).toStrictEqual({
    kind: 'created',
    registry: {
      ...EMPTY,
      lastIds: { bot: 1, contact: 1, key: 1 },
      bots: [BOT_1],
      contacts: [contact],
      keys: [key],
    },
    key,
    contact,
  })
})

test('a key for an existing contact or the same person as a key shares that contact', () => {
  const byContact = expectKind(
    createKey(
      createPairedRegistry(),
      { kind: 'contact', contactId: 'c2' },
      'h4',
      { label: 'ci', externalId: 'user-7' },
      'UNUSED02',
      true,
      LATER,
    ),
    'created',
  )
  const result = createKey(
    byContact.registry,
    { kind: 'sameAsKey', keyId: 'k2' },
    'h5',
    {},
    'UNUSED03',
    true,
    LATER,
  )
  const key4 = {
    id: 'k4',
    contactId: 'c2',
    hash: 'h4',
    label: 'ci',
    externalId: 'user-7',
    createdAt: CREATED_LATER,
  }
  const key5 = { id: 'k5', contactId: 'c1', hash: 'h5', createdAt: CREATED_LATER }
  expect(byContact.key).toStrictEqual(key4)
  expect(byContact.contact).toStrictEqual(PAIRED.contacts[1])
  expect(result).toStrictEqual({
    kind: 'created',
    registry: {
      ...PAIRED,
      lastIds: { bot: 1, contact: 2, key: 5 },
      keys: [...PAIRED.keys, key4, key5],
    },
    key: key5,
    contact: PAIRED.contacts[0],
  })
})

test('creating for an unknown bot, contact or key is not found', () => {
  const registry = createPairedRegistry()
  expect(createContact(registry, 'b9', 'CODE0003', true, AT)).toStrictEqual({
    kind: 'notFound',
    what: 'bot',
    id: 'b9',
  })
  expect(
    createKey(registry, { kind: 'newContact', botId: 'b9' }, 'h', {}, 'CODE0003', true, AT),
  ).toStrictEqual({ kind: 'notFound', what: 'bot', id: 'b9' })
  expect(
    createKey(registry, { kind: 'contact', contactId: 'c9' }, 'h', {}, 'CODE0003', true, AT),
  ).toStrictEqual({ kind: 'notFound', what: 'contact', id: 'c9' })
  expect(
    createKey(registry, { kind: 'sameAsKey', keyId: 'k9' }, 'h', {}, 'CODE0003', true, AT),
  ).toStrictEqual({ kind: 'notFound', what: 'key', id: 'k9' })
})

test('contact ids use the c prefix and keep counting', () => {
  const botId = 'b1'
  const first = expectKind(
    createContact(createBotRegistry(), botId, 'CODE1111', true, AT),
    'created',
  )
  const second = expectKind(createContact(first.registry, botId, 'CODE2222', true, AT), 'created')
  expect([first.contact.id, second.contact.id]).toEqual(['c1', 'c2'])
  expect(second.registry.lastIds.contact).toBe(2)
})

test('a terminal-like bot gets one local contact and no code', () => {
  const first = expectKind(
    createContact(createTerminalRegistry(), 'b1', 'CODE0001', false, AT),
    'created',
  )
  const again = expectKind(createContact(first.registry, 'b1', 'CODE0002', false, LATER), 'created')
  const result = createKey(
    again.registry,
    { kind: 'newContact', botId: 'b1' },
    'h1',
    {},
    'CODE0003',
    false,
    LATER,
  )
  const contact = { id: 'c1', botId: 'b1', person: 'local', createdAt: CREATED }
  const key = { id: 'k1', contactId: 'c1', hash: 'h1', createdAt: CREATED_LATER }
  expect(again.contact).toStrictEqual(contact)
  expect(again.registry).toBe(first.registry)
  expect(result).toStrictEqual({
    kind: 'created',
    registry: {
      ...EMPTY,
      lastIds: { bot: 1, contact: 1, key: 1 },
      bots: [{ id: 'b1', provider: 'terminallike', settings: {}, createdAt: CREATED }],
      contacts: [contact],
      keys: [key],
    },
    key,
    contact,
  })
})

test('redeeming a code sets the person and drops the code', () => {
  const result = claimContact(createPairedRegistry(), 'b1', 'c2', '222')
  const contact = { id: 'c2', botId: 'b1', person: '222', createdAt: CREATED }
  expect(result).toStrictEqual({
    kind: 'claimed',
    registry: { ...PAIRED, contacts: [PAIRED.contacts[0], contact] },
    contact,
  })
})

test('redeeming a second code on the same bot moves its keys to the existing contact', () => {
  const result = claimContact(createPairedRegistry(), 'b1', 'c2', '111')
  expect(result).toStrictEqual({
    kind: 'merged',
    registry: {
      ...PAIRED,
      contacts: [PAIRED.contacts[0]],
      keys: [
        ...PAIRED.keys.slice(0, 2),
        { id: 'k3', contactId: 'c1', hash: 'h3', createdAt: CREATED },
      ],
    },
    contact: PAIRED.contacts[0],
  })
})

test('the same person on another bot is a separate contact', () => {
  let registry = expectKind(
    addBot(createPairedRegistry(), { provider: TELEGRAM_LIKE, settings: { botToken: 'u' } }, AT),
    'added',
  ).registry
  registry = expectKind(createContact(registry, 'b2', 'CODE0003', true, AT), 'created').registry
  const result = claimContact(registry, 'b2', 'c3', '111')
  const contact = { id: 'c3', botId: 'b2', person: '111', createdAt: CREATED }
  expect(result).toStrictEqual({
    kind: 'claimed',
    registry: {
      ...PAIRED,
      lastIds: { bot: 2, contact: 3, key: 3 },
      bots: [
        BOT_1,
        { id: 'b2', provider: 'telegramlike', settings: { botToken: 'u' }, createdAt: CREATED },
      ],
      contacts: [...PAIRED.contacts, contact],
    },
    contact,
  })
})

test('a code claims the pending contact that has it, case, dashes and spaces ignored', () => {
  const result = claimCode(createPairedRegistry(), 'b1', ' code-0002 ', '222')
  expect(result).toStrictEqual(claimContact(createPairedRegistry(), 'b1', 'c2', '222'))
  expect(result).toMatchObject({ kind: 'claimed', contact: { id: 'c2', person: '222' } })
})

test('a code sent by someone already paired on the bot merges into their contact', () => {
  const result = claimCode(createPairedRegistry(), 'b1', 'CODE0002', '111')
  expect(result).toStrictEqual(claimContact(createPairedRegistry(), 'b1', 'c2', '111'))
  expect(result).toMatchObject({ kind: 'merged', contact: { id: 'c1' } })
})

test('a code that is spent, unknown or on another bot is wrong', () => {
  let registry = expectKind(
    addBot(createPairedRegistry(), { provider: TELEGRAM_LIKE, settings: { botToken: 'u' } }, AT),
    'added',
  ).registry
  registry = expectKind(createContact(registry, 'b2', 'CODE0003', true, AT), 'created').registry
  expect(claimCode(registry, 'b1', 'CODE0001', '999')).toStrictEqual({ kind: 'wrong' })
  expect(claimCode(registry, 'b1', 'CODE0009', '999')).toStrictEqual({ kind: 'wrong' })
  expect(claimCode(registry, 'b1', 'CODE0003', '999')).toStrictEqual({ kind: 'wrong' })
})

test('a bot with no pending contact has no codes', () => {
  const registry = expectKind(
    claimCode(createPairedRegistry(), 'b1', 'CODE0002', '222'),
    'claimed',
  ).registry
  expect(claimCode(registry, 'b1', 'CODE0002', '333')).toStrictEqual({ kind: 'noCodes' })
  expect(claimCode(registry, 'b9', 'CODE0002', '333')).toStrictEqual({ kind: 'noCodes' })
})

test('resetting a contact drops the person and sets a new code', () => {
  const result = resetContact(createPairedRegistry(), 'c1', 'CODE0009', true)
  const contact = { id: 'c1', botId: 'b1', code: 'CODE0009', createdAt: CREATED }
  expect(result).toStrictEqual({
    kind: 'reset',
    registry: { ...PAIRED, contacts: [contact, PAIRED.contacts[1]] },
    contact,
  })
})

test('a claim of a contact that already has a person is not pending', () => {
  expect(claimContact(createPairedRegistry(), 'b1', 'c1', '999')).toStrictEqual({
    kind: 'notPending',
  })
})

test('a claim of a contact on another bot is not pending', () => {
  expect(claimContact(createPairedRegistry(), 'b2', 'c2', '222')).toStrictEqual({
    kind: 'notPending',
  })
})

test('resetting a contact on a bot that does not pair is refused', () => {
  expect(resetContact(createPairedRegistry(), 'c1', 'CODE0009', false)).toStrictEqual({
    kind: 'notPairing',
    botId: 'b1',
  })
})

test('revoking a key leaves its contact', () => {
  expect(revokeKey(createPairedRegistry(), 'k1')).toStrictEqual({
    kind: 'revoked',
    registry: { ...PAIRED, keys: PAIRED.keys.slice(1) },
  })
})

test('removing a contact removes its keys and returns their ids', () => {
  expect(removeContact(createPairedRegistry(), 'c1')).toStrictEqual({
    kind: 'removed',
    registry: { ...PAIRED, contacts: [PAIRED.contacts[1]], keys: [PAIRED.keys[2]] },
    keyIds: ['k1', 'k2'],
  })
})

test('removing a bot removes its contacts and their keys', () => {
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
    registry: { ...EMPTY, lastIds: { bot: 2, contact: 2, key: 3 }, bots: [bot2] },
    keyIds: ['k1', 'k2', 'k3'],
  })
})

test('ids are never reused after a removal', () => {
  const removed = expectKind(revokeKey(createPairedRegistry(), 'k3'), 'revoked')
  const result = createKey(
    removed.registry,
    { kind: 'contact', contactId: 'c2' },
    'h4',
    {},
    'UNUSED04',
    true,
    AT,
  )
  const key = { id: 'k4', contactId: 'c2', hash: 'h4', createdAt: CREATED }
  expect(result).toStrictEqual({
    kind: 'created',
    registry: {
      ...PAIRED,
      lastIds: { bot: 1, contact: 2, key: 4 },
      keys: [...PAIRED.keys.slice(0, 2), key],
    },
    key,
    contact: PAIRED.contacts[1],
  })
})

test('updating a key sets given fields and deletes null ones', () => {
  const labeled = expectKind(
    updateKey(createPairedRegistry(), 'k2', { label: 'ci', externalId: 'user-7' }),
    'updated',
  )
  const result = updateKey(labeled.registry, 'k2', { label: null })
  const key = { id: 'k2', contactId: 'c1', hash: 'h2', externalId: 'user-7', createdAt: CREATED }
  expect(result).toStrictEqual({
    kind: 'updated',
    registry: { ...PAIRED, keys: [PAIRED.keys[0], key, PAIRED.keys[2]] },
    key,
  })
})

test('removing, resetting, revoking or updating something unknown is not found', () => {
  const registry = createPairedRegistry()
  expect(removeBot(registry, 'b9')).toStrictEqual({ kind: 'notFound', what: 'bot', id: 'b9' })
  expect(removeContact(registry, 'c9')).toStrictEqual({
    kind: 'notFound',
    what: 'contact',
    id: 'c9',
  })
  expect(claimContact(registry, 'b1', 'c9', '1')).toStrictEqual({ kind: 'notPending' })
  expect(resetContact(registry, 'c9', 'C', true)).toStrictEqual({
    kind: 'notFound',
    what: 'contact',
    id: 'c9',
  })
  expect(revokeKey(registry, 'k9')).toStrictEqual({ kind: 'notFound', what: 'key', id: 'k9' })
  expect(updateKey(registry, 'k9', {})).toStrictEqual({ kind: 'notFound', what: 'key', id: 'k9' })
})

test('quiet settings are set and deleted per contact', () => {
  const quiet = updateContactQuiet(createPairedRegistry(), 'c1', {
    quietHours: '22:00-07:00',
    mutedUntil: '2026-10-27T10:00:00.000Z',
  })
  const result = updateContactQuiet(quiet, 'c1', { mutedUntil: null })
  const contact = { ...PAIRED.contacts[0], quietHours: '22:00-07:00' }
  expect(result).toStrictEqual({ ...PAIRED, contacts: [contact, PAIRED.contacts[1]] })
})

test('quiet settings for an unknown contact leave the registry as it was', () => {
  const registry = createPairedRegistry()
  expect(updateContactQuiet(registry, 'c9', { quietHours: '22:00-07:00' })).toBe(registry)
})

test('seeding an empty registry makes bot 1, contact 1 and key 1', () => {
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
      contacts: [
        {
          ...SEEDED.contacts[0],
          quietHours: '22:00-07:00',
          mutedUntil: '2026-10-27T10:00:00.000Z',
        },
      ],
    },
    isNew: true,
  })
})

test('seeding without an owner or a token makes a pending contact and an open key 1', () => {
  const { owner: _owner, tokenHash: _tokenHash, ...seed } = SEED
  expect(applySeed(createEmptyRegistry(), seed, true, createCodes('CODE0001'), AT)).toStrictEqual({
    registry: {
      ...SEEDED,
      contacts: [{ id: 'c1', botId: 'b1', code: 'CODE0001', createdAt: CREATED }],
      keys: [{ id: 'k1', contactId: 'c1', createdAt: CREATED }],
      seed: { ...SEEDED.seed, isOpen: true },
    },
    isNew: true,
  })
})

test('seeding a terminal-like provider makes a local contact', () => {
  const seed = { fingerprint: 'f1', provider: 'terminallike', settings: {}, owner: '111' }
  expect(applySeed(createEmptyRegistry(), seed, false, createCodes('CODE0001'), AT)).toStrictEqual({
    registry: {
      ...SEEDED,
      bots: [{ id: 'b1', provider: 'terminallike', settings: {}, createdAt: CREATED }],
      contacts: [{ id: 'c1', botId: 'b1', person: 'local', createdAt: CREATED }],
      keys: [{ id: 'k1', contactId: 'c1', createdAt: CREATED }],
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
    createKey(registry, { kind: 'contact', contactId: 'c1' }, 'h2', {}, 'UNUSED01', true, AT),
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
      lastIds: { bot: 1, contact: 1, key: 2 },
      bots: [{ ...BOT_1, settings: { botToken: 'u' } }],
      keys: [
        { id: 'k1', contactId: 'c1', hash: 'h9', createdAt: CREATED },
        { id: 'k2', contactId: 'c1', hash: 'h2', createdAt: CREATED },
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
      keys: [{ id: 'k1', contactId: 'c1', createdAt: CREATED }],
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
      lastIds: { bot: 1, contact: 1, key: 2 },
      keys: [{ id: 'k2', contactId: 'c1', hash: 'h1', createdAt: CREATED_LATER }],
      seed: { ...SEEDED.seed, fingerprint: 'f2', keyId: 'k2' },
    },
    isNew: false,
  })
})

test('seeding with a new fingerprint re-creates a removed bot 1 with its contact and key', () => {
  const seeded = applySeed(createEmptyRegistry(), SEED, true, createCodes(), AT).registry
  const removed = expectKind(removeBot(seeded, 'b1'), 'removed').registry
  const result = applySeed(removed, { ...SEED, fingerprint: 'f2' }, true, createCodes(), LATER)
  expect(result).toStrictEqual({
    registry: {
      ...SEEDED,
      lastIds: { bot: 2, contact: 2, key: 2 },
      bots: [{ ...BOT_1, id: 'b2', createdAt: CREATED_LATER }],
      contacts: [{ id: 'c2', botId: 'b2', person: '111', createdAt: CREATED_LATER }],
      keys: [{ id: 'k2', contactId: 'c2', hash: 'h1', createdAt: CREATED_LATER }],
      seed: { fingerprint: 'f2', botId: 'b2', contactId: 'c2', keyId: 'k2', isOpen: false },
    },
    isNew: false,
  })
})

test('seeding with a new fingerprint sets the owner only on a pending seed contact', () => {
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

test('seeding a different provider resets the bot contacts', () => {
  let registry = applySeed(createEmptyRegistry(), SEED, true, createCodes(), AT).registry
  registry = expectKind(
    createKey(registry, { kind: 'newContact', botId: 'b1' }, 'h2', {}, 'CODE0001', true, AT),
    'created',
  ).registry
  registry = expectKind(claimContact(registry, 'b1', 'c2', '222'), 'claimed').registry
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
      lastIds: { bot: 1, contact: 2, key: 2 },
      bots: [{ ...BOT_1, provider: 'othertelegramlike' }],
      contacts: [
        { id: 'c1', botId: 'b1', code: 'CODE0002', createdAt: CREATED },
        { id: 'c2', botId: 'b1', code: 'CODE0003', createdAt: CREATED },
      ],
      keys: [...SEEDED.keys, { id: 'k2', contactId: 'c2', hash: 'h2', createdAt: CREATED }],
      seed: { ...SEEDED.seed, fingerprint: 'f2' },
    },
    isNew: false,
  })
})

test('seeding a provider that does not pair moves every key to one local contact', () => {
  let registry = applySeed(createEmptyRegistry(), SEED, true, createCodes(), AT).registry
  registry = expectKind(
    createKey(registry, { kind: 'newContact', botId: 'b1' }, 'h2', {}, 'CODE0001', true, AT),
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
      lastIds: { bot: 1, contact: 2, key: 2 },
      bots: [{ ...BOT_1, provider: 'terminallike', settings: {} }],
      contacts: [{ id: 'c1', botId: 'b1', person: 'local', createdAt: CREATED }],
      keys: [...SEEDED.keys, { id: 'k2', contactId: 'c1', hash: 'h2', createdAt: CREATED }],
      seed: { ...SEEDED.seed, fingerprint: 'f2' },
    },
    isNew: false,
  })
})

test('seeding with a new fingerprint reuses the owner contact when the seed contact is gone', () => {
  let registry = applySeed(createEmptyRegistry(), SEED, true, createCodes(), AT).registry
  registry = expectKind(removeContact(registry, 'c1'), 'removed').registry
  registry = expectKind(
    createKey(registry, { kind: 'newContact', botId: 'b1' }, 'h2', {}, 'CODE0001', true, AT),
    'created',
  ).registry
  registry = expectKind(claimContact(registry, 'b1', 'c2', '111'), 'claimed').registry
  const result = applySeed(registry, { ...SEED, fingerprint: 'f2' }, true, createCodes(), LATER)
  expect(result).toStrictEqual({
    registry: {
      ...SEEDED,
      lastIds: { bot: 1, contact: 2, key: 3 },
      contacts: [{ id: 'c2', botId: 'b1', person: '111', createdAt: CREATED }],
      keys: [
        { id: 'k2', contactId: 'c2', hash: 'h2', createdAt: CREATED },
        { id: 'k3', contactId: 'c2', hash: 'h1', createdAt: CREATED_LATER },
      ],
      seed: { ...SEEDED.seed, fingerprint: 'f2', contactId: 'c2', keyId: 'k3' },
    },
    isNew: false,
  })
})

test('seeding a terminal-like provider reuses the local contact when the seed contact is gone', () => {
  const seed = { fingerprint: 'f1', provider: 'terminallike', settings: {} }
  let registry = applySeed(createEmptyRegistry(), seed, false, createCodes(), AT).registry
  registry = expectKind(removeContact(registry, 'c1'), 'removed').registry
  registry = expectKind(createContact(registry, 'b1', 'CODE0001', false, AT), 'created').registry
  const result = applySeed(registry, { ...seed, fingerprint: 'f2' }, false, createCodes(), LATER)
  expect(result).toStrictEqual({
    registry: {
      ...SEEDED,
      lastIds: { bot: 1, contact: 2, key: 2 },
      bots: [{ id: 'b1', provider: 'terminallike', settings: {}, createdAt: CREATED }],
      contacts: [{ id: 'c2', botId: 'b1', person: 'local', createdAt: CREATED }],
      keys: [{ id: 'k2', contactId: 'c2', createdAt: CREATED_LATER }],
      seed: { fingerprint: 'f2', botId: 'b1', contactId: 'c2', keyId: 'k2', isOpen: true },
    },
    isNew: false,
  })
})
