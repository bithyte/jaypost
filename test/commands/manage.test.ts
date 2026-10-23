import { existsSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import { NO_CLIENT_TOKEN, writeTokenFile } from '../../src/auth/index.ts'
import type { ClientToken } from '../../src/auth/index.ts'
import { TOKEN_REJECTED_MESSAGE } from '../../src/client/index.ts'
import { runResetOwner, runStatus, runUninstall } from '../../src/commands/index.ts'
import type { StatusInfo } from '../../src/protocol/index.ts'
import { UNAUTHORIZED_STATUS, UNREACHABLE_STATUS } from '../../src/commands/constants.ts'
import { resolveInstallPaths, writeInstall } from '../../src/install/index.ts'
import type { InstallPaths, Target, TargetName } from '../../src/install/index.ts'
import { PROVIDERS } from '../../src/registry/index.ts'
import { telegramProvider } from '../../src/telegram/index.ts'
import { createRecordingProgress } from '../progress/recording.ts'
import { createFakeProvider, createPairingFakeProvider } from '../provider/fake.ts'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

let tmp: string
let paths: InstallPaths
let order: string[]
let out: string[]
let recording = createRecordingProgress()

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
    isRunning: vi.fn(async () => running),
    readAuditLog: vi.fn(),
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

function seed(target: TargetName = 'systemd') {
  writeInstall(paths.installFile, { target, port: 9000, version: '1.0.0' })
}

const TOKEN = 'T'.repeat(43)
const TOKEN_FILE = '/h/.config/jaypost/token'

function answered(status: StatusInfo) {
  return { kind: 'answered' as const, status }
}

function base(over = {}) {
  return {
    targets: targets(),
    paths,
    providers: [telegramProvider, createFakeProvider()],
    print: (s: string) => out.push(s),
    progress: recording.progress,
    confirm: vi.fn(async () => true),
    token: NO_CLIENT_TOKEN as ClientToken,
    tokenFile: TOKEN_FILE,
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

test('reset-owner not installed -> 1', async () => {
  expect(await runResetOwner({ ...base(), wait: vi.fn() })).toBe(1)
})

test('reset-owner declined: no clearOwner', async () => {
  seed()
  const d = { ...base({ confirm: vi.fn(async () => false) }), wait: vi.fn() }
  expect(await runResetOwner(d)).toBe(0)
  expect(d.targets.systemd.clearOwner).not.toHaveBeenCalled()
  expect(d.wait).not.toHaveBeenCalled()
})

test('reset-owner yes: clearOwner, restart, wait', async () => {
  seed()
  const wait = vi.fn(async () => {
    order.push('wait')
    return 'paired' as const
  })
  const d = { ...base(), wait }
  expect(await runResetOwner(d)).toBe(0)
  expect(d.confirm).toHaveBeenCalledWith('This unlinks your Telegram account. Continue?', false)
  expect(order).toEqual(['clearOwner', 'restart', 'wait'])
})

test('reset-owner confirm text comes from the provider', async () => {
  writeInstall(paths.installFile, {
    target: 'systemd',
    provider: 'fakepair',
    port: 9000,
    version: '1',
  })
  const d = {
    ...base({
      confirm: vi.fn(async () => false),
      providers: [createPairingFakeProvider()],
    }),
    wait: vi.fn(),
  }
  expect(await runResetOwner(d)).toBe(0)
  expect(d.confirm).toHaveBeenCalledWith('This unlinks your Fake account. Continue?', false)
})

test('reset-owner without an owner setting returns 1 before prompting', async () => {
  writeInstall(paths.installFile, {
    target: 'systemd',
    provider: 'fake',
    port: 9000,
    version: '1',
  })
  const d = { ...base(), wait: vi.fn() }
  expect(await runResetOwner(d)).toBe(1)
  expect(notes()).toEqual(["Fake doesn't support re-pairing."])
  expect(d.confirm).not.toHaveBeenCalled()
  expect(d.targets.systemd.clearOwner).not.toHaveBeenCalled()
})

test('reset-owner with an unknown provider returns 1 before prompting', async () => {
  writeInstall(paths.installFile, {
    target: 'systemd',
    provider: 'nope',
    port: 9000,
    version: '1',
  })
  const d = { ...base(), wait: vi.fn() }
  expect(await runResetOwner(d)).toBe(1)
  expect(notes()).toEqual(['unknown provider "nope"; run `jaypost init`'])
  expect(d.confirm).not.toHaveBeenCalled()
})

test('reset-owner wait exit codes', async () => {
  seed()
  for (const [r, code] of [
    ['interrupted', 130],
    ['notStarted', 1],
    ['stopped', 1],
  ] as const) {
    expect(await runResetOwner({ ...base(), wait: vi.fn(async () => r) })).toBe(code)
  }
})

test('reset-owner failure prints generic error and returns 1', async () => {
  seed()
  const t = fake('systemd')
  t.clearOwner = vi.fn(async () => {
    throw new Error('secret-token-123')
  })
  const d = { ...base({ targets: targets({ systemd: t }) }), wait: vi.fn() }
  expect(await runResetOwner(d)).toBe(1)
  expect(notes().join('\n')).not.toContain('secret-token-123')
  expect(d.wait).not.toHaveBeenCalled()
})

test('reset-owner prompt abort -> 130', async () => {
  seed()
  const { PromptAborted } = await import('../../src/commands/index.ts')
  const d = {
    ...base({
      confirm: vi.fn(async () => {
        throw new PromptAborted()
      }),
    }),
    wait: vi.fn(),
  }
  expect(await runResetOwner(d)).toBe(130)
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

test('reset-owner restart failure reports Reset failed, not Paired', async () => {
  seed()
  const t = fake('systemd')
  t.restart = vi.fn(async () => {
    throw new Error('systemctl restart failed (exit 1)')
  })
  const d = { ...base({ targets: targets({ systemd: t }) }), wait: vi.fn() }
  expect(await runResetOwner(d)).toBe(1)
  expect(notes().join('\n')).toContain('Reset failed. logs hint')
  expect(notes().join('\n')).not.toContain('Paired')
  expect(d.wait).not.toHaveBeenCalled()
})

test('reset-owner wait throwing prints a generic error and returns 1', async () => {
  seed()
  const wait = vi.fn(async () => {
    throw new Error('secret-token-123')
  })
  expect(await runResetOwner({ ...base(), wait })).toBe(1)
  const text = notes().join('\n')
  expect(text).toContain('Waiting for pairing failed. logs hint')
  expect(text).not.toContain('secret-token-123')
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

test('reset-owner with an unusable token fails before clearing the owner', async () => {
  seed()
  const d = {
    ...base({ token: { kind: 'unusable', message: 'bad token here' } }),
    wait: vi.fn(),
  }
  expect(await runResetOwner(d)).toBe(1)
  expect(notes().join('\n')).toContain('bad token here')
  expect(d.confirm).not.toHaveBeenCalled()
  expect(d.wait).not.toHaveBeenCalled()
  expect(d.targets.systemd.clearOwner).not.toHaveBeenCalled()
  expect(d.targets.systemd.restart).not.toHaveBeenCalled()
})

test('reset-owner passes the token to the wait and explains unauthorized', async () => {
  seed()
  const wait = vi.fn(async () => 'unauthorized' as const)
  const token: ClientToken = { kind: 'token', token: TOKEN, source: 'env' }
  expect(await runResetOwner({ ...base({ token }), wait })).toBe(1)
  expect(wait).toHaveBeenCalledWith(expect.objectContaining({ token: TOKEN }))
  expect(notes().join('\n')).toContain(TOKEN_REJECTED_MESSAGE)
  expect(notes().join('\n')).not.toContain(TOKEN)
})

test('reset-owner runs clear, restart and pairing as a checklist', async () => {
  seed()
  const wait = vi.fn(async () => 'paired' as const)
  expect(await runResetOwner({ ...base(), wait })).toBe(0)
  expect(wait).toHaveBeenCalledWith(expect.objectContaining({ progress: recording.progress }))
  expect(recording.events).toEqual([
    'plan:Clearing the owner|Restarting the service|Waiting for the service to start|Waiting for pairing',
    'start:Clearing the owner',
    'succeed:Cleared the owner',
    'start:Restarting the service',
    'succeed:Restarted the service',
    'note:Paired. Try it: jaypost ping',
  ])
})

test('reset-owner fails the running step before the failure note', async () => {
  seed()
  const t = fake('systemd')
  t.restart = vi.fn(async () => {
    throw new Error('boom')
  })
  const d = { ...base({ targets: targets({ systemd: t }) }), wait: vi.fn() }
  expect(await runResetOwner(d)).toBe(1)
  expect(recording.events.slice(-3)).toEqual([
    'start:Restarting the service',
    'fail:Restarting the service',
    'note:Reset failed. logs hint',
  ])
})

test('reset-owner cancels the running step on interrupt', async () => {
  seed()
  const controller = new AbortController()
  const t = fake('systemd')
  t.clearOwner = vi.fn(async () => {
    controller.abort()
    throw new Error('aborted')
  })
  const d = {
    ...base({ targets: targets({ systemd: t }), signal: controller.signal }),
    wait: vi.fn(),
  }
  expect(await runResetOwner(d)).toBe(130)
  expect(recording.events.slice(-3)).toEqual([
    'start:Clearing the owner',
    'cancel:Clearing the owner',
    'note:',
  ])
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
