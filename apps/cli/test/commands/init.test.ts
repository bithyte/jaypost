import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, expect, test, vi } from 'vite-plus/test'
import { NO_AUTH, readBook } from '@jaypost/store'
import { TOKEN_REJECTED_MESSAGE } from '@jaypost/client'
import { PromptAborted, runInit } from '../../src/commands/index.ts'
import type { InitDeps } from '../../src/commands/index.ts'
import { createTargets, resolveInstallPaths, readInstall, writeInstall } from '@jaypost/install'
import type { InstallPaths, Secrets, Target, TargetName } from '@jaypost/install'
import type { CredentialCheck, Provider, SettingValues } from '@jaypost/core'
import { telegramProvider } from '@jaypost/providers'
import { createRecordingProgress } from '../progress/recording.ts'
import { createFakeProvider, createPairingFakeProvider } from '@jaypost/testing'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

let tmp: string
let paths: InstallPaths
let bookPath: string
let order: string[]
let recording = createRecordingProgress()

function notes(): string[] {
  return recording.notes()
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'init-'))
  paths = resolveInstallPaths({ HOME: tmp, XDG_CONFIG_HOME: join(tmp, 'cfg') })
  bookPath = join(tmp, 'cfg', 'jaypost', 'bots.json')
  order = []
  recording = createRecordingProgress()
})

const TOKEN = 'saved-api-token-'.padEnd(43, 'x')
const OTHER_TOKEN = 'stale-shell-token-'.padEnd(43, 'y')
const REQUIRE =
  'Require an API token? Scripts, n8n flows and agents in containers will need to send it.'
const NO_TOKEN_LINE = 'No API token: any local process can use the API.'

const ADMIN_KEY = `jpa_${'k'.repeat(43)}`
const LOCAL_URL = 'http://127.0.0.1:8787/'
const CONTAINER_LINE = 'Agents in containers need JAYPOST_TOKEN set to its key from that file.'

/** The key `install` was called with on `target`. */
function installedToken(target: Target): string | undefined {
  const auth = vi.mocked(target.install).mock.calls[0]?.[0].auth
  return auth?.kind === 'token' ? auth.token : undefined
}

function savedLine(): string {
  return `Your bot is saved as "local" in ${bookPath}.`
}

function wasAsked(d: InitDeps): boolean {
  return vi.mocked(d.prompt.confirm).mock.calls.some(([message]) => message === REQUIRE)
}

const ACCEPTED: CredentialCheck = { ok: true, displayName: '@mybot' }
const REJECTED: CredentialCheck = { ok: false, reason: 'rejected' }
const NO_SECRETS: Secrets = { provider: 'telegram', settings: {} }

function telegram(
  checkCredentials: (settings: SettingValues) => Promise<CredentialCheck> = vi.fn(
    async () => ACCEPTED,
  ),
): Provider {
  return { ...telegramProvider, setup: { ...telegramProvider.setup, checkCredentials } }
}

function checkOf(d: InitDeps) {
  return d.providers[0]!.setup.checkCredentials
}

function saved(settings: SettingValues): Secrets {
  return { provider: 'telegram', settings }
}

function fake(name: TargetName, ok = true, secrets: Secrets = NO_SECRETS): Mutable<Target> {
  return {
    name,
    available: vi.fn(async () =>
      ok ? { ok: true as const } : { ok: false as const, reason: `${name} missing` },
    ),
    install: vi.fn(async (o) => {
      order.push(`install:${name}`)
      return { target: name, port: o.port, version: o.version }
    }),
    upgrade: vi.fn(),
    readSecrets: vi.fn(async () => secrets),
    remove: vi.fn(async () => {
      order.push('remove')
    }),
    restart: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    readApiToken: vi.fn(async () => undefined),
    readAdminKey: vi.fn(async () => ADMIN_KEY),
    clearOwner: vi.fn(),
    isRunning: vi.fn(async () => true),
    readAuditLog: vi.fn(),
    logsHint: vi.fn(() => `logs for ${name}`),
  } as unknown as Mutable<Target>
}

function deps(over: Partial<InitDeps> & { targets?: Record<TargetName, Target> } = {}): InitDeps {
  return {
    targets: {
      quadlet: fake('quadlet'),
      compose: fake('compose'),
      systemd: fake('systemd'),
      launchd: fake('launchd'),
    },
    paths,
    prompt: {
      confirm: vi.fn(async () => true),
      password: vi.fn(async () => 'good-token'),
      text: vi.fn(async () => 'text-answer'),
      select: vi.fn(async (_q, _o, initialValue) => initialValue),
    },
    providers: [telegram()],
    isPortFree: vi.fn(async () => {
      order.push('port')
      return true
    }),
    wait: vi.fn(async () => 'paired' as const),
    progress: recording.progress,
    version: '1.2.3',
    env: {},
    platform: 'linux',
    bookPath,
    hostname: 'box.lan',
    ...over,
  }
}

function seed(target: TargetName, port = 9000) {
  writeInstall(paths.installFile, { target, port, version: '1.0.0' })
}

test('fresh install: default target, default port, writes install record', async () => {
  const d = deps()
  expect(await runInit({}, d)).toBe(0)
  expect(d.prompt.select).toHaveBeenCalled()
  expect(d.targets.quadlet.install).toHaveBeenCalledWith(
    expect.objectContaining({ port: 8787, settings: { botToken: 'good-token' }, version: '1.2.3' }),
  )
  expect(readInstall(paths.installFile)?.target).toBe('quadlet')
  expect(notes().join('\n')).toContain('Done. Try it: jaypost ping')
})

test('passes the time zone to the target install when given', async () => {
  const d = deps({ timeZone: 'Europe/Bucharest' })
  expect(await runInit({}, d)).toBe(0)
  expect(d.targets.quadlet.install).toHaveBeenCalledWith(
    expect.objectContaining({ timeZone: 'Europe/Bucharest' }),
  )
})

test('leaves timeZone out of the install options without one', async () => {
  const d = deps()
  expect(await runInit({}, d)).toBe(0)
  const [options] = vi.mocked(d.targets.quadlet.install).mock.calls[0]!
  expect(Object.hasOwn(options, 'timeZone')).toBe(false)
})

test('replace: reads secrets, removes old without purge, checks port after removal, reuses token and owner', async () => {
  seed('compose')
  const old = fake('compose', true, saved({ botToken: 't', ownerId: 42 }))
  const d = deps({
    targets: {
      quadlet: fake('quadlet'),
      compose: old,
      systemd: fake('systemd'),
      launchd: fake('launchd'),
    },
  })
  expect(await runInit({ target: 'quadlet' }, d)).toBe(0)
  expect(order).toEqual(['remove', 'port', 'install:quadlet'])
  expect(old.remove).toHaveBeenCalledWith(expect.objectContaining({ target: 'compose' }), false)
  expect(d.targets.quadlet.install).toHaveBeenCalledWith(
    expect.objectContaining({ settings: { botToken: 't', ownerId: 42 }, port: 9000 }),
  )
  expect(d.prompt.password).not.toHaveBeenCalled()
  expect(checkOf(d)).toHaveBeenCalledWith({ botToken: 't', ownerId: 42 })
})

test('declining replace changes nothing', async () => {
  seed('compose')
  const old = fake('compose', true, saved({ botToken: 't' }))
  const d = deps({
    targets: {
      quadlet: fake('quadlet'),
      compose: old,
      systemd: fake('systemd'),
      launchd: fake('launchd'),
    },
  })
  vi.mocked(d.prompt.confirm).mockImplementation(async () => false)
  expect(await runInit({}, d)).toBe(0)
  expect(old.remove).not.toHaveBeenCalled()
  expect(old.readSecrets).not.toHaveBeenCalled()
  expect(d.targets.quadlet.install).not.toHaveBeenCalled()
  expect(readInstall(paths.installFile)?.target).toBe('compose')
})

test('requested target unavailable returns 1 with the reason', async () => {
  const d = deps({
    targets: {
      quadlet: fake('quadlet', false),
      compose: fake('compose'),
      systemd: fake('systemd'),
      launchd: fake('launchd'),
    },
  })
  expect(await runInit({ target: 'quadlet' }, d)).toBe(1)
  expect(notes().join('\n')).toContain('quadlet missing')
  expect(d.targets.compose.install).not.toHaveBeenCalled()
})

test('no target available returns 1 with reasons', async () => {
  const d = deps({
    targets: {
      quadlet: fake('quadlet', false),
      compose: fake('compose', false),
      systemd: fake('systemd', false),
      launchd: fake('launchd', false),
    },
  })
  expect(await runInit({}, d)).toBe(1)
  expect(notes().join('\n')).toContain('compose missing')
})

test('invalid token reprompts without echoing Telegram errors', async () => {
  const validate = vi
    .fn()
    .mockRejectedValueOnce(new Error('ECONNREFUSED api.telegram.org SECRET-ERR'))
    .mockResolvedValueOnce(REJECTED)
    .mockResolvedValueOnce(ACCEPTED)
  const secret = vi
    .fn()
    .mockResolvedValueOnce('bad-token-1')
    .mockResolvedValueOnce('bad-token-2')
    .mockResolvedValueOnce('good-token')
  const d = deps({ providers: [telegram(validate)] })
  vi.mocked(d.prompt.password).mockImplementation(secret)
  // first call rejects: checkCredentials is documented to never throw, but be safe
  expect(await runInit({}, d)).toBe(0)
  expect(secret).toHaveBeenCalledTimes(3)
  const text = notes().join('\n')
  expect(text).toContain('Telegram rejected that token (or could not be reached). Try again.')
  expect(text).not.toContain('SECRET-ERR')
  expect(text).not.toContain('ECONNREFUSED')
  for (const t of ['bad-token-1', 'bad-token-2', 'good-token']) {
    expect(text).not.toContain(t)
  }
})

test('stored token invalid falls back to prompt', async () => {
  seed('compose')
  const old = fake('compose', true, saved({ botToken: 'stale' }))
  const validate = vi.fn(async (settings: SettingValues) =>
    settings.botToken === 'stale' ? REJECTED : ACCEPTED,
  )
  const d = deps({
    targets: {
      quadlet: fake('quadlet'),
      compose: old,
      systemd: fake('systemd'),
      launchd: fake('launchd'),
    },
    providers: [telegram(validate)],
  })
  expect(await runInit({}, d)).toBe(0)
  expect(d.prompt.password).toHaveBeenCalledTimes(1)
  expect(notes().join('\n')).not.toContain('stale')
})

test('port in use returns 1 before install', async () => {
  const d = deps({ isPortFree: vi.fn(async () => false) })
  expect(await runInit({ port: 9999 }, d)).toBe(1)
  expect(notes().join('\n')).toContain('Port 9999 is in use. Pick another with --port.')
  expect(d.targets.quadlet.install).not.toHaveBeenCalled()
})

test('interrupted wait returns 130 and leaves the service', async () => {
  const d = deps({ wait: vi.fn(async () => 'interrupted' as const) })
  expect(await runInit({}, d)).toBe(130)
  expect(order).toEqual(['port', 'install:quadlet'])
  expect(d.targets.quadlet.remove).not.toHaveBeenCalled()
  expect(readInstall(paths.installFile)?.target).toBe('quadlet')
})

test('not-started and stopped return 1 with logs hint', async () => {
  for (const r of ['notStarted', 'stopped'] as const) {
    recording = createRecordingProgress()
    const d = deps({ wait: vi.fn(async () => r) })
    expect(await runInit({}, d)).toBe(1)
    expect(notes().join('\n')).toContain('logs for quadlet')
  }
})

test('legacy systemd unit is replaced and its config reused', async () => {
  mkdirSync(dirname(paths.systemdUnit), { recursive: true })
  writeFileSync(paths.systemdUnit, '[Service]\n')
  mkdirSync(dirname(paths.configFile), { recursive: true })
  writeFileSync(paths.configFile, JSON.stringify({ port: 9123 }))
  const old = fake('systemd', true, saved({ botToken: 'lt', ownerId: 7 }))
  const d = deps({
    targets: {
      quadlet: fake('quadlet'),
      compose: fake('compose'),
      systemd: old,
      launchd: fake('launchd'),
    },
  })
  expect(await runInit({ target: 'systemd' }, d)).toBe(0)
  expect(notes().join('\n').toLowerCase()).toContain('legacy')
  expect(order).toEqual(['remove', 'port', 'install:systemd'])
  expect(old.install).toHaveBeenCalledWith(
    expect.objectContaining({ settings: { botToken: 'lt', ownerId: 7 }, port: 9123 }),
  )
  expect(existsSync(paths.installFile)).toBe(true)
})

test('passes tarball and signal through', async () => {
  const ac = new AbortController()
  const d = deps({ signal: ac.signal })
  await runInit({ tarball: '/x/y.tgz' }, d)
  expect(d.targets.quadlet.install).toHaveBeenCalledWith(
    expect.objectContaining({ tarball: '/x/y.tgz' }),
  )
  expect(d.wait).toHaveBeenCalledWith(
    expect.objectContaining({ signal: ac.signal, url: new URL('http://127.0.0.1:8787/') }),
  )
})

test('darwin offers launchd first and defaults to it', async () => {
  const d = deps({ platform: 'darwin' })
  expect(await runInit({}, d)).toBe(0)
  const [, options, initialValue] = vi.mocked(d.prompt.select).mock.calls[0]!
  expect(options.map((option) => option.value)).toEqual([
    'launchd',
    'quadlet',
    'compose',
    'systemd',
  ])
  expect(initialValue).toBe('launchd')
})

test('linux never lists launchd', async () => {
  const d = deps({ platform: 'linux' })
  expect(await runInit({}, d)).toBe(0)
  const [, options] = vi.mocked(d.prompt.select).mock.calls[0]!
  expect(options.map((option) => option.value)).toEqual(['quadlet', 'compose', 'systemd'])
})

test('Ctrl-C at target select returns 130, nothing installed', async () => {
  const d = deps()
  vi.mocked(d.prompt.select).mockImplementation(async () => {
    throw new PromptAborted()
  })
  expect(await runInit({}, d)).toBe(130)
  expect(order).toEqual([])
})

test('Ctrl-C at Replace prompt returns 130 before any remove', async () => {
  seed('compose')
  const old = fake('compose', true, saved({ botToken: 't' }))
  const d = deps({
    targets: {
      quadlet: fake('quadlet'),
      compose: old,
      systemd: fake('systemd'),
      launchd: fake('launchd'),
    },
  })
  vi.mocked(d.prompt.confirm).mockImplementation(async () => {
    throw new PromptAborted()
  })
  expect(await runInit({}, d)).toBe(130)
  expect(old.remove).not.toHaveBeenCalled()
  expect(d.targets.quadlet.install).not.toHaveBeenCalled()
})

test('Ctrl-C at token prompt returns 130, no install', async () => {
  const d = deps()
  vi.mocked(d.prompt.password).mockImplementation(async () => {
    throw new PromptAborted()
  })
  expect(await runInit({}, d)).toBe(130)
  expect(d.targets.quadlet.install).not.toHaveBeenCalled()
})

test('EOF in token loop terminates', async () => {
  const d = deps({ providers: [telegram(vi.fn(async () => REJECTED))] })
  let n = 0
  vi.mocked(d.prompt.password).mockImplementation(async () => {
    if (++n > 1) {
      throw new PromptAborted()
    }
    return 'bad'
  })
  expect(await runInit({}, d)).toBe(130)
  expect(n).toBe(2)
})

test('aborted signal stops the token loop before prompting', async () => {
  const ac = new AbortController()
  ac.abort()
  const d = deps({ signal: ac.signal })
  expect(await runInit({}, d)).toBe(130)
  expect(d.prompt.password).not.toHaveBeenCalled()
})

test('install throwing returns 1 with generic message, no secrets', async () => {
  const d = deps()
  vi.mocked(d.targets.quadlet.install).mockImplementation(async () => {
    throw new Error('boom good-token')
  })
  expect(await runInit({}, d)).toBe(1)
  const text = notes().join('\n')
  expect(text).toContain('Install failed: boom ***')
  expect(text).toContain('Run jaypost service install again')
  expect(text).not.toContain('good-token')
})

test('old remove throwing returns 1, no install', async () => {
  seed('compose')
  const old = fake('compose', true, saved({ botToken: 't' }))
  old.remove = vi.fn(async () => {
    throw new Error('nope')
  })
  const d = deps({
    targets: {
      quadlet: fake('quadlet'),
      compose: old,
      systemd: fake('systemd'),
      launchd: fake('launchd'),
    },
  })
  expect(await runInit({}, d)).toBe(1)
  expect(d.targets.quadlet.install).not.toHaveBeenCalled()
})

test('target error message is shown with a reused token redacted', async () => {
  seed('compose')
  const old = fake('compose', true, saved({ botToken: '123:SECRET' }))
  const d = deps({
    targets: {
      quadlet: fake('quadlet'),
      compose: old,
      systemd: fake('systemd'),
      launchd: fake('launchd'),
    },
  })
  vi.mocked(d.targets.quadlet.install).mockImplementation(async () => {
    throw new Error('npm install failed: bad url https://x/bot123:SECRET/getMe')
  })
  expect(await runInit({ target: 'quadlet' }, d)).toBe(1)
  const text = notes().join('\n')
  expect(text).toContain('npm install failed: bad url https://x/bot***/getMe')
  expect(text).not.toContain('123:SECRET')
})

test('failure after removing the old target keeps install.json so a re-run reuses secrets', async () => {
  seed('compose')
  const old = fake('compose', true, saved({ botToken: 'TOK1', ownerId: 42 }))
  const targets = {
    quadlet: fake('quadlet'),
    compose: old,
    systemd: fake('systemd'),
    launchd: fake('launchd'),
  }
  const d1 = deps({ targets, isPortFree: vi.fn(async () => false) })
  expect(await runInit({ target: 'quadlet' }, d1)).toBe(1)
  expect(old.remove).toHaveBeenCalledTimes(1)
  expect(readInstall(paths.installFile)).toEqual({
    target: 'compose',
    port: 9000,
    version: '1.0.0',
  })

  targets.quadlet.install = vi.fn(async () => {
    throw new Error('podman build failed (exit 1)')
  })
  expect(await runInit({ target: 'quadlet' }, deps({ targets }))).toBe(1)
  expect(notes().join('\n')).toContain('podman build failed (exit 1)')
  expect(readInstall(paths.installFile)?.target).toBe('compose')

  targets.quadlet.install = fake('quadlet').install
  const d3 = deps({ targets })
  expect(await runInit({ target: 'quadlet' }, d3)).toBe(0)
  expect(old.remove).toHaveBeenCalledTimes(3)
  expect(targets.quadlet.install).toHaveBeenCalledWith(
    expect.objectContaining({ settings: { botToken: 'TOK1', ownerId: 42 } }),
  )
  expect(d3.prompt.password).not.toHaveBeenCalled()
  expect(readInstall(paths.installFile)?.target).toBe('quadlet')
})

test('legacy install is recorded before removal so a failed run can be retried', async () => {
  mkdirSync(dirname(paths.systemdUnit), { recursive: true })
  writeFileSync(paths.systemdUnit, '[Service]\n')
  const d = deps({ isPortFree: vi.fn(async () => false) })
  expect(await runInit({ target: 'systemd' }, d)).toBe(1)
  expect(readInstall(paths.installFile)).toEqual({
    target: 'systemd',
    port: 8787,
    version: 'legacy',
    configFile: paths.configFile,
  })
})

test('no install record: reuses a token and owner kept by uninstall, no replace prompt', async () => {
  mkdirSync(dirname(paths.configFile), { recursive: true })
  writeFileSync(paths.configFile, JSON.stringify({ botToken: 'KTOK', ownerId: 11 }))
  const d = deps()
  expect(await runInit({ target: 'compose' }, d)).toBe(0)
  expect(d.prompt.confirm).not.toHaveBeenCalled()
  expect(d.prompt.password).not.toHaveBeenCalled()
  expect(checkOf(d)).toHaveBeenCalledWith({ botToken: 'KTOK', ownerId: 11 })
  expect(d.targets.compose.install).toHaveBeenCalledWith(
    expect.objectContaining({ settings: { botToken: 'KTOK', ownerId: 11 } }),
  )
  expect(notes().join('\n')).toContain('Reusing the saved bot token (@mybot).')
  expect(notes().join('\n')).not.toContain('KTOK')
})

test('no install record: leftover token from a container .env, rejected token prompts', async () => {
  mkdirSync(paths.quadletDirectory, { recursive: true })
  writeFileSync(
    join(paths.quadletDirectory, '.env'),
    'JAYPOST_BOT_TOKEN=stale\nJAYPOST_PORT=1\nJAYPOST_OWNER_ID=4\n',
  )
  const validate = vi.fn(async (settings: SettingValues) =>
    settings.botToken === 'stale' ? REJECTED : ACCEPTED,
  )
  const d = deps({ providers: [telegram(validate)] })
  expect(await runInit({}, d)).toBe(0)
  expect(d.prompt.password).toHaveBeenCalledTimes(1)
  expect(d.targets.quadlet.install).toHaveBeenCalledWith(
    expect.objectContaining({ settings: { botToken: 'good-token', ownerId: 4 } }),
  )
})

test('a reused secret is masked when removing the old install fails', async () => {
  seed('compose')
  const old = fake('compose', true, saved({ botToken: 'TOK1', ownerId: 42 }))
  old.remove = vi.fn(async () => {
    throw new Error('down failed: TOK1')
  })
  const d = deps({
    targets: {
      quadlet: fake('quadlet'),
      compose: old,
      systemd: fake('systemd'),
      launchd: fake('launchd'),
    },
  })
  expect(await runInit({ target: 'quadlet' }, d)).toBe(1)
  const text = notes().join('\n')
  expect(text).toContain('Install failed: down failed: ***')
  expect(text).not.toContain('TOK1')
})

test('single provider: no provider prompt and unchanged output', async () => {
  const d = deps()
  expect(await runInit({}, d)).toBe(0)
  expect(d.prompt.select).toHaveBeenCalledTimes(1)
  expect(vi.mocked(d.prompt.select).mock.calls[0]?.[0]).toBe('Where should the bot run?')
  expect(notes()).toEqual([
    'Done. Try it: jaypost ping',
    'Check state: jaypost status',
    savedLine(),
    CONTAINER_LINE,
    'Admin commands: jaypost admin key create --help',
    'Logs: logs for quadlet',
  ])
})

test('a native install ends with where the admin key is', async () => {
  const configFile = join(tmp, 'service', 'config.json')
  const systemd = fake('systemd')
  systemd.install = vi.fn(async (o) => ({
    target: 'systemd' as const,
    port: o.port,
    version: o.version,
    configFile,
  }))
  const d = deps({
    targets: {
      quadlet: fake('quadlet'),
      compose: fake('compose'),
      systemd,
      launchd: fake('launchd'),
    },
  })
  expect(await runInit({ target: 'systemd' }, d)).toBe(0)
  expect(notes()).toEqual([
    'Done. Try it: jaypost ping',
    'Check state: jaypost status',
    savedLine(),
    CONTAINER_LINE,
    `Admin key: ${join(tmp, 'service', 'admin-key')}`,
    'Logs: logs for systemd',
  ])
})

test('--provider unknown returns 1', async () => {
  const d = deps()
  expect(await runInit({ provider: 'nope' }, d)).toBe(1)
  expect(notes()).toContain('Unknown provider "nope".')
  expect(d.targets.quadlet.install).not.toHaveBeenCalled()
})

test('provider prompt when several are registered', async () => {
  const other = createFakeProvider()
  const d = deps({ providers: [telegram(), other] })
  vi.mocked(d.prompt.select)
    .mockImplementationOnce(async (_q, _o, initialValue) => initialValue)
    .mockImplementationOnce(async () => 'fake')
  vi.mocked(d.prompt.password).mockImplementation(async () => 'fk')
  expect(await runInit({}, d)).toBe(0)
  expect(vi.mocked(d.prompt.select).mock.calls[1]).toEqual([
    'Which chat app should the bot use?',
    [
      { value: 'telegram', label: 'Telegram' },
      { value: 'fake', label: 'Fake' },
    ],
    'telegram',
  ])
  expect(d.prompt.password).toHaveBeenCalledWith('Fake key')
  expect(d.targets.quadlet.install).toHaveBeenCalledWith(
    expect.objectContaining({ provider: other, settings: { fakeKey: 'fk' } }),
  )
})

test('switching provider asks, clears the old owner and drops old settings', async () => {
  seed('compose')
  const old = fake('compose', true, saved({ botToken: 't', ownerId: 42 }))
  const d = deps({
    targets: {
      quadlet: fake('quadlet'),
      compose: old,
      systemd: fake('systemd'),
      launchd: fake('launchd'),
    },
    providers: [telegram(), createPairingFakeProvider()],
  })
  expect(await runInit({ target: 'quadlet', provider: 'fakepair' }, d)).toBe(0)
  expect(vi.mocked(d.prompt.confirm).mock.calls).toEqual([
    ['Replace it?', true],
    ['This deletes the saved Telegram settings and paired owner. Continue?', false],
    [REQUIRE, true],
  ])
  expect(old.clearOwner).toHaveBeenCalledWith(expect.objectContaining({ target: 'compose' }))
  expect(old.remove).toHaveBeenCalled()
  expect(d.prompt.password).toHaveBeenCalledWith('Fake key')
  expect(d.targets.quadlet.install).toHaveBeenCalledWith(
    expect.objectContaining({ settings: { fakeKey: 'good-token' } }),
  )
})

test('declining the switch changes nothing', async () => {
  seed('compose')
  const old = fake('compose', true, saved({ botToken: 't', ownerId: 42 }))
  const d = deps({
    targets: {
      quadlet: fake('quadlet'),
      compose: old,
      systemd: fake('systemd'),
      launchd: fake('launchd'),
    },
    providers: [telegram(), createPairingFakeProvider()],
  })
  vi.mocked(d.prompt.confirm).mockImplementation(async (message) => message === 'Replace it?')
  expect(await runInit({ provider: 'fakepair' }, d)).toBe(0)
  expect(old.clearOwner).not.toHaveBeenCalled()
  expect(old.remove).not.toHaveBeenCalled()
  expect(d.targets.quadlet.install).not.toHaveBeenCalled()
  expect(readInstall(paths.installFile)).toEqual({
    target: 'compose',
    port: 9000,
    version: '1.0.0',
  })
})

test('leftover secrets of another provider are not reused', async () => {
  mkdirSync(paths.quadletDirectory, { recursive: true })
  writeFileSync(
    join(paths.quadletDirectory, '.env'),
    'JAYPOST_BOT_TOKEN=LEFT\nJAYPOST_OWNER_ID=4\n',
  )
  const d = deps({ providers: [telegram(), createFakeProvider()] })
  expect(await runInit({ provider: 'fake' }, d)).toBe(0)
  expect(notes()).not.toContain(telegramProvider.setup.text.leftoverFound)
  expect(d.prompt.password).toHaveBeenCalledWith('Fake key')
  expect(d.targets.quadlet.install).toHaveBeenCalledWith(
    expect.objectContaining({ settings: { fakeKey: 'good-token' } }),
  )
})

test('every secret setting value is masked in errors', async () => {
  const base = createFakeProvider().settings[0]!
  const provider = createFakeProvider({
    settings: [
      { ...base, configKey: 'first', prompt: 'First' },
      { ...base, configKey: 'second', prompt: 'Second' },
    ],
  })
  const d = deps({ providers: [provider] })
  vi.mocked(d.prompt.password)
    .mockResolvedValueOnce('SECRET-ONE')
    .mockResolvedValueOnce('SECRET-TWO')
  vi.mocked(d.targets.quadlet.install).mockImplementation(async () => {
    throw new Error('boom SECRET-ONE SECRET-TWO')
  })
  expect(await runInit({}, d)).toBe(1)
  expect(notes()).toContain('Install failed: boom *** ***')
})

test('non-secret prompted setting uses the text prompt', async () => {
  const base = createFakeProvider().settings[0]!
  const provider = createFakeProvider({
    settings: [base, { ...base, configKey: 'room', secret: false, prompt: 'Room' }],
  })
  const d = deps({ providers: [provider] })
  expect(await runInit({}, d)).toBe(0)
  expect(d.prompt.text).toHaveBeenCalledWith('Room')
  expect(d.prompt.password).toHaveBeenCalledTimes(1)
  expect(d.targets.quadlet.install).toHaveBeenCalledWith(
    expect.objectContaining({ settings: { fakeKey: 'good-token', room: 'text-answer' } }),
  )
})

test('a provider with nothing to prompt and rejected credentials returns 1', async () => {
  const provider = createFakeProvider({
    settings: [{ ...createFakeProvider().settings[0]!, prompt: undefined, required: false }],
    setup: { ...createFakeProvider().setup, checkCredentials: async () => REJECTED },
  })
  const d = deps({ providers: [provider] })
  expect(await runInit({}, d)).toBe(1)
  expect(notes()).toEqual([provider.setup.text.rejected])
  expect(d.prompt.password).not.toHaveBeenCalled()
  expect(d.targets.quadlet.install).not.toHaveBeenCalled()
})

test('fresh install generates a token and passes it to the install and the wait', async () => {
  const d = deps()
  expect(await runInit({}, d)).toBe(0)
  const token = installedToken(d.targets.quadlet)
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(d.wait).toHaveBeenCalledWith(expect.objectContaining({ token }))
  expect(d.targets.quadlet.readApiToken).not.toHaveBeenCalled()
  expect(wasAsked(d)).toBe(false)
  expect(notes()).toContain(CONTAINER_LINE)
  expect(notes().join('\n')).not.toContain(token)
})

test("service install reuses the token the existing install's service holds", async () => {
  seed('compose')
  const targets = systemdFirst()
  targets.compose.readApiToken = vi.fn(async () => TOKEN)
  const d = deps({ targets })
  expect(await runInit({ target: 'quadlet' }, d)).toBe(0)
  expect(targets.compose.readApiToken).toHaveBeenCalledWith({
    target: 'compose',
    port: 9000,
    version: '1.0.0',
  })
  expect(d.targets.quadlet.install).toHaveBeenCalledWith(
    expect.objectContaining({ auth: { kind: 'token', token: TOKEN } }),
  )
  expect(d.wait).toHaveBeenCalledWith(expect.objectContaining({ token: TOKEN }))
  expect(notes()).toContain('Reusing the saved API token.')
  expect(wasAsked(d)).toBe(false)
  expect(readBook(bookPath).bots).toEqual([
    { alias: 'local', url: 'http://127.0.0.1:9000/', key: TOKEN },
  ])
  expect(notes().join('\n')).not.toContain(TOKEN)
})

test('replacing an install whose service holds no token asks, and yes makes one', async () => {
  seed('compose')
  const d = deps()
  expect(await runInit({}, d)).toBe(0)
  expect(d.prompt.confirm).toHaveBeenCalledWith(REQUIRE, true)
  const token = installedToken(d.targets.quadlet)
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(notes()).toContain(CONTAINER_LINE)
})

test('answering no installs without a token and saves the seed without a key', async () => {
  seed('compose')
  const d = deps()
  vi.mocked(d.prompt.confirm).mockImplementation(async (message) => message !== REQUIRE)
  expect(await runInit({}, d)).toBe(0)
  expect(d.targets.quadlet.install).toHaveBeenCalledWith(expect.objectContaining({ auth: NO_AUTH }))
  expect(d.wait).toHaveBeenCalledWith(expect.not.objectContaining({ token: expect.anything() }))
  expect(notes()).toContain(NO_TOKEN_LINE)
  expect(notes()).not.toContain(CONTAINER_LINE)
  expect(readBook(bookPath).bots).toEqual([{ alias: 'local', url: 'http://127.0.0.1:9000/' }])
})

test('--token and --no-token skip the question', async () => {
  for (const token of [true, false]) {
    seed('compose')
    const d = deps()
    expect(await runInit({ token }, d)).toBe(0)
    expect(wasAsked(d)).toBe(false)
    expect(installedToken(d.targets.quadlet) !== undefined).toBe(token)
  }
})

test('--no-token ignores the token the existing service holds', async () => {
  seed('compose')
  const targets = systemdFirst()
  targets.compose.readApiToken = vi.fn(async () => TOKEN)
  const d = deps({ targets })
  expect(await runInit({ target: 'quadlet', token: false }, d)).toBe(0)
  expect(d.targets.quadlet.install).toHaveBeenCalledWith(expect.objectContaining({ auth: NO_AUTH }))
  expect(notes()).toContain(NO_TOKEN_LINE)
})

test('an invalid saved token is replaced without asking', async () => {
  seed('compose')
  const targets = systemdFirst()
  targets.compose.readApiToken = vi.fn(async () => 'short-secret')
  const d = deps({ targets })
  expect(await runInit({ target: 'quadlet' }, d)).toBe(0)
  const token = installedToken(d.targets.quadlet)
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(notes()).toContain('The saved API token was invalid; made a new one.')
  expect(wasAsked(d)).toBe(false)
  expect(notes().join('\n')).not.toContain('short-secret')
})

test('an invalid apiToken in a native install is replaced on service install', async () => {
  mkdirSync(dirname(paths.configFile), { recursive: true })
  writeFileSync(
    paths.configFile,
    JSON.stringify({ provider: 'telegram', botToken: 'n-tok', apiToken: 'short-secret' }),
  )
  writeInstall(paths.installFile, {
    target: 'systemd',
    port: 9000,
    version: '1.0.0',
    configFile: paths.configFile,
  })
  // The real systemd target, so the token is read from config.json as the service would.
  const real = createTargets(
    {
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      paths,
      env: { HOME: tmp, XDG_CONFIG_HOME: join(tmp, 'cfg') },
      user: 'me',
      providers: [telegram()],
      platform: 'linux',
      uid: 501,
    },
    { kind: 'npm', selfPath: '/src/dist/cli.js', nodePath: '/usr/bin/node' },
  )
  const targets = systemdFirst()
  targets.systemd.readApiToken = real.systemd.readApiToken
  targets.systemd.readSecrets = real.systemd.readSecrets
  const d = deps({ targets })
  expect(await runInit({ target: 'quadlet' }, d)).toBe(0)
  const token = installedToken(d.targets.quadlet)
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(notes()).toContain('The saved API token was invalid; made a new one.')
  expect(notes().join('\n')).not.toContain('short-secret')
  expect(notes().join('\n')).not.toContain('jaypost init')
})

test('a token that cannot be read fails the install', async () => {
  seed('compose')
  const targets = systemdFirst()
  targets.compose.readApiToken = vi.fn(async () => {
    throw new Error('config unreadable')
  })
  const d = deps({ targets })
  expect(await runInit({ target: 'quadlet' }, d)).toBe(1)
  expect(notes().join('\n')).toContain('Install failed: config unreadable')
  expect(d.targets.quadlet.install).not.toHaveBeenCalled()
})

test('the token is masked in install errors', async () => {
  seed('compose')
  const targets = systemdFirst()
  targets.compose.readApiToken = vi.fn(async () => TOKEN)
  const d = deps({ targets })
  vi.mocked(d.targets.quadlet.install).mockImplementation(async () => {
    throw new Error(`boom ${TOKEN}`)
  })
  expect(await runInit({ target: 'quadlet' }, d)).toBe(1)
  const text = notes().join('\n')
  expect(text).toContain('Install failed: boom ***')
  expect(text).not.toContain(TOKEN)
})

test('a stale JAYPOST_TOKEN in the shell does not reach the wait', async () => {
  const d = deps({ env: { JAYPOST_TOKEN: OTHER_TOKEN } })
  expect(await runInit({}, d)).toBe(0)
  const token = installedToken(d.targets.quadlet)
  expect(d.wait).toHaveBeenCalledWith(expect.objectContaining({ token }))
  expect(token).not.toBe(OTHER_TOKEN)
})

test('service install writes local and the seed bot to the book before waiting for pairing', async () => {
  const d = deps({
    wait: vi.fn(async () => {
      const book = readBook(bookPath)
      expect(book).toEqual({
        version: 1,
        default: 'local',
        local: { url: LOCAL_URL },
        remotes: [],
        bots: [{ alias: 'local', url: LOCAL_URL, key: installedToken(d.targets.quadlet) }],
      })
      return 'paired' as const
    }),
  })
  expect(await runInit({}, d)).toBe(0)
  expect(d.wait).toHaveBeenCalledTimes(1)
  expect(statSync(bookPath).mode & 0o777).toBe(0o600)
})

test('service install saves the admin key to the book once the service answers', async () => {
  const d = deps()
  expect(await runInit({ target: 'systemd' }, d)).toBe(0)
  expect(d.targets.systemd.readAdminKey).toHaveBeenCalledWith({
    target: 'systemd',
    port: 8787,
    version: '1.2.3',
  })
  const book = readBook(bookPath)
  expect(book.local).toEqual({ url: LOCAL_URL, adminKey: ADMIN_KEY })
  expect(book.bots.map((bot) => bot.alias)).toEqual(['local'])
  expect(notes().join('\n')).not.toContain(ADMIN_KEY)
})

test('service install reads the admin key whatever the wait returned', async () => {
  const d = deps({ wait: vi.fn(async () => 'stopped' as const) })
  expect(await runInit({}, d)).toBe(1)
  expect(readBook(bookPath).local).toEqual({ url: LOCAL_URL, adminKey: ADMIN_KEY })
})

test('an unreadable admin key is a note, not a failed install', async () => {
  const targets = systemdFirst()
  targets.quadlet.readAdminKey = vi.fn(async () => {
    throw new Error('admin key file missing')
  })
  const d = deps({ targets })
  expect(await runInit({ target: 'quadlet' }, d)).toBe(0)
  expect(notes()).toContain(
    "Couldn't save the admin key to the contact book: admin key file missing",
  )
  expect(readBook(bookPath).local).toEqual({ url: LOCAL_URL })
})

test('a rerun keeps a renamed seed bot and the other bots in the book', async () => {
  expect(await runInit({ token: true }, deps())).toBe(0)
  const first = readBook(bookPath)
  const key = first.bots[0]?.key
  writeFileSync(
    bookPath,
    JSON.stringify({
      ...first,
      default: 'other',
      bots: [
        { alias: 'home', url: LOCAL_URL, ...(key === undefined ? {} : { key }) },
        { alias: 'other', url: 'https://bots.example.com/', key: OTHER_TOKEN },
      ],
    }),
  )
  seed('quadlet', 8787)
  const targets = systemdFirst()
  targets.quadlet.readApiToken = vi.fn(async () => key)
  recording = createRecordingProgress()
  expect(await runInit({ target: 'quadlet' }, deps({ targets }))).toBe(0)
  const book = readBook(bookPath)
  expect(book.default).toBe('other')
  expect(book.bots.map((bot) => bot.alias)).toEqual(['home', 'other'])
  expect(notes()).toContain(`Your bot is saved as "home" in ${bookPath}.`)
})

test('a corrupt contact book fails the install before anything is installed', async () => {
  mkdirSync(dirname(bookPath), { recursive: true })
  writeFileSync(bookPath, '{nope')
  const d = deps()
  expect(await runInit({}, d)).toBe(1)
  expect(notes().join('\n')).toContain(`contact book ${JSON.stringify(bookPath)} isn't valid`)
  expect(d.targets.quadlet.install).not.toHaveBeenCalled()
})

test('service install --exposed passes exposed and prints the remote add line with the hostname', async () => {
  const d = deps()
  expect(await runInit({ exposed: true, port: 9100 }, d)).toBe(0)
  expect(d.targets.quadlet.install).toHaveBeenCalledWith(
    expect.objectContaining({ exposed: true, port: 9100 }),
  )
  const all = notes()
  expect(all[0]).toBe(
    '--exposed listens on all interfaces over plain http; keys cross the network in the clear. Use it on a LAN or behind a TLS proxy.',
  )
  expect(all.slice(-3)).toEqual([
    'To manage this service from another machine, run there:',
    '',
    `  jaypost remote add box.lan http://box.lan:9100 ${ADMIN_KEY}`,
  ])
  expect(readBook(bookPath).local).toEqual({ url: 'http://127.0.0.1:9100/', adminKey: ADMIN_KEY })
})

test('service install without --exposed passes no exposed flag and prints no remote line', async () => {
  const d = deps()
  expect(await runInit({}, d)).toBe(0)
  const [options] = vi.mocked(d.targets.quadlet.install).mock.calls[0]!
  expect(options.exposed).toBeUndefined()
  expect(notes().join('\n')).not.toContain('remote add')
})

test('an unauthorized wait returns 1 with the hint', async () => {
  const d = deps({ wait: vi.fn(async () => 'unauthorized' as const) })
  expect(await runInit({}, d)).toBe(1)
  expect(notes()).toContain(TOKEN_REJECTED_MESSAGE)
})

test('init ticks the checks and runs the install as a checklist', async () => {
  const d = deps({ platform: 'linux', targets: systemdFirst() })
  expect(await runInit({ target: 'systemd' }, d)).toBe(0)
  const { events } = recording
  const doneIndex = events.findIndex((event) => event.startsWith('note:Done.'))
  expect(events.slice(0, doneIndex)).toEqual([
    'done:Bot token checked (@mybot)',
    'done:Port 8787 is free',
    'plan:Installing the systemd service|Waiting for the service to start|Waiting for pairing',
    'start:Installing the systemd service',
    'succeed:Installed the systemd service',
  ])
})

test('init names the image build for container targets', async () => {
  expect(await runInit({ target: 'compose' }, deps())).toBe(0)
  expect(recording.events).toContain(
    'plan:Building the compose image|Waiting for the service to start|Waiting for pairing',
  )
})

test('init marks the install step failed before the install failed message', async () => {
  const targets = systemdFirst()
  vi.mocked(targets.systemd.install).mockRejectedValue(new Error('boom'))
  expect(await runInit({ target: 'systemd' }, deps({ targets }))).toBe(1)
  const { events } = recording
  const failed = events.indexOf('fail:Installing the systemd service')
  expect(failed).toBeGreaterThan(-1)
  expect(failed).toBeLessThan(events.indexOf('note:Install failed: boom'))
})

test('init fails the install step when the install record cannot be written', async () => {
  // A directory where install.json goes makes the write throw after the target installed.
  mkdirSync(paths.installFile, { recursive: true })
  expect(await runInit({ target: 'systemd' }, deps({ targets: systemdFirst() }))).toBe(1)
  const { events } = recording
  expect(events.slice(events.indexOf('start:Installing the systemd service'))).toEqual([
    'start:Installing the systemd service',
    'fail:Installing the systemd service',
    expect.stringMatching(/^note:Install failed: /),
    'note:Run jaypost service install again. Check the logs for details.',
  ])
})

test('init cancels the install step when interrupted during the install', async () => {
  const controller = new AbortController()
  const targets = systemdFirst()
  vi.mocked(targets.systemd.install).mockImplementation(async () => {
    controller.abort()
    throw new Error('killed')
  })
  expect(await runInit({ target: 'systemd' }, deps({ targets, signal: controller.signal }))).toBe(
    130,
  )
  expect(recording.events.slice(-2)).toEqual(['cancel:Installing the systemd service', 'note:'])
})

test('init passes the install step output to the target', async () => {
  const targets = systemdFirst()
  vi.mocked(targets.systemd.install).mockImplementation(async (options) => {
    options.output?.('npm notice\n')
    return { target: 'systemd', port: options.port, version: options.version }
  })
  expect(await runInit({ target: 'systemd' }, deps({ targets }))).toBe(0)
  expect(recording.events).toContain('output:npm notice\n')
})

function systemdFirst(): Record<TargetName, Mutable<Target>> {
  return {
    quadlet: fake('quadlet'),
    compose: fake('compose'),
    systemd: fake('systemd'),
    launchd: fake('launchd'),
  }
}
