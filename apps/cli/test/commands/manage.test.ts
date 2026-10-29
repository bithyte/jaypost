import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import {
  loadSeed,
  NO_CLIENT_TOKEN,
  openDatabase,
  RegistryStore,
  resolveDatabasePath,
  writeTokenFile,
} from '@jaypost/store'
import type { Registry } from '@jaypost/store'
import type { ClientToken } from '@jaypost/store'
import {
  ADMIN_KEY_REJECTED_MESSAGE,
  ADMIN_TOO_OLD_MESSAGE,
  TOKEN_REJECTED_MESSAGE,
  TOKEN_REQUIRED_MESSAGE,
} from '@jaypost/client'
import { startService } from '@jaypost/service'
import type { RunningService } from '@jaypost/service'
import {
  defaultFetchStatus,
  resolveResetOwnerToken,
  runResetOwner,
  runStatus,
  runUninstall,
} from '../../src/commands/index.ts'
import type { StatusFetch, WaitOptions } from '../../src/commands/index.ts'
import type { StatusInfo } from '@jaypost/protocol'
import {
  DEFAULT_START_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  UNAUTHORIZED_STATUS,
  UNREACHABLE_STATUS,
} from '../../src/commands/constants.ts'
import { createTargets, resolveInstallPaths, writeInstall } from '@jaypost/install'
import type { InstallPaths, Target, TargetName } from '@jaypost/install'
import { PROVIDERS, telegramProvider } from '@jaypost/providers'
import { createRecordingProgress } from '../progress/recording.ts'
import { createFakeProvider, createPairingFakeProvider } from '@jaypost/testing'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

let tmp: string
let paths: InstallPaths
let order: string[]
let out: string[]
let recording = createRecordingProgress()

/** The registry in the db next to `configPath`, read over a connection of its own. */
function readRegistry(configPath: string): Registry {
  const database = openDatabase(resolveDatabasePath(configPath))
  try {
    return new RegistryStore(database).load()
  } finally {
    database.close()
  }
}

function notes(): string[] {
  return recording.notes()
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'manage-'))
  paths = resolveInstallPaths({ HOME: tmp, XDG_CONFIG_HOME: join(tmp, 'cfg') })
  order = []
  out = []
  recording = createRecordingProgress()
})

function fake(name: TargetName, running = true): Mutable<Target> {
  return {
    name,
    available: vi.fn(),
    install: vi.fn(),
    upgrade: vi.fn(),
    readSecrets: vi.fn(),
    remove: vi.fn(async () => {
      order.push('remove')
    }),
    restart: vi.fn(async () => {
      order.push('restart')
    }),
    clearOwner: vi.fn(async () => {
      order.push('clearOwner')
    }),
    forgetSeedOwner: vi.fn(async () => {
      order.push('forgetSeedOwner')
    }),
    isRunning: vi.fn(async () => running),
    readAuditLog: vi.fn(),
    readAdminKey: vi.fn(async () => ADMIN_KEY),
    logsHint: vi.fn(() => 'logs hint'),
  } as unknown as Mutable<Target>
}

function targets(over: Partial<Record<TargetName, Target>> = {}) {
  return {
    quadlet: fake('quadlet'),
    compose: fake('compose'),
    systemd: fake('systemd'),
    launchd: fake('launchd'),
    ...over,
  }
}

function seed(target: TargetName = 'systemd', port = 9000) {
  writeInstall(paths.installFile, { target, port, version: '1.0.0' })
}

const TOKEN = 'T'.repeat(43)
const ADMIN_KEY = 'A'.repeat(43)
const INVITE = JSON.stringify({
  pairing: { id: 'p1', bot: 'b1', state: 'pending', code: 'ABCD-EFGH', keys: ['k1'] },
  code: 'ABCD-EFGH',
})
const TOKEN_FILE = '/h/.config/jaypost/service/token'

function answered(status: StatusInfo) {
  return { kind: 'answered' as const, status }
}

const PAIRED_K1 = answered({ paired: true, key: 'k1', pairing: 'p1' })

function base(over = {}) {
  return {
    env: {},
    targets: targets(),
    paths,
    providers: [telegramProvider, createFakeProvider()],
    print: (s: string) => out.push(s),
    progress: recording.progress,
    confirm: vi.fn(async () => true),
    token: NO_CLIENT_TOKEN as ClientToken,
    tokenFile: TOKEN_FILE,
    fetchStatus: vi.fn(async (): Promise<StatusFetch> => PAIRED_K1),
    sleep: vi.fn(async () => {}),
    ...over,
  }
}

test('status not installed -> 1', async () => {
  expect(await runStatus({ ...base(), fetchStatus: vi.fn() })).toBe(1)
  expect(out.join('\n')).toContain('Not installed. Run "jaypost init".')
})

test('status running and paired -> 0', async () => {
  seed()
  const fetchStatus = vi.fn(async () => answered({ paired: true, bot: 'b' }))
  expect(await runStatus({ ...base(), fetchStatus })).toBe(0)
  const s = out.join('\n')
  expect(s).toContain('systemd')
  expect(s).toContain('1.0.0')
  expect(s).toContain('9000')
  expect(s).toContain('yes')
  expect(s).toContain('paired')
  expect(fetchStatus).toHaveBeenCalledWith(9000, undefined)
})

test('status running, unpaired shows pairing line', async () => {
  seed()
  const fetchStatus = vi.fn(async () =>
    answered({
      paired: false,
      code: 'ABCD-EFGH',
      bot: 'mybot',
    }),
  )
  expect(await runStatus({ ...base(), fetchStatus })).toBe(0)
  expect(out.join('\n')).toContain('/start ABCD-EFGH')
})

test('status prints old-shape pairing text', async () => {
  seed()
  const fetchStatus = vi.fn(async () =>
    answered({
      paired: false,
      code: 'ABCD-EFGH',
      bot: 'mybot',
    }),
  )
  expect(await runStatus({ ...base(), fetchStatus })).toBe(0)
  expect(out.join('\n')).toContain(
    'Pairing: not paired\nPairing code: ABCD-EFGH\nSend "/start ABCD-EFGH" to @mybot, or open https://t.me/mybot?start=ABCDEFGH',
  )
})

test('status prints provider instructions as is', async () => {
  seed()
  const fetchStatus = vi.fn(async () =>
    answered({
      paired: false,
      provider: 'fake',
      displayName: 'fake',
      code: 'ABCD-EFGH',
      instructions: 'Say ABCDEFGH to fake',
    }),
  )
  expect(await runStatus({ ...base(), fetchStatus })).toBe(0)
  expect(out.join('\n')).toContain(
    'Pairing: not paired\nPairing code: ABCD-EFGH\nSay ABCDEFGH to fake',
  )
})

test('status not running -> 1', async () => {
  seed()
  const t = targets({ systemd: fake('systemd', false) })
  expect(
    await runStatus({
      ...base({ targets: t }),
      fetchStatus: vi.fn(async () => UNREACHABLE_STATUS),
    }),
  ).toBe(1)
  expect(out.join('\n')).toContain('no')
})

test('uninstall not installed -> 0', async () => {
  expect(await runUninstall(base())).toBe(0)
  expect(notes().join('\n')).toContain('Not installed')
})

test('uninstall passes purge answer through and removes install.json', async () => {
  for (const [ans, purge] of [
    [true, true],
    [false, false],
  ] as const) {
    seed('compose')
    const d = base({ confirm: vi.fn(async () => ans) })
    expect(await runUninstall(d)).toBe(0)
    expect(d.confirm).toHaveBeenCalledWith(
      'Also delete the saved credentials, API token, paired owner and question log?',
      false,
    )
    expect(d.targets.compose.remove).toHaveBeenCalledWith(
      { target: 'compose', port: 9000, version: '1.0.0' },
      purge,
      expect.any(Function),
    )
    expect(existsSync(paths.installFile)).toBe(false)
  }
})

test('uninstall purge removes the token file; no purge keeps it', async () => {
  for (const purge of [false, true]) {
    seed('compose')
    writeTokenFile(paths.tokenFile, TOKEN)
    const d = base({ confirm: vi.fn(async () => purge) })
    expect(await runUninstall(d)).toBe(0)
    expect(d.confirm).toHaveBeenCalledWith(
      'Also delete the saved credentials, API token, paired owner and question log?',
      false,
    )
    expect(existsSync(paths.tokenFile)).toBe(!purge)
  }
})

test('uninstall works on legacy install', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  mkdirSync(dirname(paths.systemdUnit), { recursive: true })
  writeFileSync(paths.systemdUnit, '[Unit]\n')
  const d = base()
  expect(await runUninstall(d)).toBe(0)
  expect(d.targets.systemd.remove).toHaveBeenCalled()
})

test('uninstall failure: generic error, 1, install.json kept', async () => {
  seed()
  const t = fake('systemd')
  t.remove = vi.fn(async () => {
    throw new Error('secret-token-123')
  })
  const d = base({ targets: targets({ systemd: t }) })
  expect(await runUninstall(d)).toBe(1)
  expect(notes().join('\n')).not.toContain('secret-token-123')
  expect(existsSync(paths.installFile)).toBe(true)
})

type Seen = { readonly url?: string; readonly authorization?: string }

const stubs: Server[] = []

afterEach(async () => {
  await Promise.all(
    stubs.splice(0).map((stub) => {
      stub.closeAllConnections()
      return new Promise<void>((resolve) => stub.close(() => resolve()))
    }),
  )
})

async function startStub(status: number, body: string): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = []
  const stub = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      seen.push({
        ...(request.url === undefined ? {} : { url: `${request.method} ${request.url}` }),
        ...(request.headers.authorization === undefined
          ? {}
          : { authorization: request.headers.authorization }),
      })
      response.statusCode = status
      response.end(body)
    })
  })
  stubs.push(stub)
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  return { port: (stub.address() as AddressInfo).port, seen }
}

function pingDeps(port: number, token: ClientToken, print: (text: string) => void = () => {}) {
  return {
    port,
    token,
    progress: createRecordingProgress('silent').progress,
    providers: PROVIDERS,
    signal: new AbortController().signal,
    print,
    printError: (text: string) => console.error(text),
  }
}

test('ping sends a notification and says so', async () => {
  const { runPing } = await import('../../src/commands/index.ts')
  const { port, seen } = await startStub(200, '{}')
  const log = vi.fn()
  expect(await runPing(pingDeps(port, NO_CLIENT_TOKEN, log))).toBe(0)
  expect(seen).toEqual([{ url: 'POST /notify' }])
  expect(log).toHaveBeenCalledWith('Sent. Check your chat app.')
})

test('ping sends the token and explains a 401', async () => {
  const { runPing } = await import('../../src/commands/index.ts')
  const { port, seen } = await startStub(401, '{"error":"unauthorized"}')
  const token = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(await runPing(pingDeps(port, { kind: 'token', token, source: 'file' }))).toBe(1)
  expect(seen).toEqual([{ url: 'POST /notify', authorization: `Bearer ${token}` }])
  expect(error).toHaveBeenCalledWith(TOKEN_REJECTED_MESSAGE)
})

test('ping with an unusable token fails before calling', async () => {
  const { runPing } = await import('../../src/commands/index.ts')
  const { port, seen } = await startStub(200, '{}')
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(await runPing(pingDeps(port, { kind: 'unusable', message: 'bad token here' }))).toBe(1)
  expect(seen).toEqual([])
  expect(error).toHaveBeenCalledWith('bad token here')
})

test('ping with the service down reports it', async () => {
  const { runPing } = await import('../../src/commands/index.ts')
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(await runPing(pingDeps(port, NO_CLIENT_TOKEN))).toBe(1)
  expect(error).toHaveBeenCalledWith(
    `jaypost service not reachable on 127.0.0.1:${port} (run jaypost status)`,
  )
})

test('status prints where the token comes from, never its value', async () => {
  seed()
  const cases: [ClientToken, string, string | undefined][] = [
    [NO_CLIENT_TOKEN, 'Token:   none', undefined],
    [{ kind: 'token', token: TOKEN, source: 'env' }, 'Token:   from JAYPOST_TOKEN', TOKEN],
    [{ kind: 'token', token: TOKEN, source: 'file' }, `Token:   from ${TOKEN_FILE}`, TOKEN],
  ]
  for (const [token, line, sent] of cases) {
    out.length = 0
    const fetchStatus = vi.fn(async () => answered({ paired: true, bot: 'b' }))
    expect(await runStatus({ ...base({ token }), fetchStatus })).toBe(0)
    const lines = out.join('\n').split('\n')
    expect(lines[lines.findIndex((l) => l.startsWith('Port:')) + 1]).toBe(line)
    expect(out.join('\n')).not.toContain(TOKEN)
    expect(fetchStatus).toHaveBeenCalledWith(9000, sent)
  }
})

test('status with an unusable token prints it and returns 1 without calling the service', async () => {
  seed()
  const fetchStatus = vi.fn()
  const token: ClientToken = { kind: 'unusable', message: 'bad token here' }
  expect(await runStatus({ ...base({ token }), fetchStatus })).toBe(1)
  expect(out).toContain('Token:   unusable (bad token here)')
  expect(out).toContain('Pairing: unknown (no usable token)')
  expect(fetchStatus).not.toHaveBeenCalled()
})

test('status returns 1 when the service rejects the token', async () => {
  seed()
  const token: ClientToken = { kind: 'token', token: TOKEN, source: 'file' }
  const fetchStatus = vi.fn(async () => UNAUTHORIZED_STATUS)
  expect(await runStatus({ ...base({ token }), fetchStatus })).toBe(1)
  const lines = out.join('\n')
  expect(lines).toContain(
    `Pairing: unknown (the service rejected the token)\n${TOKEN_REJECTED_MESSAGE}`,
  )
  expect(lines).not.toContain(TOKEN)
})

test('uninstall with purge shows one removing step', async () => {
  seed('compose')
  expect(await runUninstall(base())).toBe(0)
  expect(recording.events).toEqual([
    'start:Removing the service and its data',
    'succeed:Removed the service and its data',
    'note:Uninstalled.',
  ])
})

test('uninstall without purge names only the service', async () => {
  seed('compose')
  expect(await runUninstall(base({ confirm: vi.fn(async () => false) }))).toBe(0)
  expect(recording.events).toEqual([
    'start:Removing the service',
    'succeed:Removed the service',
    'note:Uninstalled.',
  ])
})

test('uninstall prints the target hints after the removing step settles', async () => {
  seed()
  const t = fake('systemd')
  t.remove = vi.fn(async (_record, _purge, print) => {
    print?.('The npm package was left in place; remove it with: npm rm -g jaypost')
  })
  expect(await runUninstall(base({ targets: targets({ systemd: t }) }))).toBe(0)
  expect(recording.events).toEqual([
    'start:Removing the service and its data',
    'succeed:Removed the service and its data',
    'note:The npm package was left in place; remove it with: npm rm -g jaypost',
    'note:Uninstalled.',
  ])
})

test('uninstall fails the removing step before the failure note', async () => {
  seed()
  const t = fake('systemd')
  t.remove = vi.fn(async () => {
    throw new Error('boom')
  })
  expect(await runUninstall(base({ targets: targets({ systemd: t }) }))).toBe(1)
  expect(recording.events).toEqual([
    'start:Removing the service and its data',
    'fail:Removing the service and its data',
    'note:Uninstall failed. Check the service logs and try again.',
  ])
})

test('status shows the key and pairing ids', async () => {
  seed()
  const fetchStatus = vi.fn(async () =>
    answered({ paired: true, key: 'k1', pairing: 'p1', state: 'running' }),
  )
  expect(await runStatus({ ...base(), fetchStatus })).toBe(0)
  expect(out).toEqual([
    'Target:  systemd',
    'Version: 1.0.0',
    'Port:    9000',
    'Token:   none',
    'Running: yes',
    'Key:     k1 (pairing p1)',
    'Pairing: paired',
  ])
})

test('status shows a failed bot with its error', async () => {
  seed()
  const fetchStatus = vi.fn(async () =>
    answered({
      paired: true,
      key: 'k1',
      pairing: 'p1',
      state: 'failed',
      error: 'the bot token was rejected',
    }),
  )
  expect(await runStatus({ ...base(), fetchStatus })).toBe(0)
  expect(out.slice(-3)).toEqual([
    'Key:     k1 (pairing p1)',
    'Bot:     failed (the bot token was rejected)',
    'Pairing: paired',
  ])
})

test('status from an older service prints no key line', async () => {
  seed()
  const fetchStatus = vi.fn(async () => answered({ paired: true, bot: 'b' }))
  expect(await runStatus({ ...base(), fetchStatus })).toBe(0)
  expect(out.slice(-2)).toEqual(['Running: yes', 'Pairing: paired'])
})

/** An install whose port is a stub service answering the reset route with `status` and `body`. */
async function seedResetStub(status = 200, body = INVITE) {
  const stub = await startStub(status, body)
  seed('systemd', stub.port)
  return stub
}

function resetDeps(over = {}) {
  return { ...base(over), wait: vi.fn(async () => 'paired' as const) }
}

let service: RunningService | undefined

afterEach(async () => {
  await service?.stop()
  service = undefined
})

test('reset-owner resets pairing 1 through the admin route and waits for the new pairing', async () => {
  const directory = join(tmp, 'service')
  mkdirSync(directory)
  const configPath = join(directory, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({ provider: 'fakepair', fakeKey: 'seed-bot', fakeOwner: 'u1', apiToken: TOKEN }),
  )
  const providers = [createPairingFakeProvider()]
  service = await startService({
    version: '1.0.0',
    configPath,
    providers,
    seed: loadSeed({ JAYPOST_CONFIG: configPath }, providers),
    log: vi.fn(),
    generateCode: () => 'PAIR2222',
  })
  await service.started
  await service.server.listen({ port: 0, host: '127.0.0.1' })
  const { port } = service.server.server.address() as AddressInfo
  writeInstall(paths.installFile, {
    target: 'systemd',
    provider: 'fakepair',
    port,
    version: '1',
    configFile: configPath,
  })
  // The real systemd target, so the admin key and config.json are the service's own files.
  const systemctl: string[][] = []
  const real = createTargets(
    {
      exec: async (command, args) => {
        systemctl.push([command, ...args])
        return { code: 0, stdout: '', stderr: '' }
      },
      paths,
      env: { HOME: tmp },
      user: 'me',
      providers,
      platform: 'linux',
      uid: 501,
    },
    { kind: 'npm', selfPath: '/src/dist/cli.js', nodePath: '/usr/bin/node' },
  )
  const target = real.systemd
  const seen: StatusFetch[] = []
  const wait = vi.fn(async (options: WaitOptions) => {
    seen.push(await defaultFetchStatus(options.port, options.token))
    return 'paired' as const
  })
  const d = {
    ...base({
      targets: targets({ systemd: target }),
      providers,
      token: { kind: 'token', token: TOKEN, source: 'file' },
      fetchStatus: defaultFetchStatus,
    }),
    wait,
  }
  expect(await runResetOwner(d)).toBe(0)
  expect(seen).toEqual([
    answered(
      expect.objectContaining({ paired: false, code: 'PAIR-2222', key: 'k1', pairing: 'p1' }),
    ),
  ])
  const registry = readRegistry(configPath)
  expect(registry.pairings).toEqual([
    { id: 'p1', botId: 'b1', code: 'PAIR2222', createdAt: expect.any(String) },
  ])
  expect(systemctl).toEqual([['systemctl', '--user', 'is-active', '--quiet', 'jaypost']])
  expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
    provider: 'fakepair',
    fakeKey: 'seed-bot',
    apiToken: TOKEN,
  })
  expect(d.confirm).toHaveBeenCalledWith(
    'This unlinks your Fake account. It resets pairing p1 (key k1). Continue?',
    false,
  )
  expect(notes()).toEqual(['Paired. Try it: jaypost ping'])
})

test('reset-owner not installed -> 1', async () => {
  const d = resetDeps()
  expect(await runResetOwner(d)).toBe(1)
  expect(notes()).toEqual(['Not installed. Run "jaypost init".'])
  expect(d.confirm).not.toHaveBeenCalled()
})

test('reset-owner declined: no reset and the owner stays', async () => {
  const { seen } = await seedResetStub()
  const d = resetDeps({ confirm: vi.fn(async () => false) })
  expect(await runResetOwner(d)).toBe(0)
  expect(seen).toEqual([])
  expect(order).toEqual([])
  expect(d.wait).not.toHaveBeenCalled()
})

test('reset-owner yes: resets the pairing with the admin key and waits, with no restart', async () => {
  const { port, seen } = await seedResetStub()
  const d = resetDeps()
  expect(await runResetOwner(d)).toBe(0)
  expect(d.confirm).toHaveBeenCalledWith(
    'This unlinks your Telegram account. It resets pairing p1 (key k1). Continue?',
    false,
  )
  expect(d.fetchStatus).toHaveBeenCalledTimes(1)
  expect(d.fetchStatus).toHaveBeenCalledWith(port, undefined)
  expect(seen).toEqual([
    { url: 'POST /admin/pairings/p1/reset', authorization: `Bearer ${ADMIN_KEY}` },
  ])
  expect(d.wait).toHaveBeenCalledWith(expect.objectContaining({ port }))
  expect(order).toEqual(['forgetSeedOwner'])
  expect(d.targets.systemd.forgetSeedOwner).toHaveBeenCalledWith({
    target: 'systemd',
    port,
    version: '1.0.0',
  })
})

test('reset-owner resets with JAYPOST_ADMIN_KEY over the install key', async () => {
  const { seen } = await seedResetStub()
  const envKey = `jpa_${'E'.repeat(43)}`
  const d = resetDeps({ env: { JAYPOST_ADMIN_KEY: envKey } })
  expect(await runResetOwner(d)).toBe(0)
  expect(seen).toEqual([
    { url: 'POST /admin/pairings/p1/reset', authorization: `Bearer ${envKey}` },
  ])
  expect(d.targets.systemd.readAdminKey).not.toHaveBeenCalled()
})

test('reset-owner with JAYPOST_URL set refuses before anything else', async () => {
  const d = resetDeps({ env: { JAYPOST_URL: 'https://jaypost.example' } })
  expect(await runResetOwner(d)).toBe(1)
  expect(notes()).toEqual([
    "JAYPOST_URL is set, but reset-owner only works on this machine's install. Unset it and run reset-owner again.",
  ])
  expect(d.fetchStatus).not.toHaveBeenCalled()
  expect(d.confirm).not.toHaveBeenCalled()
})

test('reset-owner on a container drops the owner from its inputs without clearOwner', async () => {
  const stub = await startStub(200, INVITE)
  seed('compose', stub.port)
  const d = resetDeps()
  expect(await runResetOwner(d)).toBe(0)
  expect(stub.seen.map((request) => request.url)).toEqual(['POST /admin/pairings/p1/reset'])
  expect(d.targets.compose.forgetSeedOwner).toHaveBeenCalled()
  expect(d.targets.compose.clearOwner).not.toHaveBeenCalled()
})

test('reset-owner names the pairing for a key other than k1', async () => {
  await seedResetStub()
  const fetchStatus = vi.fn(async () => answered({ paired: true, key: 'k7', pairing: 'p4' }))
  const d = resetDeps({ fetchStatus, confirm: vi.fn(async () => false) })
  expect(await runResetOwner(d)).toBe(0)
  expect(d.confirm).toHaveBeenCalledWith(
    'This unlinks your Telegram account. It resets pairing p4 (key k7). Continue?',
    false,
  )
})

test('reset-owner resets the pairing /status names for the token', async () => {
  const { seen } = await seedResetStub()
  const fetchStatus = vi.fn(async () => answered({ paired: true, key: 'k7', pairing: 'p4' }))
  expect(await runResetOwner(resetDeps({ fetchStatus }))).toBe(0)
  expect(seen.map((request) => request.url)).toEqual(['POST /admin/pairings/p4/reset'])
})

test('reset-owner starts a stopped service first and waits for /status', async () => {
  const { seen } = await seedResetStub()
  const target = fake('systemd', false)
  target.restart = vi.fn(async () => {
    order.push('restart')
  })
  const fetchStatus = vi
    .fn<() => Promise<StatusFetch>>()
    .mockResolvedValueOnce(UNREACHABLE_STATUS)
    .mockResolvedValueOnce(UNREACHABLE_STATUS)
    .mockResolvedValue(PAIRED_K1)
  const d = resetDeps({ targets: targets({ systemd: target }), fetchStatus })
  expect(await runResetOwner(d)).toBe(0)
  expect(d.confirm).toHaveBeenCalledWith('This unlinks your Telegram account. Continue?', false)
  expect(order).toEqual(['restart', 'forgetSeedOwner'])
  expect(fetchStatus).toHaveBeenCalledTimes(3)
  expect(d.sleep).toHaveBeenCalledTimes(2)
  expect(d.sleep).toHaveBeenCalledWith(POLL_INTERVAL_MS)
  expect(seen.map((request) => request.url)).toEqual(['POST /admin/pairings/p1/reset'])
  expect(recording.events).toEqual([
    'plan:Restarting the service|Clearing the owner|Waiting for the service to start|Waiting for pairing',
    'start:Restarting the service',
    'succeed:Restarted the service',
    'start:Clearing the owner',
    'succeed:Cleared the owner',
    'note:Paired. Try it: jaypost ping',
  ])
})

test('reset-owner gives up before the prompt when /status never answers', async () => {
  const { seen } = await seedResetStub()
  const d = resetDeps({ fetchStatus: vi.fn(async () => UNREACHABLE_STATUS) })
  expect(await runResetOwner(d)).toBe(1)
  expect(d.fetchStatus).toHaveBeenCalledTimes(DEFAULT_START_TIMEOUT_MS / POLL_INTERVAL_MS)
  expect(seen).toEqual([])
  expect(d.confirm).not.toHaveBeenCalled()
  expect(d.wait).not.toHaveBeenCalled()
  expect(recording.events).toEqual(["note:The service didn't answer. logs hint"])
})

test('reset-owner fails the step when a restarted service never answers', async () => {
  const { seen } = await seedResetStub()
  const d = resetDeps({
    targets: targets({ systemd: fake('systemd', false) }),
    fetchStatus: vi.fn(async () => UNREACHABLE_STATUS),
  })
  expect(await runResetOwner(d)).toBe(1)
  expect(seen).toEqual([])
  expect(order).toEqual(['restart'])
  expect(recording.events.slice(-3)).toEqual([
    'start:Clearing the owner',
    'fail:Clearing the owner',
    "note:The service didn't answer. logs hint",
  ])
})

test('reset-owner confirm text comes from the provider', async () => {
  writeInstall(paths.installFile, {
    target: 'systemd',
    provider: 'fakepair',
    port: 9000,
    version: '1',
  })
  const d = resetDeps({
    confirm: vi.fn(async () => false),
    providers: [createPairingFakeProvider()],
  })
  expect(await runResetOwner(d)).toBe(0)
  expect(d.confirm).toHaveBeenCalledWith(
    'This unlinks your Fake account. It resets pairing p1 (key k1). Continue?',
    false,
  )
})

test('reset-owner without an owner setting returns 1 before prompting', async () => {
  writeInstall(paths.installFile, {
    target: 'systemd',
    provider: 'fake',
    port: 9000,
    version: '1',
  })
  const d = resetDeps()
  expect(await runResetOwner(d)).toBe(1)
  expect(notes()).toEqual(["Fake doesn't support re-pairing."])
  expect(d.confirm).not.toHaveBeenCalled()
  expect(d.fetchStatus).not.toHaveBeenCalled()
})

test('reset-owner with an unknown provider returns 1 before prompting', async () => {
  writeInstall(paths.installFile, {
    target: 'systemd',
    provider: 'nope',
    port: 9000,
    version: '1',
  })
  const d = resetDeps()
  expect(await runResetOwner(d)).toBe(1)
  expect(notes()).toEqual(['unknown provider "nope"; run `jaypost init`'])
  expect(d.confirm).not.toHaveBeenCalled()
})

test('reset-owner wait exit codes', async () => {
  await seedResetStub()
  for (const [result, code] of [
    ['interrupted', 130],
    ['notStarted', 1],
    ['stopped', 1],
  ] as const) {
    expect(await runResetOwner({ ...base(), wait: vi.fn(async () => result) })).toBe(code)
  }
})

test('reset-owner failure prints generic error and returns 1', async () => {
  await seedResetStub()
  const target = fake('systemd', false)
  target.restart = vi.fn(async () => {
    throw new Error('secret-token-123')
  })
  const d = resetDeps({ targets: targets({ systemd: target }) })
  expect(await runResetOwner(d)).toBe(1)
  expect(notes()).toEqual(['Reset failed. logs hint'])
  expect(d.fetchStatus).not.toHaveBeenCalled()
  expect(d.wait).not.toHaveBeenCalled()
})

test('reset-owner fails the running step before the failure note', async () => {
  await seedResetStub()
  const target = fake('systemd', false)
  target.restart = vi.fn(async () => {
    throw new Error('boom')
  })
  expect(await runResetOwner(resetDeps({ targets: targets({ systemd: target }) }))).toBe(1)
  expect(recording.events.slice(-3)).toEqual([
    'start:Restarting the service',
    'fail:Restarting the service',
    'note:Reset failed. logs hint',
  ])
})

test('reset-owner prints why the admin key is missing', async () => {
  const { seen } = await seedResetStub()
  const target = fake('systemd')
  target.readAdminKey = vi.fn(async () => {
    throw new Error('no admin key in "/x/admin-key" yet; start the service once so it writes one')
  })
  const d = resetDeps({ targets: targets({ systemd: target }) })
  expect(await runResetOwner(d)).toBe(1)
  expect(seen).toEqual([])
  expect(notes()).toEqual([
    'no admin key in "/x/admin-key" yet; start the service once so it writes one',
  ])
  expect(order).toEqual([])
  expect(d.wait).not.toHaveBeenCalled()
})

test('reset-owner reports a rejected admin key', async () => {
  await seedResetStub(401, '{"error":"unauthorized"}')
  const d = resetDeps()
  expect(await runResetOwner(d)).toBe(1)
  expect(recording.events.slice(-3)).toEqual([
    'start:Clearing the owner',
    'fail:Clearing the owner',
    `note:${ADMIN_KEY_REJECTED_MESSAGE}`,
  ])
  expect(notes().join('\n')).not.toContain(ADMIN_KEY)
  expect(order).toEqual([])
  expect(d.wait).not.toHaveBeenCalled()
})

test('reset-owner on a service without pairings says it is too old', async () => {
  const { seen } = await seedResetStub()
  const d = resetDeps({ fetchStatus: vi.fn(async () => answered({ paired: true, bot: 'b' })) })
  expect(await runResetOwner(d)).toBe(1)
  expect(seen).toEqual([])
  expect(d.confirm).not.toHaveBeenCalled()
  expect(notes()).toEqual([ADMIN_TOO_OLD_MESSAGE])
})

test('reset-owner explains a token /status rejects', async () => {
  const { seen } = await seedResetStub()
  const d = resetDeps({ fetchStatus: vi.fn(async () => UNAUTHORIZED_STATUS) })
  expect(await runResetOwner(d)).toBe(1)
  expect(seen).toEqual([])
  expect(d.confirm).not.toHaveBeenCalled()
  expect(notes()).toEqual([TOKEN_REQUIRED_MESSAGE])
})

test('reset-owner wait throwing prints a generic error and returns 1', async () => {
  await seedResetStub()
  const wait = vi.fn(async () => {
    throw new Error('secret-token-123')
  })
  expect(await runResetOwner({ ...base(), wait })).toBe(1)
  const text = notes().join('\n')
  expect(text).toContain('Waiting for pairing failed. logs hint')
  expect(text).not.toContain('secret-token-123')
})

test('reset-owner with an unusable token fails before resetting', async () => {
  const { seen } = await seedResetStub()
  const d = resetDeps({ token: { kind: 'unusable', message: 'bad token here' } })
  expect(await runResetOwner(d)).toBe(1)
  expect(notes()).toEqual(['bad token here'])
  expect(d.confirm).not.toHaveBeenCalled()
  expect(d.wait).not.toHaveBeenCalled()
  expect(seen).toEqual([])
  expect(d.targets.systemd.restart).not.toHaveBeenCalled()
})

test('reset-owner sends the token to /status and the wait and explains unauthorized', async () => {
  const { port } = await seedResetStub()
  const d = {
    ...resetDeps({ token: { kind: 'token', token: TOKEN, source: 'env' } }),
    wait: vi.fn(async () => 'unauthorized' as const),
  }
  expect(await runResetOwner(d)).toBe(1)
  expect(d.fetchStatus).toHaveBeenCalledWith(port, TOKEN)
  expect(d.wait).toHaveBeenCalledWith(expect.objectContaining({ token: TOKEN }))
  expect(notes().join('\n')).toContain(TOKEN_REJECTED_MESSAGE)
  expect(notes().join('\n')).not.toContain(TOKEN)
})

test('reset-owner runs the reset and pairing as a checklist', async () => {
  await seedResetStub()
  const d = resetDeps()
  expect(await runResetOwner(d)).toBe(0)
  expect(d.wait).toHaveBeenCalledWith(expect.objectContaining({ progress: recording.progress }))
  expect(recording.events).toEqual([
    'plan:Clearing the owner|Waiting for the service to start|Waiting for pairing',
    'start:Clearing the owner',
    'succeed:Cleared the owner',
    'note:Paired. Try it: jaypost ping',
  ])
})

test('reset-owner cancels the running step on interrupt', async () => {
  const { seen } = await seedResetStub()
  const controller = new AbortController()
  const fetchStatus = vi.fn(async () => {
    controller.abort()
    return UNREACHABLE_STATUS
  })
  const d = resetDeps({
    targets: targets({ systemd: fake('systemd', false) }),
    fetchStatus,
    signal: controller.signal,
  })
  expect(await runResetOwner(d)).toBe(130)
  expect(seen).toEqual([])
  expect(recording.events.slice(-3)).toEqual([
    'start:Clearing the owner',
    'cancel:Clearing the owner',
    'note:',
  ])
})

test('reset-owner prompt abort -> 130', async () => {
  await seedResetStub()
  const { PromptAborted } = await import('../../src/commands/index.ts')
  const d = resetDeps({
    confirm: vi.fn(async () => {
      throw new PromptAborted()
    }),
  })
  expect(await runResetOwner(d)).toBe(130)
})

test('reset-owner prompt interrupted while reading /status -> 130 before the prompt', async () => {
  await seedResetStub()
  const controller = new AbortController()
  const fetchStatus = vi.fn(async () => {
    controller.abort()
    return UNREACHABLE_STATUS
  })
  const d = resetDeps({ fetchStatus, signal: controller.signal })
  expect(await runResetOwner(d)).toBe(130)
  expect(d.confirm).not.toHaveBeenCalled()
  expect(recording.events).toEqual(['note:'])
})

test('reset-owner keeps the owner when the admin call fails after a stopped service', async () => {
  await seedResetStub(404, '{"error":"unknown pairing p1"}')
  const target = fake('systemd', false)
  const d = resetDeps({ targets: targets({ systemd: target }) })
  expect(await runResetOwner(d)).toBe(1)
  expect(order).toEqual(['restart'])
  expect(notes()).toEqual(['unknown pairing p1'])
})

test('reset-owner token prefers the token file over JAYPOST_TOKEN', () => {
  const tokenFile = join(tmp, 'token')
  const envToken = 'E'.repeat(43)
  const env = { JAYPOST_TOKEN: envToken }
  expect(resolveResetOwnerToken(env, tokenFile)).toEqual({
    kind: 'token',
    token: envToken,
    source: 'env',
  })
  writeTokenFile(tokenFile, TOKEN)
  expect(resolveResetOwnerToken(env, tokenFile)).toEqual({
    kind: 'token',
    token: TOKEN,
    source: 'file',
  })
  expect(resolveResetOwnerToken({}, join(tmp, 'missing'))).toEqual(NO_CLIENT_TOKEN)
})
