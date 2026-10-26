import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vite-plus/test'
import { OWNER_COMMANDS, QUIET_COMMANDS } from '@jaypost/core'
import type { Provider } from '@jaypost/core'
import {
  addBot,
  createEmptyRegistry,
  createKey,
  hashKey,
  loadSeed,
  RegistryStore,
  resolveAdminKeyPath,
  resolveRegistryPath,
} from '@jaypost/store'
import type { Registry } from '@jaypost/store'
import { createFakeProvider, createPairingFakeProvider } from '@jaypost/testing'
import type { FakeRuntime } from '@jaypost/testing'
import { startService } from '../../src/daemon/index.ts'
import type { RunningService } from '../../src/daemon/index.ts'

const TEST_VERSION = '1.2.3'

const TOKEN = 'a'.repeat(43)

const WRONG = 'b'.repeat(43)

const CODE = 'K7QM4XPD'

const REQUEST = { text: 'Deploy?', options: ['Approve', 'Decline'], timeoutOption: 'Decline' }

const EXPIRED_TEXT_PATTERN = /^Deploy\?\n\n⌛ Expired \(service restarted\), \d\d:\d\d$/

const IS_ROOT = process.getuid?.() === 0

type FakeProvider = Provider & { readonly runtimes: FakeRuntime[] }

let running: RunningService | undefined

afterEach(async () => {
  vi.useRealTimers()
  await running?.stop()
  running = undefined
})

/** A temp config directory with config.json holding `file`; returns config.json's path. */
function createInstall(file: Record<string, unknown>): string {
  const configPath = join(mkdtempSync(join(tmpdir(), 'jaypost-service-')), 'config.json')
  writeFileSync(configPath, JSON.stringify(file))
  return configPath
}

function createConfigPath(provider: Provider, file: Record<string, unknown> = {}): string {
  return createInstall({ provider: provider.name, fakeKey: 'k', ...file })
}

async function start(
  provider: FakeProvider,
  options: {
    readonly configPath?: string
    readonly log?: (line: string) => void
    readonly providers?: readonly Provider[]
    /** False to listen without waiting for the bots' first start attempts. */
    readonly waitForBots?: boolean
  } = {},
): Promise<{ url: string; runtime: FakeRuntime; configPath: string }> {
  const configPath = options.configPath ?? createConfigPath(provider)
  const providers = options.providers ?? [provider]
  running = await startService({
    version: TEST_VERSION,
    configPath,
    providers,
    seed: loadSeed({ JAYPOST_CONFIG: configPath }, providers),
    log: options.log ?? vi.fn(),
    generateCode: () => CODE,
  })
  if (options.waitForBots !== false) {
    await running.started
  }
  await running.server.listen({ port: 0, host: '127.0.0.1' })
  const { port } = running.server.server.address() as AddressInfo
  // The runtime that started, or the last one created when none did.
  const runtime =
    provider.runtimes.findLast((candidate) => candidate.handlers !== undefined) ??
    provider.runtimes.at(-1)
  if (runtime === undefined) {
    throw new Error('no runtime created')
  }
  return { url: `http://127.0.0.1:${port}`, runtime, configPath }
}

async function stopRunning(): Promise<void> {
  await running?.stop()
  running = undefined
}

function requireRunning(): RunningService {
  if (running === undefined) {
    throw new Error('not running')
  }
  return running
}

function createKeyFor(keyId: string): { readonly id: string; readonly key: string } {
  const created = requireRunning().hub.createKey({ sameAsKey: keyId })
  if ('kind' in created) {
    throw new Error(`no key ${keyId}`)
  }
  return created
}

function createRecordingProvider() {
  const finalized: { reference: unknown; text: string; ending: unknown }[] = []
  const deleted: unknown[] = []
  const provider = createFakeProvider({
    runtime: {
      finalize: async (reference, message, ending) => {
        finalized.push({ reference, text: message.text, ending })
      },
      sendNotification: async () => ({ n: 1000 }),
      deleteMessage: async (reference) => {
        deleted.push(reference)
      },
    },
  })
  return { provider, finalized, deleted }
}

function createSilentProvider() {
  const silent: boolean[] = []
  const provider = createFakeProvider({
    runtime: {
      sendNotification: async (_id, _text, options) => {
        silent.push(options.silent)
        return { n: 1 }
      },
    },
  })
  return { provider, silent }
}

/** state.json as the pre-upgrade daemon left it, next to config.json. */
function writeLegacyState(configPath: string, state: Record<string, unknown>): void {
  writeFileSync(
    join(dirname(configPath), 'state.json'),
    JSON.stringify({ version: 1, provider: 'fake', requests: [], notifications: [], ...state }),
  )
}

function botFile(configPath: string, botId: string, name: string): string {
  return join(dirname(configPath), 'bots', botId, name)
}

const readState = (configPath: string) =>
  JSON.parse(readFileSync(botFile(configPath, 'b1', 'state.json'), 'utf8'))

const readRegistry = (configPath: string): Registry =>
  new RegistryStore(resolveRegistryPath(configPath)).load()

const readAudit = (configPath: string) =>
  readFileSync(botFile(configPath, 'b1', 'audit.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))

const call = (
  url: string,
  method: string,
  path: string,
  options: { readonly token?: string; readonly body?: unknown; readonly signal?: AbortSignal } = {},
) =>
  fetch(`${url}${path}`, {
    method,
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })

const post = (url: string, path: string, body: unknown, token?: string, signal?: AbortSignal) =>
  call(url, 'POST', path, {
    body,
    ...(token === undefined ? {} : { token }),
    ...(signal === undefined ? {} : { signal }),
  })

const getStatus = async (url: string, token?: string) =>
  (await call(url, 'GET', '/status', token === undefined ? {} : { token })).json()

const muteConsole = () => vi.spyOn(console, 'error').mockImplementation(() => {})

test('an upgraded install keeps its token, owner and quiet hours as key 1 on bot 1', async () => {
  const provider = createPairingFakeProvider()
  const configPath = createConfigPath(provider, {
    fakeOwner: 'u1',
    apiToken: TOKEN,
    quietHours: '23:00-08:00',
  })
  const { url, runtime } = await start(provider, { configPath })
  expect(await getStatus(url, TOKEN)).toEqual({
    paired: true,
    key: 'k1',
    pairing: 'p1',
    state: 'running',
    provider: 'fakepair',
    displayName: 'fake',
    maxAttachmentBytes: 0,
    maxTextLength: 100,
  })
  const response = post(url, '/request', REQUEST, TOKEN)
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  expect(runtime.sent[0]?.recipient).toBe('u1')
  expect(runtime.handlers?.answer(runtime.sent[0]?.id ?? '', 0, 'u1')).toBe('accepted')
  expect(await (await response).json()).toEqual({ answer: 'Approve', timedOut: false })
  expect(readRegistry(configPath)).toMatchObject({
    bots: [{ id: 'b1', provider: 'fakepair', settings: { fakeKey: 'k' } }],
    pairings: [{ id: 'p1', botId: 'b1', person: 'u1', quietHours: '23:00-08:00' }],
    keys: [{ id: 'k1', pairingId: 'p1', hash: hashKey(TOKEN) }],
    seed: { botId: 'b1', pairingId: 'p1', keyId: 'k1', isOpen: false },
  })
  expect(runtime.handlers?.command('quiet', '', 'u1')).toContain('23:00')
})

test('a request pending before the upgrade is expired after it', async () => {
  const { provider, finalized, deleted } = createRecordingProvider()
  const configPath = createConfigPath(provider)
  writeLegacyState(configPath, {
    requests: [{ id: 'old', reference: { n: 99 }, text: 'Deploy?' }],
    notifications: [
      { id: 'due', reference: { n: 98 }, expiresAtMs: Date.now() - 1 },
      { id: 'later', reference: { n: 97 }, expiresAtMs: Date.now() + 60_000 },
    ],
  })
  const { runtime } = await start(provider, { configPath })
  await requireRunning().recover()
  expect(finalized).toEqual([
    {
      reference: { n: 99 },
      text: expect.stringMatching(EXPIRED_TEXT_PATTERN),
      ending: { kind: 'expired' },
    },
  ])
  expect(deleted).toEqual([{ n: 98 }])
  expect(runtime.handlers?.dismiss('later')).toBe(true)
  expect(readState(configPath).requests).toEqual([])
  expect(existsSync(join(dirname(configPath), 'state.json'))).toBe(false)
})

test('two keys on one pairing share the person; a key on another pairing reaches its own', async () => {
  const provider = createPairingFakeProvider()
  const configPath = createConfigPath(provider, { fakeOwner: 'u1', apiToken: TOKEN })
  const { url, runtime } = await start(provider, { configPath })
  const sameKey = createKeyFor('k1')
  const other = requireRunning().hub.createKey({ bot: 'b1' })
  if ('kind' in other) {
    throw new Error('no key')
  }
  expect(runtime.handlers?.pair?.('u2', CODE)).toBe('paired')
  for (const token of [TOKEN, sameKey.key, other.key]) {
    expect((await post(url, '/request/async', REQUEST, token)).status).toBe(202)
  }
  expect(runtime.sent.map((sent) => sent.recipient)).toEqual(['u1', 'u1', 'u2'])
  expect(readRegistry(configPath).pairings).toMatchObject([
    { id: 'p1', person: 'u1' },
    { id: 'p2', person: 'u2' },
  ])
})

test('someone already paired who redeems another code gets that key on their pairing', async () => {
  const provider = createPairingFakeProvider()
  const configPath = createConfigPath(provider, { fakeOwner: 'u1', apiToken: TOKEN })
  const { url, runtime } = await start(provider, { configPath })
  const created = requireRunning().hub.createKey({ bot: 'b1' })
  if ('kind' in created) {
    throw new Error('no key')
  }
  expect(runtime.handlers?.pair?.('u1', CODE)).toBe('paired')
  expect(await getStatus(url, created.key)).toMatchObject({ paired: true, pairing: 'p1' })
  const registry = readRegistry(configPath)
  expect(registry.pairings.map((pairing) => pairing.id)).toEqual(['p1'])
  expect(registry.keys).toMatchObject([
    { id: 'k1', pairingId: 'p1' },
    { id: 'k2', pairingId: 'p1' },
  ])
})

test("a key can't read or cancel another key's background question", async () => {
  const provider = createFakeProvider()
  const { url, runtime } = await start(provider, {
    configPath: createConfigPath(provider, { apiToken: TOKEN }),
  })
  const other = createKeyFor('k1')
  const created = await post(url, '/request/async', REQUEST, TOKEN)
  const { id } = (await created.json()) as { id: string }
  for (const method of ['GET', 'DELETE']) {
    const response = await call(url, method, `/request/${id}`, { token: other.key })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'unknown request' })
  }
  const own = await call(url, 'GET', `/request/${id}`, { token: TOKEN })
  expect(own.status).toBe(200)
  expect(await own.json()).toMatchObject({ id, state: 'pending' })
  expect(runtime.handlers?.answer(runtime.sent[0]?.id ?? '', 0)).toBe('accepted')
})

test('an unpaired key gets 503 and its code from /status', async () => {
  const provider = createPairingFakeProvider()
  const configPath = createConfigPath(provider, { fakeOwner: 'u1', apiToken: TOKEN })
  const { url, runtime } = await start(provider, { configPath })
  const created = requireRunning().hub.createKey({ bot: 'b1', label: 'ci' })
  expect(created).toEqual({
    id: 'k2',
    key: expect.stringMatching(/^jpk_/),
    pairing: 'p2',
    code: 'K7QM-4XPD',
    instructions: 'Say K7QM4XPD to fake',
  })
  if ('kind' in created) {
    throw new Error('no key')
  }
  const refused = await post(url, '/request', REQUEST, created.key)
  expect(refused.status).toBe(503)
  expect(await refused.json()).toEqual({ error: 'not paired' })
  expect((await post(url, '/notify', { text: 'hi' }, created.key)).status).toBe(501)
  expect(await getStatus(url, created.key)).toEqual({
    paired: false,
    key: 'k2',
    pairing: 'p2',
    state: 'running',
    provider: 'fakepair',
    displayName: 'fake',
    code: 'K7QM-4XPD',
    instructions: 'Say K7QM4XPD to fake',
    maxAttachmentBytes: 0,
    maxTextLength: 100,
  })
  expect(runtime.handlers?.pair?.('u2', 'k7qm-4xpd')).toBe('paired')
  expect(await getStatus(url, created.key)).toMatchObject({ paired: true, key: 'k2' })
  expect(readRegistry(configPath).keys).toMatchObject([
    { id: 'k1' },
    { id: 'k2', pairingId: 'p2', label: 'ci', hash: hashKey(created.key) },
  ])
})

test('GET /log only returns the caller key lines', async () => {
  const provider = createFakeProvider()
  const configPath = createConfigPath(provider)
  const legacyLine = {
    v: 1,
    event: 'asked',
    id: 'old',
    at: '2026-10-01T10:00:00.000Z',
    text: 'Old?',
    options: ['Yes'],
    timeoutOption: 'Yes',
    timeoutSeconds: 60,
  }
  writeFileSync(join(dirname(configPath), 'audit.jsonl'), `${JSON.stringify(legacyLine)}\n`)
  const { url, runtime } = await start(provider, { configPath })
  const other = createKeyFor('k1')
  for (const token of [undefined, other.key]) {
    const response = post(url, '/request', REQUEST, token)
    await vi.waitFor(() => expect(runtime.sent.length).toBeGreaterThan(token === undefined ? 0 : 1))
    runtime.handlers?.answer(runtime.sent.at(-1)?.id ?? '', 0)
    expect((await response).status).toBe(200)
  }
  const read = async (query: string, token?: string) => {
    const response = await call(url, 'GET', `/log${query}`, token === undefined ? {} : { token })
    expect(response.status).toBe(200)
    return response.json()
  }
  const otherLog = await read('', other.key)
  expect(otherLog).toMatchObject({
    entries: [{ key: 'k2', pairing: 'p1', status: 'answered', answer: 'Approve' }],
    skippedCount: 0,
  })
  expect(otherLog.entries).toHaveLength(1)
  const seedLog = await read('')
  expect(seedLog.entries.map((entry: { id: string }) => entry.id)).toEqual([
    'old',
    runtime.sent[0]?.id,
  ])
  expect((await read('?limit=1')).entries.map((entry: { id: string }) => entry.id)).toEqual([
    runtime.sent[0]?.id,
  ])
  expect((await read('?since=2026-10-02T00:00:00Z')).entries).toHaveLength(1)
  expect((await call(url, 'GET', '/log?since=yesterday')).status).toBe(400)
  expect((await call(url, 'GET', '/log?limit=-1')).status).toBe(400)
})

test('a tokenless install treats no token as key 1 and a wrong token as 401', async () => {
  const { url } = await start(createFakeProvider())
  expect(await getStatus(url)).toMatchObject({ paired: true, key: 'k1', pairing: 'p1' })
  const error = muteConsole()
  const wrong = await call(url, 'GET', '/status', { token: WRONG })
  error.mockRestore()
  expect(wrong.status).toBe(401)
  const created = createKeyFor('k1')
  expect(await getStatus(url, created.key)).toMatchObject({ paired: true, key: 'k2' })
})

test('the admin key is refused on question routes', async () => {
  const provider = createFakeProvider()
  const { url, configPath } = await start(provider)
  const adminKey = readFileSync(resolveAdminKeyPath(configPath), 'utf8').trim()
  expect(adminKey).toMatch(/^jpa_/)
  const error = muteConsole()
  expect((await call(url, 'GET', '/status', { token: adminKey })).status).toBe(401)
  expect((await post(url, '/request', REQUEST, adminKey)).status).toBe(401)
  expect((await call(url, 'GET', '/log', { token: adminKey })).status).toBe(401)
  expect(JSON.stringify(error.mock.calls)).not.toContain(adminKey)
  error.mockRestore()
})

test('a bot with rejected credentials shows failed in /status and the others keep working', async () => {
  const base = createFakeProvider()
  const provider: FakeProvider = {
    ...base,
    createRuntime: (settings, log) => {
      const runtime = base.createRuntime(settings, log)
      return settings.fakeKey === 'bad'
        ? { ...runtime, checkCredentials: async () => ({ ok: false, reason: 'fake said no' }) }
        : runtime
    },
  }
  const configPath = createConfigPath(provider, { fakeKey: 'good', apiToken: TOKEN })
  const at = new Date('2026-10-26T00:00:00.000Z')
  const added = addBot(createEmptyRegistry(), { provider, settings: { fakeKey: 'bad' } }, at)
  if (added.kind !== 'added') {
    throw new Error('not added')
  }
  const keyed = createKey(
    added.registry,
    { kind: 'newPairing', botId: 'b1' },
    hashKey(WRONG),
    {},
    CODE,
    false,
    at,
  )
  if (keyed.kind !== 'created') {
    throw new Error('not created')
  }
  new RegistryStore(resolveRegistryPath(configPath)).save(keyed.registry)
  const log = vi.fn()
  const { url, runtime } = await start(provider, { configPath, log })
  expect(log).toHaveBeenCalledWith("[b1] couldn't start: fake said no; retrying in 5s")
  expect(await getStatus(url, WRONG)).toEqual({
    paired: true,
    key: 'k1',
    pairing: 'p1',
    state: 'failed',
    error: 'fake said no',
    provider: 'fake',
    maxAttachmentBytes: 0,
    maxTextLength: 100,
  })
  const refused = await post(url, '/request', REQUEST, WRONG)
  expect(refused.status).toBe(503)
  expect(await refused.json()).toEqual({ error: 'bot unavailable' })
  expect(await getStatus(url, TOKEN)).toMatchObject({ key: 'k2', pairing: 'p2', state: 'running' })
  expect((await post(url, '/request/async', REQUEST, TOKEN)).status).toBe(202)
  expect(runtime.sent).toHaveLength(1)
  expect(existsSync(join(dirname(configPath), 'bots', 'b2'))).toBe(true)
})

test('a fatal provider error restarts that bot after a delay', async () => {
  const provider = createFakeProvider()
  const log = vi.fn()
  const { url, runtime } = await start(provider, { log })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  runtime.handlers?.fatal('connection lost')
  expect(log).toHaveBeenCalledWith('[b1] stopped: connection lost; retrying in 5s')
  expect(await getStatus(url)).toMatchObject({ state: 'failed', error: 'connection lost' })
  expect((await post(url, '/request', REQUEST)).status).toBe(503)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(provider.runtimes).toHaveLength(2)
  expect(await getStatus(url)).toMatchObject({ state: 'running' })
  runtime.handlers?.fatal('late fatal from the old runtime')
  expect(await getStatus(url)).toMatchObject({ state: 'running' })
})

test('a blocking question open at a fatal error is answered at once and settled once', async () => {
  const { provider, finalized } = createRecordingProvider()
  const { url, runtime, configPath } = await start(provider)
  await requireRunning().recover()
  const response = post(url, '/request', REQUEST)
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  const id = runtime.sent[0]?.id ?? ''
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  runtime.handlers?.fatal('connection lost')
  expect(await (await response).json()).toEqual({ answer: 'Decline', timedOut: false })
  expect(readState(configPath).requests).toEqual([])
  await vi.advanceTimersByTimeAsync(5_000)
  expect(provider.runtimes).toHaveLength(2)
  await requireRunning().recover()
  expect(finalized.map((entry) => entry.ending)).toEqual([{ kind: 'rejected', answer: 'Decline' }])
  const settled = readAudit(configPath).filter(
    (record) => record.event === 'settled' && record.id === id,
  )
  expect(settled).toMatchObject([{ outcome: 'rejected', answer: 'Decline' }])
})

test("a late code on an abandoned runtime can't take over a pairing already claimed", async () => {
  const provider = createPairingFakeProvider()
  const log = vi.fn()
  const configPath = createConfigPath(provider, { fakeOwner: 'u1', apiToken: TOKEN })
  const { url, runtime } = await start(provider, { configPath, log })
  const created = requireRunning().hub.createPairing({ bot: 'b1' })
  expect(created).toMatchObject({ pairing: { id: 'p2', state: 'pending' } })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  runtime.handlers?.fatal('connection lost')
  await vi.advanceTimersByTimeAsync(5_000)
  const restarted = provider.runtimes.at(-1)
  expect(restarted).not.toBe(runtime)
  expect(restarted?.handlers?.pair?.('u2', CODE)).toBe('paired')
  // The old runtime's codes still hold p2's code; the hub must refuse its claim.
  expect(runtime.handlers?.pair?.('u9', CODE)).toBe('paired')
  expect(log).toHaveBeenCalledWith("[b1] ignored a claim of pairing p2, which isn't pending")
  expect(requireRunning().hub.registry.pairings).toMatchObject([
    { id: 'p1', person: 'u1' },
    { id: 'p2', person: 'u2' },
  ])
  expect(readRegistry(configPath).pairings).toMatchObject([
    { id: 'p1', person: 'u1' },
    { id: 'p2', person: 'u2' },
  ])
  expect(await getStatus(url, TOKEN)).toMatchObject({ paired: true, state: 'running' })
})

test('the api answers while a bot is still starting', async () => {
  const { promise, resolve } = Promise.withResolvers<{ ok: true; displayName: string }>()
  const provider = createFakeProvider({ runtime: { checkCredentials: () => promise } })
  const { url } = await start(provider, { waitForBots: false })
  expect(await getStatus(url)).toEqual({
    paired: true,
    key: 'k1',
    pairing: 'p1',
    state: 'starting',
    provider: 'fake',
    maxAttachmentBytes: 0,
    maxTextLength: 100,
  })
  const refused = await post(url, '/request', REQUEST)
  expect(refused.status).toBe(503)
  expect(await refused.json()).toEqual({ error: 'bot unavailable' })
  resolve({ ok: true, displayName: 'fake' })
  await requireRunning().started
  expect(await getStatus(url)).toMatchObject({ state: 'running', displayName: 'fake' })
})

test('restarting with the same env keeps admin changes', async () => {
  const provider = createFakeProvider()
  const configPath = createConfigPath(provider, { apiToken: TOKEN })
  await start(provider, { configPath })
  const created = createKeyFor('k1')
  expect(requireRunning().hub.revokeKey('k1')).toEqual({})
  expect(requireRunning().hub.revokeKey('k1')).toEqual({
    kind: 'notFound',
    error: 'unknown key "k1"',
  })
  await stopRunning()
  const { url } = await start(provider, { configPath })
  const error = muteConsole()
  expect((await call(url, 'GET', '/status', { token: TOKEN })).status).toBe(401)
  error.mockRestore()
  expect(await getStatus(url, created.key)).toMatchObject({ key: 'k2' })
})

test('revoking a key rejects its open questions with their timeout option', async () => {
  const provider = createFakeProvider()
  const { url, runtime } = await start(provider)
  const created = createKeyFor('k1')
  const asked = post(url, '/request', REQUEST, created.key)
  const kept = post(url, '/request', REQUEST)
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(2))
  requireRunning().hub.revokeKey('k2')
  expect(await (await asked).json()).toEqual({ answer: 'Decline', timedOut: false })
  const error = muteConsole()
  expect((await call(url, 'GET', '/status', { token: created.key })).status).toBe(401)
  error.mockRestore()
  runtime.handlers?.answer(runtime.sent[1]?.id ?? '', 0)
  expect(await (await kept).json()).toEqual({ answer: 'Approve', timedOut: false })
})

test.skipIf(IS_ROOT)('a registry write failure leaves memory unchanged', async () => {
  const provider = createFakeProvider()
  const configPath = createConfigPath(provider, { apiToken: TOKEN })
  const { url } = await start(provider, { configPath })
  const registryPath = resolveRegistryPath(configPath)
  const before = readFileSync(registryPath, 'utf8')
  const hub = requireRunning().hub
  const registry = hub.registry
  chmodSync(dirname(configPath), 0o500)
  try {
    expect(() => hub.createKey({ sameAsKey: 'k1' })).toThrow()
    expect(() => hub.revokeKey('k1')).toThrow()
  } finally {
    chmodSync(dirname(configPath), 0o700)
  }
  expect(readFileSync(registryPath, 'utf8')).toBe(before)
  expect(hub.registry).toBe(registry)
  expect(await getStatus(url, TOKEN)).toMatchObject({ key: 'k1' })
  expect(hub.router.route(`Bearer ${TOKEN}`)).toMatchObject({ kind: 'key' })
})

test('status reports the effective attachment limit, 0 without support', async () => {
  const supported = await start(createFakeProvider({ maxAttachmentBytes: 1000 }))
  expect(await getStatus(supported.url)).toMatchObject({ maxAttachmentBytes: 1000 })
  await stopRunning()
  const plain = await start(createFakeProvider())
  expect(await getStatus(plain.url)).toMatchObject({ maxAttachmentBytes: 0 })
})

test('fake without optional parts: request is sent and an answer settles it', async () => {
  const { url, runtime } = await start(createFakeProvider())
  const response = post(url, '/request', REQUEST)
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  const sent = runtime.sent[0]
  expect(sent?.message).toEqual({ text: 'Deploy?', spans: [] })
  expect(sent?.recipient).toBeUndefined()
  expect(runtime.handlers?.answer(sent?.id ?? '', 1)).toBe('accepted')
  expect(await (await response).json()).toEqual({ answer: 'Decline', timedOut: false })
})

test('fake without optional parts: timeout and cancel settle, no finalize attempted', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { url, runtime } = await start(createFakeProvider())
  const timedOut = post(url, '/request', { ...REQUEST, timeout: 1 })
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  await vi.advanceTimersByTimeAsync(1000)
  expect(await (await timedOut).json()).toEqual({ answer: 'Decline', timedOut: true })
  vi.useRealTimers()
  const controller = new AbortController()
  const cancelled = post(url, '/request', REQUEST, undefined, controller.signal).catch(
    () => undefined,
  )
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(2))
  controller.abort()
  await cancelled
  // Give the server time to see the closed connection; an uncancelled request would accept.
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(runtime.handlers?.answer(runtime.sent[1]?.id ?? '', 0)).toBe('expired')
})

test('fake without pairing is paired from start', async () => {
  const { url } = await start(createFakeProvider())
  expect(await getStatus(url)).toEqual({
    paired: true,
    key: 'k1',
    pairing: 'p1',
    state: 'running',
    provider: 'fake',
    displayName: 'fake',
    maxAttachmentBytes: 0,
    maxTextLength: 100,
  })
})

test('fake without notifications gets 501 on /notify', async () => {
  const { url } = await start(createFakeProvider())
  expect((await post(url, '/notify', { text: 'hi' })).status).toBe(501)
})

test('pairing fake: unpaired status, pair, then paired and saved', async () => {
  const provider = createPairingFakeProvider()
  const log = vi.fn()
  const { url, runtime, configPath } = await start(provider, { log })
  expect(log).toHaveBeenCalledWith('[b1] Not paired. Say K7QM4XPD to fake')
  expect(await getStatus(url)).toEqual({
    paired: false,
    key: 'k1',
    pairing: 'p1',
    state: 'running',
    provider: 'fakepair',
    displayName: 'fake',
    code: 'K7QM-4XPD',
    instructions: 'Say K7QM4XPD to fake',
    maxAttachmentBytes: 0,
    maxTextLength: 100,
  })
  expect(runtime.handlers?.pair?.('u1', 'k7qm-4xpd')).toBe('paired')
  expect(await getStatus(url)).toMatchObject({ paired: true, key: 'k1', pairing: 'p1' })
  expect(readRegistry(configPath).pairings).toMatchObject([{ id: 'p1', person: 'u1' }])
  expect(readRegistry(configPath).pairings[0]).not.toHaveProperty('code')
  const otherLines = log.mock.calls.filter(([line]) => !String(line).includes('Not paired.'))
  expect(JSON.stringify(otherLines)).not.toContain(CODE)
})

test('the paired owner is who the daemon answers for and sends to', async () => {
  const { url, runtime } = await start(createPairingFakeProvider())
  expect(runtime.handlers?.isPaired('u1')).toBe(false)
  expect(runtime.handlers?.listPaired()).toEqual([])
  expect(runtime.handlers?.pair?.('u1', CODE)).toBe('paired')
  expect(runtime.handlers?.isPaired('u1')).toBe(true)
  expect(runtime.handlers?.isPaired('u2')).toBe(false)
  expect(runtime.handlers?.listPaired()).toEqual(['u1'])
  const response = post(url, '/request', REQUEST)
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  expect(runtime.sent[0]?.recipient).toBe('u1')
  runtime.handlers?.answer(runtime.sent[0]?.id ?? '', 0, 'u1')
  expect((await response).status).toBe(200)
})

test.skipIf(IS_ROOT)(
  'a registry save failure on pairing is logged and pairing still completes',
  async () => {
    const log = vi.fn()
    const { url, runtime, configPath } = await start(createPairingFakeProvider(), { log })
    chmodSync(dirname(configPath), 0o500)
    try {
      expect(runtime.handlers?.pair?.('u1', CODE)).toBe('paired')
    } finally {
      chmodSync(dirname(configPath), 0o700)
    }
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[b1\] paired u1 but couldn't save the registry: .*; it'll be lost on restart$/,
      ),
    )
    expect(await getStatus(url)).toMatchObject({ paired: true, key: 'k1' })
    expect(readRegistry(configPath).pairings).toMatchObject([{ id: 'p1', code: CODE }])
  },
)

test('an owner setting without pairing support fails the bot, not the service', async () => {
  const provider = createFakeProvider({ settings: createPairingFakeProvider().settings })
  const { url } = await start(provider)
  expect(await getStatus(url)).toMatchObject({
    paired: false,
    state: 'failed',
    error: 'provider "fake" has an owner setting but no pairing support',
    code: 'K7QM-4XPD',
  })
})

test('a missing setting on an empty registry is refused with its message', async () => {
  const provider = createFakeProvider()
  const configPath = createInstall({ provider: 'fake' })
  await expect(
    startService({
      version: TEST_VERSION,
      configPath,
      providers: [provider],
      seed: loadSeed({ JAYPOST_CONFIG: configPath }, [provider]),
      log: vi.fn(),
    }),
  ).rejects.toThrow('missing fake key')
})

test('a missing setting is fine once the registry has bots', async () => {
  const provider = createFakeProvider()
  const configPath = createConfigPath(provider)
  await start(provider, { configPath })
  await stopRunning()
  writeFileSync(configPath, JSON.stringify({ provider: 'fake' }))
  const { url } = await start(provider, { configPath })
  expect(await getStatus(url)).toMatchObject({ key: 'k1', state: 'running' })
})

test('cancel command answers a pending request with its timeout option', async () => {
  const { url, runtime } = await start(createFakeProvider())
  const response = post(url, '/request', REQUEST)
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  expect(runtime.handlers?.command('cancel', '', undefined)).toMatch(
    /^Rejected 1\n\nDeploy\?\n→ Decline/,
  )
  const result = await response
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({ answer: 'Decline', timedOut: false })
})

test('handlers carry the owner and quiet commands and stay silent for unknown ones', async () => {
  const { runtime } = await start(createFakeProvider())
  expect(runtime.handlers?.commands).toEqual([...OWNER_COMMANDS, ...QUIET_COMMANDS])
  expect(runtime.handlers?.command('nope', '', undefined)).toBeUndefined()
  expect(runtime.handlers?.command('pending', '', undefined)).toBe('Nothing pending.')
})

test('notifications go out silently while muted and ping again after /unmute', async () => {
  const { provider, silent } = createSilentProvider()
  const { url, runtime } = await start(provider)
  await post(url, '/notify', { text: 'a' })
  runtime.handlers?.command('mute', '2h', undefined)
  await post(url, '/notify', { text: 'b' })
  runtime.handlers?.command('unmute', '', undefined)
  await post(url, '/notify', { text: 'c' })
  expect(silent).toEqual([false, true, false])
})

test('/mute is saved to the pairing and a restarted service is still muted', async () => {
  const { provider, silent } = createSilentProvider()
  const configPath = createConfigPath(provider)
  const first = await start(provider, { configPath })
  expect(first.runtime.handlers?.command('mute', '2h', undefined)).toMatch(/^Muted until /)
  const [pairing] = readRegistry(configPath).pairings
  const drift = new Date(pairing?.mutedUntil ?? 0).getTime() - (Date.now() + 2 * 3_600_000)
  expect(Math.abs(drift)).toBeLessThan(60_000)
  await stopRunning()
  const second = await start(provider, { configPath })
  expect(second.runtime.handlers?.command('quiet', '', undefined)).toContain('Muted until')
  await post(second.url, '/notify', { text: 'x' })
  expect(silent).toEqual([true])
})

test('/quiet off removes quietHours from the pairing', async () => {
  const { provider } = createSilentProvider()
  const { runtime, configPath } = await start(provider)
  runtime.handlers?.command('quiet', '23-8', undefined)
  expect(readRegistry(configPath).pairings[0]?.quietHours).toBeDefined()
  runtime.handlers?.command('quiet', 'off', undefined)
  expect(readRegistry(configPath).pairings[0]).not.toHaveProperty('quietHours')
})

test.skipIf(IS_ROOT)("an unwritable registry still mutes and says it won't last", async () => {
  const { provider, silent } = createSilentProvider()
  const { url, runtime, configPath } = await start(provider)
  chmodSync(dirname(configPath), 0o500)
  let reply: string | undefined
  try {
    reply = runtime.handlers?.command('mute', '2h', undefined)
  } finally {
    chmodSync(dirname(configPath), 0o700)
  }
  expect(reply).toMatch(/Couldn't save this; it resets on restart\.$/)
  await post(url, '/notify', { text: 'x' })
  expect(silent).toEqual([true])
})

test('a request pending at stop is expired by the next start', async () => {
  const { provider, finalized } = createRecordingProvider()
  const configPath = createConfigPath(provider)
  const first = await start(provider, { configPath })
  void post(first.url, '/request', REQUEST).catch(() => undefined)
  await vi.waitFor(() => expect(first.runtime.sent).toHaveLength(1))
  await stopRunning()
  await start(provider, { configPath })
  await requireRunning().recover()
  expect(finalized).toContainEqual({
    reference: { n: 1 },
    text: expect.stringMatching(EXPIRED_TEXT_PATTERN),
    ending: { kind: 'expired' },
  })
  expect(readState(configPath).requests).toEqual([])
})

test('a background question pending at stop is expired by the next start', async () => {
  const { provider, finalized } = createRecordingProvider()
  const configPath = createConfigPath(provider)
  const first = await start(provider, { configPath })
  const created = await post(first.url, '/request/async', REQUEST)
  expect(created.status).toBe(202)
  const { id } = (await created.json()) as { id: string }
  await stopRunning()
  const second = await start(provider, { configPath })
  await requireRunning().recover()
  expect(finalized).toContainEqual({
    reference: { n: 1 },
    text: expect.stringMatching(EXPIRED_TEXT_PATTERN),
    ending: { kind: 'expired' },
  })
  expect(readState(configPath).requests).toEqual([])
  expect((await call(second.url, 'GET', `/request/${id}`)).status).toBe(404)
})

test('state from another provider is discarded', async () => {
  const { provider, finalized } = createRecordingProvider()
  const configPath = createConfigPath(provider)
  writeLegacyState(configPath, {
    provider: 'other',
    requests: [{ id: 'old', reference: { n: 99 }, text: 'Deploy?' }],
  })
  const log = vi.fn()
  await start(provider, { configPath, log })
  await requireRunning().recover()
  expect(finalized).toEqual([])
  expect(log).toHaveBeenCalledWith(
    `[b1] ignoring state file ${JSON.stringify(botFile(configPath, 'b1', 'state.json'))}: written for provider "other"`,
  )
})

test("an unwritable state file doesn't fail /request or /notify", async () => {
  const { provider } = createRecordingProvider()
  const configPath = createConfigPath(provider)
  mkdirSync(join(dirname(configPath), 'state.json'))
  const log = vi.fn()
  const { url, runtime } = await start(provider, { configPath, log })
  expect((await post(url, '/notify', { text: 'hi' })).status).toBe(200)
  const response = post(url, '/request', REQUEST)
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  runtime.handlers?.answer(runtime.sent[0]?.id ?? '', 0)
  expect((await response).status).toBe(200)
  expect(log).toHaveBeenCalledWith(expect.stringContaining('failed to save state to'))
})

test('the service puts the configured token on the api', async () => {
  const provider = createFakeProvider()
  const { url } = await start(provider, {
    configPath: createConfigPath(provider, { apiToken: TOKEN }),
  })
  const error = muteConsole()
  expect((await call(url, 'GET', '/status')).status).toBe(401)
  error.mockRestore()
  expect((await call(url, 'GET', '/status', { token: TOKEN })).status).toBe(200)
})

test('a text question over http is answered through handlers.reply', async () => {
  const { url, runtime } = await start(createFakeProvider())
  const response = post(url, '/request', {
    text: 'Which branch?',
    allowText: true,
    timeoutOption: 'main',
  })
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  const [sent] = runtime.sent
  expect(sent).toMatchObject({
    message: { text: 'Which branch?', spans: [] },
    options: [],
    allowText: true,
  })
  expect(runtime.handlers?.reply(sent?.id ?? '', 'feature/x')).toBe('accepted')
  expect(await (await response).json()).toEqual({ answer: 'feature/x', timedOut: false })
  expect(runtime.handlers?.reply(sent?.id ?? '', 'again')).toBe('expired')
})

test('an answered request is written to the bot audit log with its key', async () => {
  const { url, runtime, configPath } = await start(createFakeProvider())
  const response = post(url, '/request', REQUEST)
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  const id = runtime.sent[0]?.id ?? ''
  runtime.handlers?.answer(id, 0)
  await response
  const records = readAudit(configPath)
  expect(records).toHaveLength(2)
  expect(records[0]).toMatchObject({ event: 'asked', id, key: 'k1', pairing: 'p1' })
  expect(records[1]).toMatchObject({ event: 'settled', id, outcome: 'answered', answer: 'Approve' })
})
