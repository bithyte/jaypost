import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import { runOwner } from '../../src/commands/index.ts'
import { createFakeProvider, createPairingFakeProvider } from '@jaypost/testing'
import { PROVIDERS } from '@jaypost/providers'
import {
  applySeed,
  claimPairing,
  createEmptyRegistry,
  createPairing,
  loadSeed,
  RegistryStore,
  resolveRegistryPath,
} from '@jaypost/store'
import type { Registry } from '@jaypost/store'

const NOW = new Date('2026-10-26T12:00:00Z')
const PAIRING_PROVIDERS = [...PROVIDERS, createPairingFakeProvider()]

let file: string
let env: NodeJS.ProcessEnv
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'own-')), 'config.json')
  env = { JAYPOST_CONFIG: file }
})
afterEach(() => vi.restoreAllMocks())

/** Seeds bot 1, pairing 1 (u1) and key 1 from the config file, plus pairing 2 paired to u2. */
function writeRegistry(): Registry {
  const loaded = loadSeed(env, PAIRING_PROVIDERS)
  if (loaded.kind !== 'seed') {
    throw new Error(loaded.message)
  }
  const seeded = applySeed(createEmptyRegistry(), loaded.seed, true, () => 'SEED1111', NOW)
  const created = createPairing(seeded.registry, 'b1', 'PAIR2222', true, NOW)
  if (created.kind !== 'created') {
    throw new Error('no bot b1')
  }
  const claimed = claimPairing(created.registry, 'b1', created.pairing.id, 'u2')
  if (claimed.kind === 'notPending') {
    throw new Error('no pairing p2')
  }
  new RegistryStore(resolveRegistryPath(file)).save(claimed.registry)
  return claimed.registry
}

function readRegistry(): Registry {
  return new RegistryStore(resolveRegistryPath(file)).load()
}

test('get prints the owner id', () => {
  writeFileSync(file, JSON.stringify({ botToken: 't', ownerId: 42 }))
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  expect(runOwner(['get'], env)).toBe(0)
  expect(log).toHaveBeenCalledWith('42')
})

test('get prints nothing without owner', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  expect(runOwner(['get'], env)).toBe(0)
  expect(log).not.toHaveBeenCalled()
})

test('clear removes the owner and keeps the token', () => {
  writeFileSync(file, JSON.stringify({ botToken: 't', ownerId: 42 }))
  expect(runOwner(['clear'], env)).toBe(0)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ botToken: 't' })
})

test('owner clear with a fake provider clears its owner key', () => {
  writeFileSync(file, JSON.stringify({ provider: 'fakepair', fakeOwner: 'u1', fakeKey: 'k' }))
  expect(runOwner(['clear'], env, [...PROVIDERS, createPairingFakeProvider()])).toBe(0)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ provider: 'fakepair', fakeKey: 'k' })
})

test('owner get without an owner setting prints nothing', () => {
  writeFileSync(file, JSON.stringify({ provider: 'fake', fakeKey: 'k' }))
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  expect(runOwner(['get'], env, [createFakeProvider()])).toBe(0)
  expect(log).not.toHaveBeenCalled()
})

test('unknown action returns 2', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(runOwner(['x'], env)).toBe(2)
})

test('owner clear resets pairing 1 in the registry and keeps other pairings', () => {
  writeFileSync(file, JSON.stringify({ provider: 'fakepair', fakeOwner: 'u1', fakeKey: 'k' }))
  const before = writeRegistry()
  expect(before.pairings.find((pairing) => pairing.id === 'p1')?.person).toBe('u1')
  expect(runOwner(['clear'], env, PAIRING_PROVIDERS)).toBe(0)
  const after = readRegistry()
  const [first, second] = after.pairings
  expect(first).toEqual({
    id: 'p1',
    botId: 'b1',
    code: expect.stringMatching(/^[A-Z0-9]{8}$/),
    createdAt: NOW.toISOString(),
  })
  expect(second).toEqual(before.pairings[1])
  expect(after.keys).toEqual(before.keys)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ provider: 'fakepair', fakeKey: 'k' })
})

test('owner get prints the seed pairing person from the registry', () => {
  writeFileSync(file, JSON.stringify({ provider: 'fakepair', fakeOwner: 'u1', fakeKey: 'k' }))
  writeRegistry()
  // A person paired through the service after the upgrade; config.json still has the old one.
  const registry = readRegistry()
  new RegistryStore(resolveRegistryPath(file)).save({
    ...registry,
    pairings: registry.pairings.map((pairing) =>
      pairing.id === 'p1' ? { ...pairing, person: 'u9' } : pairing,
    ),
  })
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  expect(runOwner(['get'], env, PAIRING_PROVIDERS)).toBe(0)
  expect(log.mock.calls).toEqual([['u9']])
})

test('owner get prints nothing while the seed pairing waits for a code', () => {
  writeFileSync(file, JSON.stringify({ provider: 'fakepair', fakeOwner: 'u1', fakeKey: 'k' }))
  writeRegistry()
  expect(runOwner(['clear'], env, PAIRING_PROVIDERS)).toBe(0)
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  expect(runOwner(['get'], env, PAIRING_PROVIDERS)).toBe(0)
  expect(log).not.toHaveBeenCalled()
})

test('owner with a corrupt registry exits 1 without quoting the file', () => {
  writeFileSync(file, JSON.stringify({ provider: 'fakepair', fakeOwner: 'u1', fakeKey: 'k' }))
  writeFileSync(resolveRegistryPath(file), '{"bots": "secret-bot-token"')
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(runOwner(['clear'], env, PAIRING_PROVIDERS)).toBe(1)
  expect(error.mock.calls).toEqual([
    [`registry file ${JSON.stringify(resolveRegistryPath(file))} contains invalid JSON`],
  ])
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
    provider: 'fakepair',
    fakeOwner: 'u1',
    fakeKey: 'k',
  })
})
