import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vite-plus/test'
import { openDatabase } from '../../src/database/index.ts'
import { resolveStatePath, StateStore } from '../../src/state/index.ts'

const REQUEST = { id: 'r1', reference: { chatId: 1, messageId: 2 }, text: 'Deploy?' }
const REQUEST_TWO = { id: 'r2', reference: { chatId: 1, messageId: 4 }, text: 'Ship?' }
const NOTIFICATION = {
  id: 'n1',
  reference: { chatId: 1, messageId: 3 },
  expiresAtMs: 1_792_400_000_000,
}

function createDatabase(): DatabaseSync {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'tab-state-')), 'jaypost.db'))
}

function createStore(
  database: DatabaseSync,
  botId = 'b1',
  provider = 'telegram',
  log: (line: string) => void = vi.fn(),
): StateStore {
  return new StateStore(database, botId, provider, log)
}

test('resolves state.json next to the config', () => {
  expect(resolveStatePath('/data/config.json')).toBe('/data/state.json')
})

test('loads nothing for a bot with no rows', () => {
  const log = vi.fn()
  expect(createStore(createDatabase(), 'b1', 'telegram', log).load()).toEqual({
    requests: [],
    notifications: [],
  })
  expect(log).not.toHaveBeenCalled()
})

test('keeps added requests and notifications across a reopen', () => {
  const database = createDatabase()
  const store = createStore(database)
  store.addRequest(REQUEST)
  store.addNotification(NOTIFICATION)
  expect(createStore(database).load()).toEqual({
    requests: [REQUEST],
    notifications: [NOTIFICATION],
  })
})

test('keeps spans and the caller on a request', () => {
  const database = createDatabase()
  const full = {
    ...REQUEST,
    spans: [
      { kind: 'bold' as const, offset: 0, length: 3 },
      { kind: 'pre' as const, offset: 4, length: 2, language: 'ts' },
    ],
    caller: { key: 'k1', pairing: 'p1' },
  }
  createStore(database).addRequest(full)
  expect(createStore(database).load().requests).toEqual([full])
})

test('removes only the given record', () => {
  const database = createDatabase()
  const store = createStore(database)
  store.addRequest(REQUEST)
  store.addRequest(REQUEST_TWO)
  store.addNotification(NOTIFICATION)
  store.removeRequest('r1')
  store.removeNotification('n1')
  store.removeRequest('missing')
  expect(createStore(database).load()).toEqual({ requests: [REQUEST_TWO], notifications: [] })
})

test("keeps each bot's state apart", () => {
  const database = createDatabase()
  createStore(database, 'b1').addRequest(REQUEST)
  expect(createStore(database, 'b2').load()).toEqual({ requests: [], notifications: [] })
  expect(createStore(database, 'b1').load().requests).toEqual([REQUEST])
})

test('drops state saved for another provider', () => {
  const database = createDatabase()
  const saver = createStore(database, 'b1', 'telegram')
  saver.addRequest(REQUEST)
  saver.addNotification(NOTIFICATION)
  const log = vi.fn()
  expect(createStore(database, 'b1', 'discord', log).load()).toEqual({
    requests: [],
    notifications: [],
  })
  expect(log.mock.calls).toEqual([['ignoring saved state for provider "telegram"']])
  expect(createStore(database, 'b1', 'telegram').load()).toEqual({
    requests: [],
    notifications: [],
  })
})

test('drops an invalid row without quoting it', () => {
  const database = createDatabase()
  const store = createStore(database)
  store.addRequest(REQUEST)
  database
    .prepare(
      "INSERT INTO requests (bot_id, id, provider, record) VALUES ('b1', 'r9', 'telegram', ?)",
    )
    .run('{"id":"r9","text":"SECRET-2"}')
  database
    .prepare(
      "INSERT INTO notifications (bot_id, id, provider, record) VALUES ('b1', 'n9', 'telegram', ?)",
    )
    .run('not json SECRET-3')
  const log = vi.fn()
  expect(createStore(database, 'b1', 'telegram', log).load()).toEqual({
    requests: [REQUEST],
    notifications: [],
  })
  expect(log.mock.calls).toEqual([
    ['ignoring a saved request: invalid or missing fields'],
    ['ignoring a saved notification: invalid or missing fields'],
  ])
  expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET')
  const remaining = database.prepare('SELECT id FROM requests').all()
  expect(remaining).toEqual([{ id: 'r1' }])
})

test('freeze ignores later changes', () => {
  const database = createDatabase()
  const store = createStore(database)
  store.addRequest(REQUEST)
  store.freeze()
  store.addRequest(REQUEST_TWO)
  store.removeRequest('r1')
  store.addNotification(NOTIFICATION)
  expect(createStore(database).load()).toEqual({ requests: [REQUEST], notifications: [] })
})

test('logs and keeps going when a write fails', () => {
  const database = createDatabase()
  const log = vi.fn()
  const store = createStore(database, 'b1', 'telegram', log)
  database.close()
  expect(() => store.addRequest(REQUEST)).not.toThrow()
  expect(() => store.addRequest(REQUEST_TWO)).not.toThrow()
  expect(log).toHaveBeenCalledTimes(2)
  expect(log).toHaveBeenCalledTimes(2)
})

test('logs and loads empty when the db cannot be read', () => {
  const database = createDatabase()
  const log = vi.fn()
  const store = createStore(database, 'b1', 'telegram', log)
  database.close()
  expect(store.load()).toEqual({ requests: [], notifications: [] })
  expect(log).toHaveBeenCalledTimes(1)
})
