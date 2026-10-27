import { expect, test } from 'vite-plus/test'
import type { AuditEntry } from '../../src/audit/types.ts'
import {
  countBotRecords,
  findKeyRoute,
  findPairingOf,
  isPending,
  isSeedLine,
  listKeys,
  listPendingCodes,
} from '../../src/registry/index.ts'
import type { Registry } from '../../src/registry/index.ts'

const CREATED = '2026-10-26T10:00:00.000Z'

const P1 = { id: 'p1', botId: 'b1', person: '111', createdAt: CREATED }
const P2 = { id: 'p2', botId: 'b1', code: 'CODE0002', createdAt: CREATED }
const P3 = { id: 'p3', botId: 'b2', person: '111', createdAt: CREATED }
const K1 = { id: 'k1', pairingId: 'p1', createdAt: CREATED }
const K2 = { id: 'k2', pairingId: 'p1', hash: 'h2', createdAt: CREATED }
const K3 = { id: 'k3', pairingId: 'p2', hash: 'h3', createdAt: CREATED }
const K4 = { id: 'k4', pairingId: 'p3', hash: 'h4', createdAt: CREATED }

/** Bot b1 with seed pairing p1 (keys k1, hashless, and k2) and pending p2 (k3); bot b2 with p3 (k4). */
const REGISTRY: Registry = {
  version: 1,
  lastIds: { bot: 2, pairing: 3, key: 4 },
  bots: [
    { id: 'b1', provider: 'telegram', settings: {}, createdAt: CREATED },
    { id: 'b2', provider: 'discord', settings: {}, createdAt: CREATED },
  ],
  pairings: [P1, P2, P3],
  keys: [K1, K2, K3, K4],
  seed: { fingerprint: 'f1', botId: 'b1', pairingId: 'p1', keyId: 'k1', isOpen: false },
}

const OPEN: Registry = {
  ...REGISTRY,
  seed: { fingerprint: 'f1', botId: 'b1', pairingId: 'p1', keyId: 'k1', isOpen: true },
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

test('a key is found by its hash, with its pairing', () => {
  expect(findKeyRoute(REGISTRY, 'h4')).toStrictEqual({ kind: 'found', key: K4, pairing: P3 })
})

test('an unknown hash is wrong', () => {
  expect(findKeyRoute(REGISTRY, 'h9')).toStrictEqual({ kind: 'wrong' })
})

test('a call without a token is the seed key on an open seed', () => {
  expect(findKeyRoute(OPEN, undefined)).toStrictEqual({ kind: 'found', key: K1, pairing: P1 })
})

test('a call without a token is missing on a seed that is not open', () => {
  expect(findKeyRoute(REGISTRY, undefined)).toStrictEqual({ kind: 'missing' })
})

test('a call without a token is missing once the open seed key is revoked', () => {
  const registry = { ...OPEN, keys: [K2, K3, K4] }
  expect(findKeyRoute(registry, undefined)).toStrictEqual({ kind: 'missing' })
})

test('a key whose pairing is gone is wrong', () => {
  const registry = { ...OPEN, pairings: [P2, P3] }
  expect(findKeyRoute(registry, 'h2')).toStrictEqual({ kind: 'wrong' })
  expect(findKeyRoute(registry, undefined)).toStrictEqual({ kind: 'wrong' })
})

test('the pairing of a person is found per bot', () => {
  expect(findPairingOf(REGISTRY, 'b1', '111')).toStrictEqual(P1)
  expect(findPairingOf(REGISTRY, 'b2', '111')).toStrictEqual(P3)
  expect(findPairingOf(REGISTRY, 'b1', '222')).toBeUndefined()
})

test('a pairing is pending with no person and a code', () => {
  expect(isPending(P2)).toBe(true)
  expect(isPending(P1)).toBe(false)
  expect(isPending({ id: 'p9', botId: 'b1', createdAt: CREATED })).toBe(false)
})

test('pending codes are listed per bot by pairing', () => {
  expect(listPendingCodes(REGISTRY, 'b1')).toStrictEqual(new Map([['p2', 'CODE0002']]))
  expect(listPendingCodes(REGISTRY, 'b2')).toStrictEqual(new Map())
})

test('a bot counts its pairings and their keys', () => {
  expect(countBotRecords(REGISTRY, 'b1')).toStrictEqual({ pairingCount: 2, keyCount: 3 })
  expect(countBotRecords(REGISTRY, 'b2')).toStrictEqual({ pairingCount: 1, keyCount: 1 })
  expect(countBotRecords(REGISTRY, 'b9')).toStrictEqual({ pairingCount: 0, keyCount: 0 })
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

test('keys are narrowed by bot and by pairing', () => {
  expect(listKeys(REGISTRY, { bot: 'b2' })).toStrictEqual({
    kind: 'listed',
    keys: [{ key: K4, botId: 'b2' }],
  })
  expect(listKeys(REGISTRY, { pairing: 'p2' })).toStrictEqual({
    kind: 'listed',
    keys: [{ key: K3, botId: 'b1' }],
  })
  expect(listKeys(REGISTRY, { bot: 'b2', pairing: 'p2' })).toStrictEqual({
    kind: 'listed',
    keys: [],
  })
})

test('keys of an unknown bot or pairing are not found', () => {
  expect(listKeys(REGISTRY, { bot: 'b9' })).toStrictEqual({
    kind: 'notFound',
    what: 'bot',
    id: 'b9',
  })
  expect(listKeys(REGISTRY, { pairing: 'p9' })).toStrictEqual({
    kind: 'notFound',
    what: 'pairing',
    id: 'p9',
  })
})

test('a line without a key on the seed bot is the seed key', () => {
  expect(isSeedLine(REGISTRY, 'b1', createEntry({}))).toBe(true)
})

test('a keyed line or a line on another bot is not the seed key', () => {
  expect(isSeedLine(REGISTRY, 'b1', createEntry({ key: 'k2', pairing: 'p1' }))).toBe(false)
  expect(isSeedLine(REGISTRY, 'b2', createEntry({}))).toBe(false)
  const { seed: _seed, ...unseeded } = REGISTRY
  expect(isSeedLine(unseeded, 'b1', createEntry({}))).toBe(false)
})
