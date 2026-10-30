import { expect, test } from 'vite-plus/test'
import type { AuditEntry } from '../../src/audit/types.ts'
import {
  countBotRecords,
  findKeyRoute,
  findContactOf,
  isPending,
  isSeedLine,
  listKeys,
} from '../../src/registry/index.ts'
import type { Registry } from '../../src/registry/index.ts'

const CREATED = '2026-10-26T10:00:00.000Z'

const P1 = { id: 'c1', botId: 'b1', person: '111', createdAt: CREATED }
const P2 = { id: 'c2', botId: 'b1', code: 'CODE0002', createdAt: CREATED }
const P3 = { id: 'c3', botId: 'b2', person: '111', createdAt: CREATED }
const K1 = { id: 'k1', contactId: 'c1', createdAt: CREATED }
const K2 = { id: 'k2', contactId: 'c1', hash: 'h2', createdAt: CREATED }
const K3 = { id: 'k3', contactId: 'c2', hash: 'h3', createdAt: CREATED }
const K4 = { id: 'k4', contactId: 'c3', hash: 'h4', createdAt: CREATED }

/** Bot b1 with seed contact c1 (keys k1, hashless, and k2) and pending c2 (k3); bot b2 with c3 (k4). */
const REGISTRY: Registry = {
  version: 1,
  lastIds: { bot: 2, contact: 3, key: 4 },
  bots: [
    { id: 'b1', provider: 'telegram', settings: {}, createdAt: CREATED },
    { id: 'b2', provider: 'discord', settings: {}, createdAt: CREATED },
  ],
  contacts: [P1, P2, P3],
  keys: [K1, K2, K3, K4],
  seed: { fingerprint: 'f1', botId: 'b1', contactId: 'c1', keyId: 'k1', isOpen: false },
}

const OPEN: Registry = {
  ...REGISTRY,
  seed: { fingerprint: 'f1', botId: 'b1', contactId: 'c1', keyId: 'k1', isOpen: true },
}

function createEntry(fields: Partial<AuditEntry>): AuditEntry {
  return {
    id: 'q1',
    askedAt: CREATED,
    text: 'Deploy?',
    options: ['Yes', 'No'],
    timeoutOption: 'No',
    timeoutSeconds: 60,
    status: 'pending',
    ...fields,
  }
}

test('a key is found by its hash, with its contact', () => {
  expect(findKeyRoute(REGISTRY, 'h4')).toStrictEqual({ kind: 'found', key: K4, contact: P3 })
})

test('an unknown hash is wrong', () => {
  expect(findKeyRoute(REGISTRY, 'h9')).toStrictEqual({ kind: 'wrong' })
})

test('a call without a token is the seed key on an open seed', () => {
  expect(findKeyRoute(OPEN, undefined)).toStrictEqual({ kind: 'found', key: K1, contact: P1 })
})

test('a call without a token is missing on a seed that is not open', () => {
  expect(findKeyRoute(REGISTRY, undefined)).toStrictEqual({ kind: 'missing' })
})

test('a call without a token is missing once the open seed key is revoked', () => {
  const registry = { ...OPEN, keys: [K2, K3, K4] }
  expect(findKeyRoute(registry, undefined)).toStrictEqual({ kind: 'missing' })
})

test('a key whose contact is gone is wrong', () => {
  const registry = { ...OPEN, contacts: [P2, P3] }
  expect(findKeyRoute(registry, 'h2')).toStrictEqual({ kind: 'wrong' })
  expect(findKeyRoute(registry, undefined)).toStrictEqual({ kind: 'wrong' })
})

test('the contact of a person is found per bot', () => {
  expect(findContactOf(REGISTRY, 'b1', '111')).toStrictEqual(P1)
  expect(findContactOf(REGISTRY, 'b2', '111')).toStrictEqual(P3)
  expect(findContactOf(REGISTRY, 'b1', '222')).toBeUndefined()
})

test('a contact is pending with no person and a code', () => {
  expect(isPending(P2)).toBe(true)
  expect(isPending(P1)).toBe(false)
  expect(isPending({ id: 'c9', botId: 'b1', createdAt: CREATED })).toBe(false)
})

test('a bot counts its contacts and their keys', () => {
  expect(countBotRecords(REGISTRY, 'b1')).toStrictEqual({ contactCount: 2, keyCount: 3 })
  expect(countBotRecords(REGISTRY, 'b2')).toStrictEqual({ contactCount: 1, keyCount: 1 })
  expect(countBotRecords(REGISTRY, 'b9')).toStrictEqual({ contactCount: 0, keyCount: 0 })
})

test('keys are listed with their bot', () => {
  expect(listKeys(REGISTRY, {})).toStrictEqual({
    kind: 'listed',
    keys: [
      { key: K1, botId: 'b1' },
      { key: K2, botId: 'b1' },
      { key: K3, botId: 'b1' },
      { key: K4, botId: 'b2' },
    ],
  })
})

test('keys are narrowed by bot and by contact', () => {
  expect(listKeys(REGISTRY, { bot: 'b2' })).toStrictEqual({
    kind: 'listed',
    keys: [{ key: K4, botId: 'b2' }],
  })
  expect(listKeys(REGISTRY, { contact: 'c2' })).toStrictEqual({
    kind: 'listed',
    keys: [{ key: K3, botId: 'b1' }],
  })
  expect(listKeys(REGISTRY, { bot: 'b2', contact: 'c2' })).toStrictEqual({
    kind: 'listed',
    keys: [],
  })
})

test('keys of an unknown bot or contact are not found', () => {
  expect(listKeys(REGISTRY, { bot: 'b9' })).toStrictEqual({
    kind: 'notFound',
    what: 'bot',
    id: 'b9',
  })
  expect(listKeys(REGISTRY, { contact: 'c9' })).toStrictEqual({
    kind: 'notFound',
    what: 'contact',
    id: 'c9',
  })
})

test('a line without a key on the seed bot is the seed key', () => {
  expect(isSeedLine(REGISTRY, 'b1', createEntry({}))).toBe(true)
})

test('a keyed line or a line on another bot is not the seed key', () => {
  expect(isSeedLine(REGISTRY, 'b1', createEntry({ key: 'k2', pairing: 'c1' }))).toBe(false)
  expect(isSeedLine(REGISTRY, 'b2', createEntry({}))).toBe(false)
  const { seed: _seed, ...unseeded } = REGISTRY
  expect(isSeedLine(unseeded, 'b1', createEntry({}))).toBe(false)
})
