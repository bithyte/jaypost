import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import { runOwner } from '../../src/commands/index.ts'
import { createFakeProvider, createPairingFakeProvider } from '../provider/fake.ts'
import { PROVIDERS } from '../../src/provider/index.ts'

let file: string
let env: NodeJS.ProcessEnv
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'own-')), 'config.json')
  env = { JAYPOST_CONFIG: file }
})
afterEach(() => vi.restoreAllMocks())

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
