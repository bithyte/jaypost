import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vite-plus/test'
import { resolveStatePath, StateStore } from '../../src/state/index.ts'

const REQUEST = { id: 'r1', reference: { chatId: 1, messageId: 2 }, text: 'Deploy?' }
const NOTIFICATION = {
  id: 'n1',
  reference: { chatId: 1, messageId: 3 },
  expiresAtMs: 1_792_400_000_000,
}

function createPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'tab-state-')), 'state.json')
}

function readState(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeState(path: string, provider: string): void {
  const state = { version: 1, provider, requests: [REQUEST], notifications: [] }
  writeFileSync(path, JSON.stringify(state))
}

test('resolves state.json next to the config', () => {
  expect(resolveStatePath('/data/config.json')).toBe('/data/state.json')
})

test('missing file loads empty and writes nothing', () => {
  const path = createPath()
  const log = vi.fn()
  expect(new StateStore(path, 'telegram', log).load()).toEqual({ requests: [], notifications: [] })
  expect(existsSync(path)).toBe(false)
  expect(log).not.toHaveBeenCalled()
})

test('writes the full state with mode 0o600', () => {
  const path = createPath()
  const store = new StateStore(path, 'telegram', vi.fn())
  store.addRequest(REQUEST)
  store.addNotification(NOTIFICATION)
  expect(readState(path)).toEqual({
    version: 1,
    provider: 'telegram',
    requests: [REQUEST],
    notifications: [NOTIFICATION],
  })
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test('removes are reflected in the file', () => {
  const path = createPath()
  const store = new StateStore(path, 'telegram', vi.fn())
  store.addRequest(REQUEST)
  store.addNotification(NOTIFICATION)
  store.removeRequest('r1')
  store.removeNotification('n1')
  expect(readState(path)).toEqual({
    version: 1,
    provider: 'telegram',
    requests: [],
    notifications: [],
  })
})

test('removing an unknown id writes nothing', () => {
  const path = createPath()
  const store = new StateStore(path, 'telegram', vi.fn())
  store.removeRequest('x')
  store.removeNotification('x')
  expect(existsSync(path)).toBe(false)
})

test('load keeps the previous records for later writes', () => {
  const path = createPath()
  writeState(path, 'telegram')
  const store = new StateStore(path, 'telegram', vi.fn())
  expect(store.load()).toEqual({ requests: [REQUEST], notifications: [] })
  store.addNotification(NOTIFICATION)
  expect(readState(path)).toEqual({
    version: 1,
    provider: 'telegram',
    requests: [REQUEST],
    notifications: [NOTIFICATION],
  })
})

test('corrupt JSON is logged, ignored and overwritten by the next write', () => {
  const path = createPath()
  writeFileSync(path, '{')
  const log = vi.fn()
  const store = new StateStore(path, 'telegram', log)
  expect(store.load()).toEqual({ requests: [], notifications: [] })
  expect(log).toHaveBeenCalledWith(`ignoring state file ${JSON.stringify(path)}: invalid JSON`)
  store.addRequest(REQUEST)
  expect(readState(path)).toEqual({
    version: 1,
    provider: 'telegram',
    requests: [REQUEST],
    notifications: [],
  })
})

test('provider mismatch is logged and discarded', () => {
  const path = createPath()
  writeState(path, 'telegram')
  const log = vi.fn()
  expect(new StateStore(path, 'fake', log).load()).toEqual({ requests: [], notifications: [] })
  expect(log).toHaveBeenCalledWith(
    `ignoring state file ${JSON.stringify(path)}: written for provider "telegram"`,
  )
})

test('other read errors are logged and ignored', () => {
  const path = createPath()
  mkdirSync(path)
  const log = vi.fn()
  expect(new StateStore(path, 'telegram', log).load()).toEqual({ requests: [], notifications: [] })
  expect(log).toHaveBeenCalledTimes(1)
  expect(log.mock.calls[0]?.[0]).toMatch(
    new RegExp(
      `^ignoring state file ${JSON.stringify(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `,
    ),
  )
})

test('a failed write is logged, not thrown, and the next write has everything', () => {
  const blocker = join(mkdtempSync(join(tmpdir(), 'tab-state-')), 'blocker')
  writeFileSync(blocker, 'x')
  const path = join(blocker, 'state.json')
  const log = vi.fn()
  const store = new StateStore(path, 'telegram', log)
  expect(() => store.addRequest(REQUEST)).not.toThrow()
  expect(log).toHaveBeenCalledTimes(1)
  expect(
    String(log.mock.calls[0]?.[0]).startsWith(`failed to save state to ${JSON.stringify(path)}: `),
  ).toBe(true)
  rmSync(blocker)
  mkdirSync(blocker)
  store.addNotification(NOTIFICATION)
  expect(readState(path)).toEqual({
    version: 1,
    provider: 'telegram',
    requests: [REQUEST],
    notifications: [NOTIFICATION],
  })
})

test('after freeze nothing changes on disk', () => {
  const path = createPath()
  const store = new StateStore(path, 'telegram', vi.fn())
  store.addRequest(REQUEST)
  store.freeze()
  store.removeRequest('r1')
  store.addNotification(NOTIFICATION)
  expect(readState(path)).toEqual({
    version: 1,
    provider: 'telegram',
    requests: [REQUEST],
    notifications: [],
  })
})
