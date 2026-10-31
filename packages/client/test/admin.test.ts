import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { RequestListener, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import { loadSeed, NO_AUTH, resolveAdminKeyPath } from '@jaypost/store'
import { createApiServer, createSingleBotRouter, startService } from '@jaypost/service'
import type { RunningService } from '@jaypost/service'
import { createFakeProvider, createPairingFakeProvider } from '@jaypost/testing'
import {
  ADMIN_KEY_REJECTED_MESSAGE,
  ADMIN_TOO_OLD_MESSAGE,
  AdminCaller,
  toLocalEndpoint,
} from '../src/index.ts'

const TOKEN = 'a'.repeat(43)
const WRONG_ADMIN_KEY = `jpa_${'b'.repeat(43)}`
const CODES = ['PAIR2222', 'PAIR3333', 'PAIR4444', 'PAIR5555']
const CREATED_AT = expect.any(String)

let directory = ''
let running: RunningService | undefined
const stubs: Server[] = []

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jaypost-admin-caller-'))
})

afterEach(async () => {
  await running?.stop()
  running = undefined
  await Promise.all(
    stubs.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
  rmSync(directory, { recursive: true, force: true })
})

/** A real service whose bot 1 (fakepair) is paired to u1 with key 1 = TOKEN. */
async function start(): Promise<{ readonly port: number; readonly adminKey: string }> {
  const providers = [createPairingFakeProvider(), createFakeProvider()] as const
  const configPath = join(directory, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      provider: 'fakepair',
      fakeKey: 'seed-bot-token',
      fakeOwner: 'u1',
      apiToken: TOKEN,
    }),
  )
  const codes = [...CODES]
  running = await startService({
    version: '1.2.3',
    configPath,
    providers,
    seed: loadSeed({ JAYPOST_CONFIG: configPath }, providers),
    log: vi.fn(),
    generateCode: () => codes.shift() ?? 'PAIR9999',
  })
  await running.started
  await running.server.listen({ port: 0, host: '127.0.0.1' })
  const { port } = running.server.server.address() as AddressInfo
  const adminKey = readFileSync(resolveAdminKeyPath(configPath), 'utf8').trim()
  return { port, adminKey }
}

function createCaller(port: number, adminKey: string): AdminCaller {
  return new AdminCaller({ endpoint: toLocalEndpoint(port), adminKey })
}

async function startStub(handler: RequestListener): Promise<number> {
  const server = createServer(handler)
  stubs.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

test('bots: list, add and remove map 2xx to ok', async () => {
  const { port, adminKey } = await start()
  const caller = createCaller(port, adminKey)
  expect(await caller.listBots()).toEqual({
    kind: 'ok',
    value: {
      bots: [
        {
          id: 'b1',
          provider: 'fakepair',
          displayName: 'fake',
          state: 'running',
          contactCount: 1,
          keyCount: 1,
        },
      ],
    },
  })
  expect(
    await caller.addBot({ provider: 'fake', settings: { fakeKey: 'second' }, label: 'ci' }),
  ).toEqual({
    kind: 'ok',
    value: {
      bot: {
        id: 'b2',
        provider: 'fake',
        label: 'ci',
        displayName: 'fake',
        state: 'running',
        contactCount: 0,
        keyCount: 0,
      },
    },
  })
  expect(await caller.removeBot('b2')).toEqual({ kind: 'ok', value: { removedKeys: [] } })
})

test('contacts: create, list, reset and remove map 2xx to ok', async () => {
  const { port, adminKey } = await start()
  const caller = createCaller(port, adminKey)
  expect(await caller.createContact({ bot: 'b1' })).toEqual({
    kind: 'ok',
    value: {
      contact: { id: 'c2', bot: 'b1', state: 'pending', code: 'PAIR-2222', keys: [] },
      code: 'PAIR-2222',
      instructions: 'Say PAIR2222 to fake',
    },
  })
  expect(await caller.listContacts({ bot: 'b1' })).toEqual({
    kind: 'ok',
    value: {
      contacts: [
        { id: 'c1', bot: 'b1', person: 'u1', state: 'paired', keys: ['k1'] },
        { id: 'c2', bot: 'b1', state: 'pending', code: 'PAIR-2222', keys: [] },
      ],
    },
  })
  expect(await caller.resetContact('c1')).toEqual({
    kind: 'ok',
    value: {
      contact: { id: 'c1', bot: 'b1', state: 'pending', code: 'PAIR-3333', keys: ['k1'] },
      code: 'PAIR-3333',
      instructions: 'Say PAIR3333 to fake',
    },
  })
  expect(await caller.removeContact('c1')).toEqual({
    kind: 'ok',
    value: { removedKeys: ['k1'] },
  })
  expect(await caller.listContacts({})).toEqual({
    kind: 'ok',
    value: { contacts: [{ id: 'c2', bot: 'b1', state: 'pending', code: 'PAIR-2222', keys: [] }] },
  })
})

test('keys: create, list, update and revoke map 2xx to ok', async () => {
  const { port, adminKey } = await start()
  const caller = createCaller(port, adminKey)
  const created = await caller.createKey({ sameAsKey: 'k1', label: 'deploy', externalId: 'x1' })
  expect(created).toEqual({
    kind: 'ok',
    value: { id: 'k2', key: expect.stringMatching(/^jpk_/), contact: 'c1' },
  })
  expect(await caller.createKey({ bot: 'b1' })).toEqual({
    kind: 'ok',
    value: {
      id: 'k3',
      key: expect.stringMatching(/^jpk_/),
      contact: 'c2',
      code: 'PAIR-2222',
      instructions: 'Say PAIR2222 to fake',
    },
  })
  expect(await caller.listKeys({ contact: 'c1' })).toEqual({
    kind: 'ok',
    value: {
      keys: [
        { id: 'k1', contact: 'c1', bot: 'b1', createdAt: CREATED_AT },
        {
          id: 'k2',
          contact: 'c1',
          bot: 'b1',
          label: 'deploy',
          externalId: 'x1',
          createdAt: CREATED_AT,
        },
      ],
    },
  })
  expect(await caller.updateKey('k2', { label: 'release', externalId: null })).toEqual({
    kind: 'ok',
    value: { key: { id: 'k2', contact: 'c1', bot: 'b1', label: 'release', createdAt: CREATED_AT } },
  })
  expect(await caller.revokeKey('k2')).toEqual({ kind: 'ok', value: {} })
  expect(await caller.listKeys({ bot: 'b1' })).toEqual({
    kind: 'ok',
    value: {
      keys: [
        { id: 'k1', contact: 'c1', bot: 'b1', createdAt: CREATED_AT },
        { id: 'k3', contact: 'c2', bot: 'b1', createdAt: CREATED_AT },
      ],
    },
  })
})

test('readLog sends every filter and maps the page to ok', async () => {
  const { port, adminKey } = await start()
  const caller = createCaller(port, adminKey)
  expect(
    await caller.readLog({
      since: new Date('2026-01-01T00:00:00Z'),
      project: 'web',
      limit: 5,
      bot: 'b1',
      contact: 'c1',
      key: 'k1',
    }),
  ).toEqual({ kind: 'ok', value: { entries: [], skippedCount: 0 } })
  expect(await caller.readLog({})).toEqual({
    kind: 'ok',
    value: { entries: [], skippedCount: 0 },
  })
})

test('rotateAdminKey returns the new key and the old one stops working', async () => {
  const { port, adminKey } = await start()
  const rotated = await createCaller(port, adminKey).rotateAdminKey()
  if (rotated.kind !== 'ok') {
    throw new Error(rotated.message)
  }
  expect(rotated.value.adminKey).toMatch(/^jpa_/)
  expect(rotated.value.adminKey).not.toBe(adminKey)
  expect((await createCaller(port, rotated.value.adminKey).listBots()).kind).toBe('ok')
  expect(await createCaller(port, adminKey).listBots()).toEqual({
    kind: 'failed',
    reason: 'unauthorized',
    message: ADMIN_KEY_REJECTED_MESSAGE,
  })
})

test('a 401 is unauthorized on every method', async () => {
  const { port } = await start()
  const caller = createCaller(port, WRONG_ADMIN_KEY)
  const results = await Promise.all([
    caller.listBots(),
    caller.addBot({ provider: 'fake', settings: { fakeKey: 'x' } }),
    caller.removeBot('b1'),
    caller.listContacts({}),
    caller.createContact({ bot: 'b1' }),
    caller.resetContact('c1'),
    caller.removeContact('c1'),
    caller.listKeys({}),
    caller.createKey({ bot: 'b1' }),
    caller.updateKey('k1', { label: 'x' }),
    caller.revokeKey('k1'),
    caller.readLog({}),
    caller.rotateAdminKey(),
  ])
  for (const result of results) {
    expect(result).toEqual({
      kind: 'failed',
      reason: 'unauthorized',
      message: ADMIN_KEY_REJECTED_MESSAGE,
    })
  }
})

test("a 404 is notFound with the server's error", async () => {
  const { port, adminKey } = await start()
  const caller = createCaller(port, adminKey)
  const notFound = (message: string) => ({ kind: 'failed', reason: 'notFound', message })
  expect(await caller.removeBot('b9')).toEqual(notFound('unknown bot "b9"'))
  expect(await caller.listContacts({ bot: 'b9' })).toEqual(notFound('unknown bot "b9"'))
  expect(await caller.createContact({ bot: 'b9' })).toEqual(notFound('unknown bot "b9"'))
  expect(await caller.resetContact('c9')).toEqual(notFound('unknown contact "c9"'))
  expect(await caller.removeContact('c9')).toEqual(notFound('unknown contact "c9"'))
  expect(await caller.listKeys({ bot: 'b9' })).toEqual(notFound('unknown bot "b9"'))
  expect(await caller.createKey({ contact: 'c9' })).toEqual(notFound('unknown contact "c9"'))
  expect(await caller.updateKey('k9', { label: 'x' })).toEqual(notFound('unknown key "k9"'))
  expect(await caller.revokeKey('k9')).toEqual(notFound('unknown key "k9"'))
})

test("a 409 is conflict with the server's error", async () => {
  const { port, adminKey } = await start()
  expect(
    await createCaller(port, adminKey).addBot({
      provider: 'fakepair',
      settings: { fakeKey: 'seed-bot-token' },
    }),
  ).toEqual({
    kind: 'failed',
    reason: 'conflict',
    message: 'bot b1 already uses these credentials',
  })
})

test("a 400 is rejected with the server's error", async () => {
  const { port, adminKey } = await start()
  const caller = createCaller(port, adminKey)
  expect(await caller.addBot({ provider: 'nope', settings: {} })).toEqual({
    kind: 'failed',
    reason: 'rejected',
    message: 'provider must be one of "fakepair", "fake"',
  })
  expect(await caller.createKey({})).toEqual({
    kind: 'failed',
    reason: 'rejected',
    message: 'exactly one of bot, contact and sameAsKey is required',
  })
})

/** A real API server without admin routes, as a jaypost from before them answers. */
async function startWithoutAdminRoutes(): Promise<number> {
  const unexpected = () => {
    throw new Error('not called')
  }
  const app = createApiServer(
    createSingleBotRouter({
      version: '1.0.0',
      recipient: () => undefined,
      service: {
        request: unexpected,
        start: unexpected,
        get: unexpected,
        waitFor: unexpected,
        cancel: unexpected,
        send: unexpected,
        close: unexpected,
        update: unexpected,
      },
      status: () => ({ paired: true, bot: 'b' }),
      maxTextLength: 3900,
      providerName: 'test',
      resolveVoters: () => ({ kind: 'noOwner' }),
      describe: () => ({ provider: 'test', displayName: 'test' }),
      rejectForKeys: () => undefined,
      auth: NO_AUTH,
      maxAttachmentBytes: 0,
    }),
  )
  await app.listen({ port: 0, host: '127.0.0.1' })
  stubs.push(app.server)
  return (app.server.address() as AddressInfo).port
}

test('a service without admin routes is tooOld', async () => {
  const port = await startWithoutAdminRoutes()
  const caller = createCaller(port, WRONG_ADMIN_KEY)
  const tooOld = { kind: 'failed', reason: 'tooOld', message: ADMIN_TOO_OLD_MESSAGE }
  expect(await caller.listBots()).toEqual(tooOld)
  expect(await caller.createKey({ bot: 'b1' })).toEqual(tooOld)
  expect(await caller.revokeKey('k1')).toEqual(tooOld)
})

test('a 2xx body of the wrong shape is unreadable', async () => {
  const port = await startStub((_request, response) => {
    response.statusCode = 200
    response.end('{"bots":"nope"}')
  })
  expect(await createCaller(port, WRONG_ADMIN_KEY).listBots()).toEqual({
    kind: 'failed',
    reason: 'unreadable',
    message: 'jaypost service sent an unreadable answer: {"bots":"nope"}',
  })
})

test('a 2xx answer that would hold a key never repeats the body', async () => {
  const secret = `jpk_${'s'.repeat(43)}`
  const bodies = [`{"key":"${secret}"}`, `not json ${secret}`]
  for (const body of bodies) {
    const port = await startStub((_request, response) => {
      response.statusCode = 201
      response.end(body)
    })
    const caller = createCaller(port, WRONG_ADMIN_KEY)
    const failure = {
      kind: 'failed',
      reason: 'unreadable',
      message: 'jaypost service sent an unexpected answer',
    }
    expect(await caller.createKey({ bot: 'b1' })).toEqual(failure)
    expect(await caller.rotateAdminKey()).toEqual(failure)
  }
})

test('an unexpected status names the status and error', async () => {
  const port = await startStub((_request, response) => {
    response.statusCode = 500
    response.end('{"error":"boom"}')
  })
  expect(await createCaller(port, WRONG_ADMIN_KEY).revokeKey('k1')).toEqual({
    kind: 'failed',
    reason: 'unexpected',
    message: 'jaypost service error 500: boom',
  })
})

test('no service is unreachable', async () => {
  const port = await freePort()
  expect(await createCaller(port, WRONG_ADMIN_KEY).listBots()).toEqual({
    kind: 'failed',
    reason: 'unreachable',
    message: `jaypost service not reachable on 127.0.0.1:${port} (run jaypost status)`,
  })
})

test('ids are sent path-encoded', async () => {
  const seen: string[] = []
  const port = await startStub((request, response) => {
    seen.push(`${request.method} ${request.url}`)
    response.statusCode = 200
    response.end('{"removedKeys":[]}')
  })
  await createCaller(port, WRONG_ADMIN_KEY).removeBot('a/b c')
  expect(seen).toEqual(['DELETE /admin/bots/a%2Fb%20c'])
})

test('an invalid endpoint fails every call without a request', async () => {
  const caller = new AdminCaller({
    endpoint: { kind: 'invalid', message: 'bad url' },
    adminKey: WRONG_ADMIN_KEY,
  })
  expect(await caller.listBots()).toEqual({
    kind: 'failed',
    reason: 'invalidUrl',
    message: 'bad url',
  })
})
