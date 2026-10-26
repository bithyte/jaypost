import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vite-plus/test'
import { OWNER_COMMANDS, QUIET_COMMANDS } from '@jaypost/core'
import { loadConfig, NO_AUTH } from '@jaypost/store'
import type { Config } from '@jaypost/store'
import { startService } from '../../src/daemon/index.ts'
import type { RunningService } from '../../src/daemon/index.ts'
import type { Provider } from '@jaypost/core'
import { createFakeProvider, createPairingFakeProvider } from '@jaypost/testing'
import type { FakeRuntime } from '@jaypost/testing'

const TEST_VERSION = '1.2.3'

const REQUEST = { text: 'Deploy?', options: ['Approve', 'Decline'], timeoutOption: 'Decline' }

let running: RunningService | undefined

afterEach(async () => {
  vi.useRealTimers()
  await running?.stop()
  running = undefined
})

function createConfig(provider: Provider, settings = { fakeKey: 'k' }): Config {
  return { provider, settings, port: 0, host: '127.0.0.1', auth: NO_AUTH }
}

function createConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'tab-daemon-')), 'config.json')
}

async function start(
  provider: Provider & { readonly runtimes: FakeRuntime[] },
  options: { configPath?: string; log?: (line: string) => void; config?: Config } = {},
): Promise<{ url: string; runtime: FakeRuntime }> {
  running = await startService({
    version: TEST_VERSION,
    config: options.config ?? createConfig(provider),
    configPath: options.configPath ?? createConfigPath(),
    fatal: vi.fn(),
    log: options.log ?? vi.fn(),
    generateCode: () => 'K7QM4XPD',
  })
  await running.server.listen({ port: 0, host: '127.0.0.1' })
  const { port } = running.server.server.address() as AddressInfo
  const runtime = provider.runtimes.at(-1)
  if (runtime === undefined) {
    throw new Error('no runtime created')
  }
  return { url: `http://127.0.0.1:${port}`, runtime }
}

const EXPIRED_TEXT_PATTERN = /^Deploy\?\n\n⌛ Expired \(service restarted\), \d\d:\d\d$/

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

function statePathOf(configPath: string): string {
  return join(dirname(configPath), 'state.json')
}

function writeState(configPath: string, state: Record<string, unknown>): void {
  writeFileSync(
    statePathOf(configPath),
    JSON.stringify({ version: 1, provider: 'fake', requests: [], notifications: [], ...state }),
  )
}

const recoverRunning = async (): Promise<void> => {
  await running?.recover()
}

const readState = (configPath: string) => JSON.parse(readFileSync(statePathOf(configPath), 'utf8'))

const post = (url: string, path: string, body: unknown, signal?: AbortSignal) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    signal,
  })

const getStatus = async (url: string) => (await fetch(`${url}/status`)).json()

test('status reports the effective attachment limit, 0 without support', async () => {
  const supported = await start(createFakeProvider({ maxAttachmentBytes: 1000 }))
  expect(await getStatus(supported.url)).toMatchObject({ maxAttachmentBytes: 1000 })
  const plain = await start(createFakeProvider())
  expect(await getStatus(plain.url)).toMatchObject({ maxAttachmentBytes: 0 })
})

test('fake without optional parts: request is sent and an answer settles it', async () => {
  const { url, runtime } = await start(createFakeProvider())
  const response = post(url, '/request', REQUEST)
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  const sent = runtime.sent[0]
  expect(sent?.message).toEqual({ text: 'Deploy?', spans: [] })
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
  const cancelled = post(url, '/request', REQUEST, controller.signal).catch(() => undefined)
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(2))
  controller.abort()
  await cancelled
  // Give the server time to see the closed connection; an uncancelled request would accept.
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(runtime.handlers?.answer(runtime.sent[1]?.id ?? '', 0)).toBe('expired')
})

test('fake without pairing is paired from start', async () => {
  const { url, runtime } = await start(createFakeProvider())
  expect(await getStatus(url)).toEqual({
    paired: true,
    provider: 'fake',
    displayName: 'fake',
    maxAttachmentBytes: 0,
    maxTextLength: 100,
  })
  const response = post(url, '/request', REQUEST)
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  runtime.handlers?.answer(runtime.sent[0]?.id ?? '', 0)
  expect((await response).status).toBe(200)
})

test('fake without notifications gets 501 on /notify', async () => {
  const { url } = await start(createFakeProvider())
  expect((await post(url, '/notify', { text: 'hi' })).status).toBe(501)
})

test('pairing fake: unpaired status, pair, then paired and saved', async () => {
  const configPath = createConfigPath()
  const log = vi.fn()
  const { url, runtime } = await start(createPairingFakeProvider(), { configPath, log })
  expect(log).toHaveBeenCalledWith('Not paired. Say K7QM4XPD to fake')
  expect(await getStatus(url)).toEqual({
    paired: false,
    provider: 'fakepair',
    displayName: 'fake',
    code: 'K7QM-4XPD',
    instructions: 'Say K7QM4XPD to fake',
    maxAttachmentBytes: 0,
    maxTextLength: 100,
  })
  expect(runtime.handlers?.pair?.('u1', 'k7qm-4xpd')).toBe('paired')
  expect(await getStatus(url)).toEqual({
    paired: true,
    provider: 'fakepair',
    displayName: 'fake',
    maxAttachmentBytes: 0,
    maxTextLength: 100,
  })
  expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ fakeOwner: 'u1' })
})

test('the paired owner is who the daemon answers for and sends to', async () => {
  const { url, runtime } = await start(createPairingFakeProvider(), {
    configPath: createConfigPath(),
  })
  expect(runtime.handlers?.isPaired('u1')).toBe(false)
  expect(runtime.handlers?.listPaired()).toEqual([])
  expect(runtime.handlers?.pair?.('u1', 'K7QM4XPD')).toBe('paired')
  expect(runtime.handlers?.isPaired('u1')).toBe(true)
  expect(runtime.handlers?.isPaired('u2')).toBe(false)
  expect(runtime.handlers?.listPaired()).toEqual(['u1'])
  void post(url, '/request', REQUEST).catch(() => undefined)
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  expect(runtime.sent[0]?.recipient).toBe('u1')
  runtime.handlers?.answer(runtime.sent[0]?.id ?? '', 0)
})

test('owner save failure is logged and pairing still completes', async () => {
  const blocker = join(mkdtempSync(join(tmpdir(), 'tab-daemon-')), 'file')
  writeFileSync(blocker, '')
  const configPath = join(blocker, 'config.json')
  const log = vi.fn()
  const { url, runtime } = await start(createPairingFakeProvider(), { configPath, log })
  expect(runtime.handlers?.pair?.('u1', 'K7QM4XPD')).toBe('paired')
  expect(log).toHaveBeenCalledWith(
    `paired with u1 but couldn't save the owner to ${configPath}; it'll be lost on restart`,
  )
  expect(await getStatus(url)).toEqual({
    paired: true,
    provider: 'fakepair',
    displayName: 'fake',
    maxAttachmentBytes: 0,
    maxTextLength: 100,
  })
})

test('unparseable owner is logged and not saved', async () => {
  const base = createPairingFakeProvider()
  const provider = {
    ...base,
    settings: base.settings.map((setting) =>
      setting.owner ? { ...setting, parse: () => undefined } : setting,
    ),
  }
  const configPath = createConfigPath()
  const log = vi.fn()
  const { runtime } = await start(provider, { configPath, log })
  expect(runtime.handlers?.pair?.('u1', 'K7QM4XPD')).toBe('paired')
  expect(log).toHaveBeenCalledWith(
    `paired with u1 but couldn't save the owner to ${configPath}; it'll be lost on restart`,
  )
  expect(existsSync(configPath) ? readFileSync(configPath, 'utf8') : '{}').not.toContain(
    'fakeOwner',
  )
})

test('rejected credentials throw with the provider reason', async () => {
  const provider = createFakeProvider({
    runtime: { checkCredentials: async () => ({ ok: false, reason: 'fake said no' }) },
  })
  await expect(
    startService({
      version: TEST_VERSION,
      config: createConfig(provider),
      configPath: createConfigPath(),
      fatal: vi.fn(),
      log: vi.fn(),
    }),
  ).rejects.toThrow('fake said no')
})

test('owner setting without pairing support is refused at start', async () => {
  const provider = createFakeProvider({ settings: createPairingFakeProvider().settings })
  await expect(
    startService({
      version: TEST_VERSION,
      config: createConfig(provider),
      configPath: createConfigPath(),
      fatal: vi.fn(),
      log: vi.fn(),
    }),
  ).rejects.toThrow('provider "fake" has an owner setting but no pairing support')
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

test('/mute is saved and a restarted service is still muted', async () => {
  const configPath = createConfigPath()
  const { provider, silent } = createSilentProvider()
  const first = await start(provider, { configPath })
  expect(first.runtime.handlers?.command('mute', '2h', undefined)).toMatch(/^Muted until /)
  const saved = JSON.parse(readFileSync(configPath, 'utf8'))
  const drift = new Date(saved.mutedUntil).getTime() - (Date.now() + 2 * 3_600_000)
  expect(Math.abs(drift)).toBeLessThan(60_000)
  await running?.stop()
  running = undefined
  const config = loadConfig(
    { JAYPOST_CONFIG: configPath, JAYPOST_PROVIDER: 'fake', FAKE_KEY: 'k' },
    [provider],
  )
  const second = await start(provider, { configPath, config })
  expect(second.runtime.handlers?.command('quiet', '', undefined)).toContain('Muted until')
  await post(second.url, '/notify', { text: 'x' })
  expect(silent).toEqual([true])
})

test('/quiet off removes quietHours from the config file', async () => {
  const configPath = createConfigPath()
  writeFileSync(configPath, JSON.stringify({ port: 1234 }))
  const { runtime } = await start(createSilentProvider().provider, { configPath })
  runtime.handlers?.command('quiet', '23-8', undefined)
  expect(JSON.parse(readFileSync(configPath, 'utf8')).quietHours).toBeDefined()
  runtime.handlers?.command('quiet', 'off', undefined)
  expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ port: 1234 })
})

test("an unwritable config still mutes and says it won't last", async () => {
  const configPath = createConfigPath()
  mkdirSync(configPath)
  const { provider, silent } = createSilentProvider()
  const { url, runtime } = await start(provider, { configPath })
  const reply = runtime.handlers?.command('mute', '2h', undefined)
  expect(reply).toMatch(/Couldn't save this; it resets on restart\.$/)
  await post(url, '/notify', { text: 'x' })
  expect(silent).toEqual([true])
})

test('a request pending at stop is expired by the next start', async () => {
  const configPath = createConfigPath()
  const { provider, finalized } = createRecordingProvider()
  const first = await start(provider, { configPath })
  void post(first.url, '/request', REQUEST).catch(() => undefined)
  await vi.waitFor(() => expect(first.runtime.sent).toHaveLength(1))
  await running?.stop()
  running = undefined
  await start(provider, { configPath })
  await recoverRunning()
  expect(finalized).toContainEqual({
    reference: { n: 1 },
    text: expect.stringMatching(EXPIRED_TEXT_PATTERN),
    ending: { kind: 'expired' },
  })
  expect(readState(configPath).requests).toEqual([])
})

test('a background question pending at stop is expired by the next start', async () => {
  const configPath = createConfigPath()
  const { provider, finalized } = createRecordingProvider()
  const first = await start(provider, { configPath })
  const created = await post(first.url, '/request/async', REQUEST)
  expect(created.status).toBe(202)
  const { id } = (await created.json()) as { id: string }
  await running?.stop()
  running = undefined
  const second = await start(provider, { configPath })
  await recoverRunning()
  expect(finalized).toContainEqual({
    reference: { n: 1 },
    text: expect.stringMatching(EXPIRED_TEXT_PATTERN),
    ending: { kind: 'expired' },
  })
  expect(readState(configPath).requests).toEqual([])
  expect((await fetch(`${second.url}/request/${id}`)).status).toBe(404)
})

test('a request left by a crash is expired on start', async () => {
  const configPath = createConfigPath()
  writeState(configPath, { requests: [{ id: 'old', reference: { n: 99 }, text: 'Deploy?' }] })
  const { provider, finalized } = createRecordingProvider()
  await start(provider, { configPath })
  await recoverRunning()
  expect(finalized).toEqual([
    {
      reference: { n: 99 },
      text: expect.stringMatching(EXPIRED_TEXT_PATTERN),
      ending: { kind: 'expired' },
    },
  ])
  expect(readState(configPath).requests).toEqual([])
})

test('notifications are restored across a restart', async () => {
  const configPath = createConfigPath()
  writeState(configPath, {
    notifications: [
      { id: 'due', reference: { n: 98 }, expiresAtMs: Date.now() - 1 },
      { id: 'later', reference: { n: 97 }, expiresAtMs: Date.now() + 60_000 },
    ],
  })
  const { provider, deleted } = createRecordingProvider()
  const { runtime } = await start(provider, { configPath })
  await recoverRunning()
  expect(deleted).toEqual([{ n: 98 }])
  expect(runtime.handlers?.dismiss('later')).toBe(true)
})

test('state from another provider is discarded', async () => {
  const configPath = createConfigPath()
  writeState(configPath, {
    provider: 'other',
    requests: [{ id: 'old', reference: { n: 99 }, text: 'Deploy?' }],
  })
  const { provider, finalized } = createRecordingProvider()
  const log = vi.fn()
  await start(provider, { configPath, log })
  await recoverRunning()
  expect(finalized).toEqual([])
  expect(log).toHaveBeenCalledWith(
    `ignoring state file ${JSON.stringify(statePathOf(configPath))}: written for provider "other"`,
  )
})

test("a corrupt state file doesn't stop startup", async () => {
  const configPath = createConfigPath()
  writeFileSync(statePathOf(configPath), '{')
  const log = vi.fn()
  const { url } = await start(createRecordingProvider().provider, { configPath, log })
  expect((await fetch(`${url}/status`)).status).toBe(200)
  expect(log).toHaveBeenCalledWith(
    `ignoring state file ${JSON.stringify(statePathOf(configPath))}: invalid JSON`,
  )
})

test("an unwritable state file doesn't fail /request or /notify", async () => {
  const configPath = createConfigPath()
  mkdirSync(statePathOf(configPath))
  const log = vi.fn()
  const { url, runtime } = await start(createRecordingProvider().provider, { configPath, log })
  const notified = await post(url, '/notify', { text: 'hi' })
  expect(notified.status).toBe(200)
  const response = post(url, '/request', REQUEST)
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  runtime.handlers?.answer(runtime.sent[0]?.id ?? '', 0)
  expect((await response).status).toBe(200)
  expect(log).toHaveBeenCalledWith(expect.stringContaining('failed to save state to'))
})

test('the service puts the configured token on the api', async () => {
  const token = 'a'.repeat(43)
  const provider = createFakeProvider()
  running = await startService({
    version: TEST_VERSION,
    config: { ...createConfig(provider), auth: { kind: 'token', token } },
    configPath: createConfigPath(),
    fatal: vi.fn(),
    log: vi.fn(),
  })
  await running.server.listen({ port: 0, host: '127.0.0.1' })
  const { port } = running.server.server.address() as AddressInfo
  const url = `http://127.0.0.1:${port}`
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect((await fetch(`${url}/status`)).status).toBe(401)
  error.mockRestore()
  expect(
    (await fetch(`${url}/status`, { headers: { authorization: `Bearer ${token}` } })).status,
  ).toBe(200)
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

test('answered request is written to audit.jsonl next to the config', async () => {
  const configPath = createConfigPath()
  const { url, runtime } = await start(createFakeProvider(), { configPath })
  const response = post(url, '/request', REQUEST)
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  const id = runtime.sent[0]?.id ?? ''
  runtime.handlers?.answer(id, 0)
  await response
  const records = readFileSync(join(dirname(configPath), 'audit.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  expect(records).toHaveLength(2)
  expect(records[0]).toMatchObject({ event: 'asked', id })
  expect(records[1]).toMatchObject({ event: 'settled', id, outcome: 'answered', answer: 'Approve' })
})
