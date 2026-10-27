import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vite-plus/test'
import type { Provider } from '@jaypost/core'
import {
  loadSeed,
  openDatabase,
  RegistryStore,
  resolveAdminKeyPath,
  resolveDatabasePath,
} from '@jaypost/store'
import type { Registry } from '@jaypost/store'
import { createFakeProvider, createPairingFakeProvider } from '@jaypost/testing'
import type { FakeRuntime } from '@jaypost/testing'
import { startService } from '../../src/daemon/index.ts'
import type { RunningService } from '../../src/daemon/index.ts'

const TEST_VERSION = '1.2.3'

const TOKEN = 'a'.repeat(43)

const WRONG = 'b'.repeat(43)

const SEED_BOT_TOKEN = 'seed-bot-token-1'

/** Pairing codes in the order the service hands them out. */
const CODES = ['PAIR2222', 'PAIR3333', 'PAIR4444', 'PAIR5555', 'PAIR6666']

const REQUEST = { text: 'Deploy?', options: ['Approve', 'Decline'], timeoutOption: 'Decline' }

const IS_ROOT = process.getuid?.() === 0

type FakeProvider = Provider & { readonly runtimes: FakeRuntime[] }

type Started = {
  readonly url: string
  readonly configPath: string
  readonly adminKey: string
  readonly runtime: FakeRuntime
}

let running: RunningService | undefined

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await running?.stop()
  running = undefined
})

/** A temp install whose bot 1 is `provider` (paired to u1 when it pairs), with key 1 = TOKEN. */
function createConfigPath(provider: Provider, file: Record<string, unknown>): string {
  const configPath = join(mkdtempSync(join(tmpdir(), 'jaypost-admin-')), 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({ provider: provider.name, fakeKey: SEED_BOT_TOKEN, ...file }),
  )
  return configPath
}

async function start(
  options: {
    /** The providers; the first is bot 1's. Default the pairing fake and the plain fake. */
    readonly providers?: readonly [FakeProvider, ...Provider[]]
    readonly file?: Record<string, unknown>
    readonly log?: (line: string) => void
  } = {},
): Promise<Started> {
  const providers = options.providers ?? [createPairingFakeProvider(), createFakeProvider()]
  const [seedProvider] = providers
  const configPath = createConfigPath(
    seedProvider,
    options.file ?? { fakeOwner: 'u1', apiToken: TOKEN },
  )
  const codes = [...CODES]
  running = await startService({
    version: TEST_VERSION,
    configPath,
    providers,
    seed: loadSeed({ JAYPOST_CONFIG: configPath }, providers),
    log: options.log ?? vi.fn(),
    generateCode: () => codes.shift() ?? 'PAIR9999',
  })
  await running.started
  await running.server.listen({ port: 0, host: '127.0.0.1' })
  const { port } = running.server.server.address() as AddressInfo
  const runtime = seedProvider.runtimes.at(-1)
  if (runtime === undefined) {
    throw new Error('no runtime created')
  }
  const adminKey = readFileSync(resolveAdminKeyPath(configPath), 'utf8').trim()
  return { url: `http://127.0.0.1:${port}`, configPath, adminKey, runtime }
}

function requireRunning(): RunningService {
  if (running === undefined) {
    throw new Error('not running')
  }
  return running
}

const readRegistry = (configPath: string): Registry => {
  const database = openDatabase(resolveDatabasePath(configPath))
  try {
    return new RegistryStore(database).load()
  } finally {
    database.close()
  }
}

const REFUSED_WRITES = ['bots', 'pairings', 'keys'].flatMap((table) =>
  ['INSERT', 'UPDATE', 'DELETE'].map((event) => ({
    table,
    event,
    name: `refuse_${table}_${event.toLowerCase()}`,
  })),
)

/** Makes every bot, pairing and key write fail until the returned function runs. */
function refuseRegistryWrites(configPath: string): () => void {
  const database = openDatabase(resolveDatabasePath(configPath))
  for (const { table, event, name } of REFUSED_WRITES) {
    database.exec(
      `CREATE TRIGGER ${name} BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT, 'refused'); END`,
    )
  }
  return () => {
    for (const { name } of REFUSED_WRITES) {
      database.exec(`DROP TRIGGER ${name}`)
    }
    database.close()
  }
}

const call = (
  url: string,
  method: string,
  path: string,
  options: { readonly token?: string; readonly body?: unknown; readonly rawBody?: string } = {},
) =>
  fetch(`${url}${path}`, {
    method,
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.body === undefined && options.rawBody === undefined
        ? {}
        : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.rawBody === undefined ? {} : { body: options.rawBody }),
  })

/** Calls an admin route with `started`'s admin key; returns the status and the parsed body. */
async function admin(
  started: Pick<Started, 'url' | 'adminKey'>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly body: any }> {
  const response = await call(started.url, method, path, {
    token: started.adminKey,
    ...(body === undefined ? {} : { body }),
  })
  return { status: response.status, body: await response.json() }
}

const post = (url: string, path: string, body: unknown, token: string) =>
  call(url, 'POST', path, { body, token })

const getStatus = async (url: string, token: string) =>
  (await call(url, 'GET', '/status', { token })).json()

const muteConsole = () => vi.spyOn(console, 'error').mockImplementation(() => {})

const ADMIN_ROUTES: readonly (readonly [string, string])[] = [
  ['GET', '/admin/bots'],
  ['POST', '/admin/bots'],
  ['DELETE', '/admin/bots/b1'],
  ['GET', '/admin/pairings'],
  ['POST', '/admin/pairings'],
  ['POST', '/admin/pairings/p1/reset'],
  ['DELETE', '/admin/pairings/p1'],
  ['GET', '/admin/keys'],
  ['POST', '/admin/keys'],
  ['PATCH', '/admin/keys/k1'],
  ['DELETE', '/admin/keys/k1'],
  ['GET', '/admin/log'],
  ['POST', '/admin/admin-key'],
]

test('an api key gets 401 on every admin route', async () => {
  const started = await start()
  const error = muteConsole()
  for (const [method, path] of ADMIN_ROUTES) {
    for (const token of [TOKEN, WRONG, undefined]) {
      const response = await call(started.url, method, path, {
        ...(token === undefined ? {} : { token }),
        ...(method === 'POST' || method === 'PATCH' ? { body: { bot: 'b1' } } : {}),
      })
      expect(response.status, `${method} ${path}`).toBe(401)
      expect(response.headers.get('www-authenticate')).toBe('Bearer')
      expect(await response.json()).toEqual({ error: 'unauthorized' })
    }
  }
  expect(JSON.stringify(error.mock.calls)).not.toContain(TOKEN)
  error.mockRestore()
  const registry = readRegistry(started.configPath)
  expect(registry.bots.map((bot) => bot.id)).toEqual(['b1'])
  expect(registry.keys.map((key) => key.id)).toEqual(['k1'])
  expect(await admin(started, 'GET', '/admin/bots')).toMatchObject({ status: 200 })
})

test('a tokenless install still needs the admin key on admin routes', async () => {
  const started = await start({ file: { fakeOwner: 'u1' } })
  const error = muteConsole()
  expect((await call(started.url, 'GET', '/admin/bots')).status).toBe(401)
  error.mockRestore()
  expect((await call(started.url, 'GET', '/status')).status).toBe(200)
  expect((await admin(started, 'GET', '/admin/bots')).status).toBe(200)
})

test('a created key works at once for an existing pairing and waits for pairing for a new one', async () => {
  const started = await start()
  const { url, runtime } = started
  const same = await admin(started, 'POST', '/admin/keys', { sameAsKey: 'k1', label: 'ci' })
  expect(same.status).toBe(201)
  expect(same.body).toEqual({ id: 'k2', key: expect.stringMatching(/^jpk_/), pairing: 'p1' })
  expect(await getStatus(url, same.body.key)).toMatchObject({ paired: true, key: 'k2' })
  const viaPairing = await admin(started, 'POST', '/admin/keys', { pairing: 'p1' })
  expect(viaPairing.body).toMatchObject({ id: 'k3', pairing: 'p1' })
  const fresh = await admin(started, 'POST', '/admin/keys', { bot: 'b1', externalId: 'user-7' })
  expect(fresh.status).toBe(201)
  expect(fresh.body).toEqual({
    id: 'k4',
    key: expect.stringMatching(/^jpk_/),
    pairing: 'p2',
    code: 'PAIR-2222',
    instructions: 'Say PAIR2222 to fake',
  })
  expect(await getStatus(url, fresh.body.key)).toMatchObject({
    paired: false,
    key: 'k4',
    code: 'PAIR-2222',
  })
  const refused = await post(url, '/request/async', REQUEST, fresh.body.key)
  expect(refused.status).toBe(503)
  expect(runtime.handlers?.pair?.('u2', 'pair-2222')).toBe('paired')
  expect((await post(url, '/request/async', REQUEST, fresh.body.key)).status).toBe(202)
  expect(runtime.sent.map((sent) => sent.recipient)).toEqual(['u2'])
  const keys = await admin(started, 'GET', '/admin/keys')
  expect(keys).toEqual({
    status: 200,
    body: {
      keys: [
        { id: 'k1', pairing: 'p1', bot: 'b1', createdAt: expect.any(String) },
        { id: 'k2', pairing: 'p1', bot: 'b1', label: 'ci', createdAt: expect.any(String) },
        { id: 'k3', pairing: 'p1', bot: 'b1', createdAt: expect.any(String) },
        { id: 'k4', pairing: 'p2', bot: 'b1', externalId: 'user-7', createdAt: expect.any(String) },
      ],
    },
  })
  const listed = JSON.stringify(keys.body)
  for (const key of [same.body.key, fresh.body.key, TOKEN]) {
    expect(listed).not.toContain(key)
  }
  expect(listed).not.toContain('hash')
  expect(await admin(started, 'GET', '/admin/keys?pairing=p2')).toMatchObject({
    body: { keys: [{ id: 'k4' }] },
  })
  expect(await admin(started, 'POST', '/admin/keys', { sameAsKey: 'k9' })).toEqual({
    status: 404,
    body: { error: 'unknown key "k9"' },
  })
  expect(await admin(started, 'POST', '/admin/keys', { bot: 'b9' })).toEqual({
    status: 404,
    body: { error: 'unknown bot "b9"' },
  })
})

test('a bot added at runtime serves its first key without a restart', async () => {
  const other = createFakeProvider()
  const started = await start({ providers: [createPairingFakeProvider(), other] })
  const added = await admin(started, 'POST', '/admin/bots', {
    provider: 'fake',
    settings: { fakeKey: 'other-token' },
    label: 'ci bot',
  })
  expect(added).toEqual({
    status: 201,
    body: {
      bot: {
        id: 'b2',
        provider: 'fake',
        label: 'ci bot',
        displayName: 'fake',
        state: 'running',
        pairingCount: 0,
        keyCount: 0,
      },
    },
  })
  expect(JSON.stringify(added.body)).not.toContain('other-token')
  const created = await admin(started, 'POST', '/admin/keys', { bot: 'b2' })
  expect(created.body).toEqual({ id: 'k2', key: expect.any(String), pairing: 'p2' })
  expect((await post(started.url, '/request/async', REQUEST, created.body.key)).status).toBe(202)
  expect(other.runtimes.at(-1)?.sent).toHaveLength(1)
  expect(started.runtime.sent).toHaveLength(0)
  expect(await admin(started, 'GET', '/admin/bots')).toEqual({
    status: 200,
    body: {
      bots: [
        {
          id: 'b1',
          provider: 'fakepair',
          displayName: 'fake',
          state: 'running',
          pairingCount: 1,
          keyCount: 1,
        },
        {
          id: 'b2',
          provider: 'fake',
          label: 'ci bot',
          displayName: 'fake',
          state: 'running',
          pairingCount: 1,
          keyCount: 1,
        },
      ],
    },
  })
  expect(readRegistry(started.configPath).bots[1]).toMatchObject({
    id: 'b2',
    settings: { fakeKey: 'other-token' },
  })
})

test('rejected credentials answer 400 without the token in the body or logs', async () => {
  const log = vi.fn()
  const picky = createFakeProvider({
    setup: {
      ...createFakeProvider().setup,
      checkCredentials: async (settings) =>
        settings.fakeKey === 'secret-123'
          ? { ok: false, reason: 'Fake rejected that key' }
          : { ok: true, displayName: 'fake' },
    },
  })
  const started = await start({ providers: [createPairingFakeProvider(), picky], log })
  const error = muteConsole()
  const response = await call(started.url, 'POST', '/admin/bots', {
    token: started.adminKey,
    body: { provider: 'fake', settings: { fakeKey: 'secret-123' } },
  })
  expect(response.status).toBe(400)
  const body = await response.json()
  expect(body).toEqual({ error: 'Fake rejected that key' })
  expect(JSON.stringify(body)).not.toContain('secret-123')
  expect(JSON.stringify(log.mock.calls)).not.toContain('secret-123')
  expect(JSON.stringify(error.mock.calls)).not.toContain('secret-123')
  error.mockRestore()
  expect(readRegistry(started.configPath).bots.map((bot) => bot.id)).toEqual(['b1'])
  expect(picky.runtimes).toHaveLength(0)
})

test('a provider whose credential check throws answers 400 without the error', async () => {
  const log = vi.fn()
  const throwing = createFakeProvider({
    setup: {
      ...createFakeProvider().setup,
      checkCredentials: async (settings) => {
        throw new Error(`could not reach https://fake.example/${String(settings.fakeKey)}`)
      },
    },
  })
  const started = await start({ providers: [createPairingFakeProvider(), throwing], log })
  const error = muteConsole()
  const response = await admin(started, 'POST', '/admin/bots', {
    provider: 'fake',
    settings: { fakeKey: 'secret-321' },
  })
  expect(response).toEqual({
    status: 400,
    body: { error: "couldn't check the credentials with fake" },
  })
  expect(JSON.stringify([log.mock.calls, error.mock.calls])).not.toContain('secret-321')
  error.mockRestore()
})

test('a malformed admin body is a 400 that does not quote it', async () => {
  const started = await start()
  const cases: readonly (readonly [string, unknown, string])[] = [
    [
      '/admin/bots',
      { provider: 'fake', settings: { fakeKey: 'x' }, token: 'secret-1' },
      'body has an unknown field',
    ],
    [
      '/admin/bots',
      { provider: 'secret-2', settings: { fakeKey: 'x' } },
      'provider must be one of "fakepair", "fake"',
    ],
    [
      '/admin/bots',
      { provider: 'fake', settings: { 'secret-3': 'x' } },
      'settings may only hold fakeKey',
    ],
    ['/admin/bots', { provider: 'fake', settings: { fakeKey: '' } }, 'invalid fake key'],
    ['/admin/bots', { provider: 'fake', settings: {} }, 'missing fake key'],
    [
      '/admin/bots',
      { provider: 'fakepair', settings: { fakeKey: 'x', fakeOwner: 'secret-4' } },
      'settings may not set the owner',
    ],
    [
      '/admin/bots',
      { provider: 'fake', settings: { fakeKey: ['secret-5'] } },
      expect.stringMatching(/^settings: /),
    ],
    [
      '/admin/keys',
      { bot: 'b1', pairing: 'p1' },
      'exactly one of bot, pairing and sameAsKey is required',
    ],
    ['/admin/keys', {}, 'exactly one of bot, pairing and sameAsKey is required'],
    ['/admin/keys', { bot: 'b1', label: 'x'.repeat(201) }, expect.stringMatching(/^label: /)],
    ['/admin/pairings', { bot: 7 }, expect.stringMatching(/^bot: /)],
    ['/admin/pairings', ['secret-6'], expect.stringMatching(/^body: /)],
  ]
  for (const [path, body, error] of cases) {
    const response = await admin(started, 'POST', path, body)
    expect(response, JSON.stringify(body)).toEqual({ status: 400, body: { error } })
    expect(JSON.stringify(response.body)).not.toMatch(/secret-\d/)
  }
  const raw = await call(started.url, 'POST', '/admin/bots', {
    token: started.adminKey,
    rawBody: '{"provider":"fake","settings":{"fakeKey":"secret-7"',
  })
  expect(raw.status).toBe(400)
  expect(await raw.json()).toEqual({ error: 'body must be valid JSON' })
  const patch = await admin(started, 'PATCH', '/admin/keys/k1', { label: 'x'.repeat(201) })
  expect(patch).toEqual({ status: 400, body: { error: expect.stringMatching(/^label: /) } })
  expect(readRegistry(started.configPath).bots.map((bot) => bot.id)).toEqual(['b1'])
  expect(readRegistry(started.configPath).keys.map((key) => key.id)).toEqual(['k1'])
})

test('labels and external ids can be set and cleared', async () => {
  const started = await start()
  expect(
    await admin(started, 'PATCH', '/admin/keys/k1', { label: 'laptop', externalId: 'user-1' }),
  ).toEqual({
    status: 200,
    body: {
      key: {
        id: 'k1',
        pairing: 'p1',
        bot: 'b1',
        label: 'laptop',
        externalId: 'user-1',
        createdAt: expect.any(String),
      },
    },
  })
  expect(await admin(started, 'PATCH', '/admin/keys/k1', { label: null })).toMatchObject({
    body: { key: { externalId: 'user-1' } },
  })
  expect(readRegistry(started.configPath).keys[0]).not.toHaveProperty('label')
  expect(readRegistry(started.configPath).keys[0]).toMatchObject({ externalId: 'user-1' })
  expect(await admin(started, 'PATCH', '/admin/keys/k7', { label: 'x' })).toEqual({
    status: 404,
    body: { error: 'unknown key "k7"' },
  })
})

test('revoking a key cancels its open question with the timeout option', async () => {
  const started = await start()
  const { url, runtime } = started
  const created = await admin(started, 'POST', '/admin/keys', { sameAsKey: 'k1' })
  const asked = post(url, '/request', REQUEST, created.body.key)
  const kept = post(url, '/request', REQUEST, TOKEN)
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(2))
  expect(await admin(started, 'DELETE', '/admin/keys/k2')).toEqual({ status: 200, body: {} })
  expect(await (await asked).json()).toEqual({ answer: 'Decline', timedOut: false })
  const error = muteConsole()
  expect((await call(url, 'GET', '/status', { token: created.body.key })).status).toBe(401)
  error.mockRestore()
  expect(runtime.handlers?.answer(runtime.sent[1]?.id ?? '', 0, 'u1')).toBe('accepted')
  expect(await (await kept).json()).toEqual({ answer: 'Approve', timedOut: false })
  expect(await admin(started, 'DELETE', '/admin/keys/k2')).toEqual({
    status: 404,
    body: { error: 'unknown key "k2"' },
  })
  expect(readRegistry(started.configPath).pairings.map((pairing) => pairing.id)).toEqual(['p1'])
})

test('removing a pairing revokes its keys', async () => {
  const started = await start()
  const { url, runtime } = started
  const created = await admin(started, 'POST', '/admin/keys', { bot: 'b1' })
  const second = await admin(started, 'POST', '/admin/keys', { pairing: 'p2' })
  expect(runtime.handlers?.pair?.('u2', created.body.code)).toBe('paired')
  const asked = post(url, '/request', REQUEST, second.body.key)
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  expect(await admin(started, 'GET', '/admin/pairings')).toEqual({
    status: 200,
    body: {
      pairings: [
        { id: 'p1', bot: 'b1', person: 'u1', state: 'paired', keys: ['k1'] },
        { id: 'p2', bot: 'b1', person: 'u2', state: 'paired', keys: ['k2', 'k3'] },
      ],
    },
  })
  expect(await admin(started, 'DELETE', '/admin/pairings/p2')).toEqual({
    status: 200,
    body: { removedKeys: ['k2', 'k3'] },
  })
  expect(await (await asked).json()).toEqual({ answer: 'Decline', timedOut: false })
  const error = muteConsole()
  for (const key of [created.body.key, second.body.key]) {
    expect((await call(url, 'GET', '/status', { token: key })).status).toBe(401)
  }
  error.mockRestore()
  expect(runtime.handlers?.isPaired('u2')).toBe(false)
  expect(readRegistry(started.configPath).pairings.map((pairing) => pairing.id)).toEqual(['p1'])
  expect(await admin(started, 'DELETE', '/admin/pairings/p2')).toEqual({
    status: 404,
    body: { error: 'unknown pairing "p2"' },
  })
})

test('a removed pending pairing takes its code with it', async () => {
  const started = await start()
  const created = await admin(started, 'POST', '/admin/pairings', { bot: 'b1' })
  expect(created).toEqual({
    status: 201,
    body: {
      pairing: { id: 'p2', bot: 'b1', state: 'pending', code: 'PAIR-2222', keys: [] },
      code: 'PAIR-2222',
      instructions: 'Say PAIR2222 to fake',
    },
  })
  expect(await admin(started, 'DELETE', '/admin/pairings/p2')).toEqual({
    status: 200,
    body: { removedKeys: [] },
  })
  expect(started.runtime.handlers?.pair?.('u2', 'PAIR2222')).toBe('notPairing')
  expect(readRegistry(started.configPath).pairings.map((pairing) => pairing.id)).toEqual(['p1'])
})

test('someone re-paired after their pairing was removed starts without its quiet state', async () => {
  const started = await start()
  const { runtime } = started
  const first = await admin(started, 'POST', '/admin/pairings', { bot: 'b1' })
  expect(runtime.handlers?.pair?.('u2', first.body.code)).toBe('paired')
  expect(runtime.handlers?.command('mute', '2h', 'u2')).toMatch(/^Muted until /)
  await admin(started, 'DELETE', '/admin/pairings/p2')
  const second = await admin(started, 'POST', '/admin/pairings', { bot: 'b1' })
  expect(runtime.handlers?.pair?.('u2', second.body.code)).toBe('paired')
  expect(runtime.handlers?.command('quiet', '', 'u2')).toContain('Not muted.')
  expect(readRegistry(started.configPath).pairings).toMatchObject([
    { id: 'p1', person: 'u1' },
    { id: 'p3', person: 'u2' },
  ])
  expect(readRegistry(started.configPath).pairings[1]).not.toHaveProperty('mutedUntil')
})

test('resetting a pairing keeps its keys and waits for a new person', async () => {
  const started = await start()
  const { url, runtime } = started
  const asked = post(url, '/request', REQUEST, TOKEN)
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  const reset = await admin(started, 'POST', '/admin/pairings/p1/reset')
  expect(reset).toEqual({
    status: 200,
    body: {
      pairing: { id: 'p1', bot: 'b1', state: 'pending', code: 'PAIR-2222', keys: ['k1'] },
      code: 'PAIR-2222',
      instructions: 'Say PAIR2222 to fake',
    },
  })
  expect(await (await asked).json()).toEqual({ answer: 'Decline', timedOut: false })
  expect(runtime.handlers?.isPaired('u1')).toBe(false)
  expect(await getStatus(url, TOKEN)).toMatchObject({ paired: false, code: 'PAIR-2222' })
  expect(runtime.handlers?.pair?.('u3', 'PAIR2222')).toBe('paired')
  expect(await getStatus(url, TOKEN)).toMatchObject({ paired: true, key: 'k1', pairing: 'p1' })
  expect(readRegistry(started.configPath).pairings).toMatchObject([{ id: 'p1', person: 'u3' }])
  expect(await admin(started, 'POST', '/admin/pairings/p9/reset')).toEqual({
    status: 404,
    body: { error: 'unknown pairing "p9"' },
  })
})

test("a pairing on a bot that doesn't pair can't be reset", async () => {
  const started = await start({ providers: [createFakeProvider()], file: { apiToken: TOKEN } })
  expect(await admin(started, 'POST', '/admin/pairings/p1/reset')).toEqual({
    status: 400,
    body: { error: "pairing p1 is on bot b1, which doesn't pair" },
  })
  expect(await admin(started, 'POST', '/admin/pairings', { bot: 'b1' })).toEqual({
    status: 201,
    body: { pairing: { id: 'p1', bot: 'b1', person: 'local', state: 'paired', keys: ['k1'] } },
  })
})

test('removing a bot stops it and rejects the questions of its keys', async () => {
  const other = createFakeProvider()
  const stop = vi.fn(async () => undefined)
  const stopping: FakeProvider = {
    ...other,
    createRuntime: (settings, log) => {
      const runtime = other.createRuntime(settings, log)
      return Object.assign(runtime, { stop })
    },
  }
  const started = await start({ providers: [createPairingFakeProvider(), stopping] })
  await admin(started, 'POST', '/admin/bots', { provider: 'fake', settings: { fakeKey: 'two' } })
  const created = await admin(started, 'POST', '/admin/keys', { bot: 'b2' })
  const asked = post(started.url, '/request', REQUEST, created.body.key)
  await vi.waitFor(() => expect(other.runtimes.at(-1)?.sent).toHaveLength(1))
  expect(await admin(started, 'DELETE', '/admin/bots/b2')).toEqual({
    status: 200,
    body: { removedKeys: ['k2'] },
  })
  expect(await (await asked).json()).toEqual({ answer: 'Decline', timedOut: false })
  expect(stop).toHaveBeenCalled()
  const error = muteConsole()
  expect((await call(started.url, 'GET', '/status', { token: created.body.key })).status).toBe(401)
  error.mockRestore()
  const registry = readRegistry(started.configPath)
  expect(registry.bots.map((bot) => bot.id)).toEqual(['b1'])
  expect(registry.pairings.map((pairing) => pairing.id)).toEqual(['p1'])
  expect(await admin(started, 'DELETE', '/admin/bots/b2')).toEqual({
    status: 404,
    body: { error: 'unknown bot "b2"' },
  })
  expect(await getStatus(started.url, TOKEN)).toMatchObject({ paired: true, state: 'running' })
})

test('a second bot with the same credentials is a 409', async () => {
  const started = await start()
  const response = await admin(started, 'POST', '/admin/bots', {
    provider: 'fakepair',
    settings: { fakeKey: SEED_BOT_TOKEN },
  })
  expect(response).toEqual({
    status: 409,
    body: { error: 'bot b1 already uses these credentials' },
  })
  expect(JSON.stringify(response.body)).not.toContain(SEED_BOT_TOKEN)
  expect(
    await admin(started, 'POST', '/admin/bots', {
      provider: 'fake',
      settings: { fakeKey: SEED_BOT_TOKEN },
    }),
  ).toMatchObject({ status: 201, body: { bot: { id: 'b2' } } })
})

test('rotating the admin key invalidates the old one and rewrites the file', async () => {
  const started = await start()
  const rotated = await admin(started, 'POST', '/admin/admin-key')
  expect(rotated.status).toBe(200)
  expect(rotated.body).toEqual({ adminKey: expect.stringMatching(/^jpa_/) })
  const { adminKey } = rotated.body
  expect(adminKey).not.toBe(started.adminKey)
  const adminKeyPath = resolveAdminKeyPath(started.configPath)
  expect(readFileSync(adminKeyPath, 'utf8')).toBe(`${adminKey}\n`)
  expect(statSync(adminKeyPath).mode & 0o777).toBe(0o600)
  const error = muteConsole()
  expect((await call(started.url, 'GET', '/admin/bots', { token: started.adminKey })).status).toBe(
    401,
  )
  expect((await call(started.url, 'GET', '/status', { token: adminKey })).status).toBe(401)
  error.mockRestore()
  expect((await admin({ ...started, adminKey }, 'GET', '/admin/bots')).status).toBe(200)
})

test('admin log filters by bot, pairing and key', async () => {
  const other = createFakeProvider()
  const started = await start({ providers: [createPairingFakeProvider(), other] })
  const { url, runtime } = started
  await admin(started, 'POST', '/admin/bots', { provider: 'fake', settings: { fakeKey: 'two' } })
  const onSecondBot = await admin(started, 'POST', '/admin/keys', { bot: 'b2' })
  const sameAsFirst = await admin(started, 'POST', '/admin/keys', { sameAsKey: 'k1' })
  const second = other.runtimes.at(-1)
  const ask = async (
    token: string,
    project: string,
    target: FakeRuntime | undefined,
    sender: string | undefined,
  ) => {
    const count = target?.sent.length ?? 0
    const asked = post(url, '/request', { ...REQUEST, project }, token)
    await vi.waitFor(() => expect(target?.sent).toHaveLength(count + 1))
    target?.handlers?.answer(target.sent.at(-1)?.id ?? '', 0, sender)
    expect((await asked).status).toBe(200)
  }
  await ask(TOKEN, 'one', runtime, 'u1')
  await ask(onSecondBot.body.key, 'two', second, undefined)
  await ask(sameAsFirst.body.key, 'three', runtime, 'u1')
  const all = await admin(started, 'GET', '/admin/log')
  expect(all.status).toBe(200)
  expect(all.body.skippedCount).toBe(0)
  expect(
    all.body.entries.map((entry: Record<string, string>) => [
      entry.project,
      entry.bot,
      entry.key,
      entry.pairing,
    ]),
  ).toEqual([
    ['one', 'b1', 'k1', 'p1'],
    ['two', 'b2', 'k2', 'p2'],
    ['three', 'b1', 'k3', 'p1'],
  ])
  const projects = async (query: string) =>
    (await admin(started, 'GET', `/admin/log${query}`)).body.entries.map(
      (entry: Record<string, string>) => entry.project,
    )
  expect(await projects('?bot=b1')).toEqual(['one', 'three'])
  expect(await projects('?bot=b2')).toEqual(['two'])
  expect(await projects('?pairing=p1')).toEqual(['one', 'three'])
  expect(await projects('?key=k3')).toEqual(['three'])
  expect(await projects('?bot=b1&key=k1')).toEqual(['one'])
  expect(await projects('?project=two')).toEqual(['two'])
  expect(await projects('?limit=1')).toEqual(['three'])
  expect(await projects('?since=1h')).toEqual(['one', 'two', 'three'])
  expect(await admin(started, 'GET', '/admin/log?bot=b9')).toEqual({
    status: 200,
    body: { entries: [], skippedCount: 0 },
  })
  expect(await admin(started, 'GET', '/admin/log?limit=0')).toEqual({
    status: 400,
    body: { error: 'limit must be a positive integer' },
  })
  expect(await admin(started, 'GET', '/admin/log?key=k1&key=k2')).toEqual({
    status: 400,
    body: { error: 'key must be given once' },
  })
  const own = await call(url, 'GET', '/log', { token: TOKEN })
  expect((await own.json()).entries.map((entry: Record<string, string>) => entry.project)).toEqual([
    'one',
  ])
})

test("admin log serves every bot's questions from the db, removed bots included", async () => {
  const other = createFakeProvider()
  const started = await start({ providers: [createPairingFakeProvider(), other] })
  const { url, runtime } = started
  await admin(started, 'POST', '/admin/bots', { provider: 'fake', settings: { fakeKey: 'two' } })
  const onSecondBot = await admin(started, 'POST', '/admin/keys', { bot: 'b2' })
  const second = other.runtimes.at(-1)
  const ask = async (token: string, project: string, target: FakeRuntime | undefined) => {
    const asked = post(url, '/request', { ...REQUEST, project }, token)
    await vi.waitFor(() => expect(target?.sent).toHaveLength(1))
    target?.handlers?.answer(target.sent.at(-1)?.id ?? '', 0)
    expect((await asked).status).toBe(200)
  }
  await ask(TOKEN, 'one', runtime)
  await ask(onSecondBot.body.key, 'two', second)
  expect((await admin(started, 'DELETE', '/admin/bots/b2')).status).toBe(200)
  const all = await admin(started, 'GET', '/admin/log')
  expect(
    all.body.entries.map((entry: Record<string, string>) => [entry.project, entry.bot]),
  ).toEqual([
    ['one', 'b1'],
    ['two', 'b2'],
  ])
  const removed = await admin(started, 'GET', '/admin/log?bot=b2')
  expect(removed.status).toBe(200)
  expect(removed.body.entries.map((entry: Record<string, string>) => entry.project)).toEqual([
    'two',
  ])
})

test('pairing and key lists filter by bot and pairing', async () => {
  const started = await start()
  await admin(started, 'POST', '/admin/bots', { provider: 'fake', settings: { fakeKey: 'two' } })
  await admin(started, 'POST', '/admin/keys', { bot: 'b2' })
  expect(await admin(started, 'GET', '/admin/pairings?bot=b2')).toEqual({
    status: 200,
    body: { pairings: [{ id: 'p2', bot: 'b2', person: 'local', state: 'paired', keys: ['k2'] }] },
  })
  expect(await admin(started, 'GET', '/admin/keys?bot=b1')).toMatchObject({
    body: { keys: [{ id: 'k1' }] },
  })
  expect(await admin(started, 'GET', '/admin/pairings?bot=b9')).toEqual({
    status: 404,
    body: { error: 'unknown bot "b9"' },
  })
  expect(await admin(started, 'GET', '/admin/keys?pairing=p9')).toEqual({
    status: 404,
    body: { error: 'unknown pairing "p9"' },
  })
})

test.skipIf(IS_ROOT)('a failed registry write answers 500 and changes nothing', async () => {
  const started = await start()
  const hub = requireRunning().hub
  const registry = hub.registry
  const before = readRegistry(started.configPath)
  const error = muteConsole()
  // The db refuses registry writes; the read-only directory refuses the admin key file.
  const allowWrites = refuseRegistryWrites(started.configPath)
  chmodSync(dirname(started.configPath), 0o500)
  try {
    for (const [method, path, body] of [
      ['POST', '/admin/bots', { provider: 'fake', settings: { fakeKey: 'two' } }],
      ['POST', '/admin/pairings', { bot: 'b1' }],
      ['POST', '/admin/pairings/p1/reset', undefined],
      ['DELETE', '/admin/pairings/p1', undefined],
      ['POST', '/admin/keys', { sameAsKey: 'k1' }],
      ['PATCH', '/admin/keys/k1', { label: 'x' }],
      ['DELETE', '/admin/keys/k1', undefined],
      ['DELETE', '/admin/bots/b1', undefined],
      ['POST', '/admin/admin-key', undefined],
    ] as const) {
      expect(await admin(started, method, path, body), `${method} ${path}`).toEqual({
        status: 500,
        body: { error: 'internal server error' },
      })
    }
  } finally {
    chmodSync(dirname(started.configPath), 0o700)
    allowWrites()
  }
  error.mockRestore()
  expect(hub.registry).toBe(registry)
  expect(readRegistry(started.configPath)).toEqual(before)
  expect(await getStatus(started.url, TOKEN)).toMatchObject({ paired: true, state: 'running' })
  expect(started.runtime.handlers?.isPaired('u1')).toBe(true)
  expect((await admin(started, 'GET', '/admin/bots')).status).toBe(200)
  expect(readFileSync(resolveAdminKeyPath(started.configPath), 'utf8')).toBe(
    `${started.adminKey}\n`,
  )
})
