import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import {
  applySeed,
  createEmptyRegistry,
  loadSeed,
  NO_CLIENT_TOKEN,
  openDatabase,
  RegistryStore,
  resolveAdminKeyPath,
  resolveBotFiles,
  resolveDatabasePath,
} from '@jaypost/store'
import { startService } from '@jaypost/service'
import type { RunningService } from '@jaypost/service'
import { createPairingFakeProvider } from '@jaypost/testing'
import { runAudit, runLog } from '../../src/commands/index.ts'
import type { LogArgs, LogDeps } from '../../src/commands/index.ts'
import { resolveInstallPaths, writeInstall } from '@jaypost/install'
import type { InstallPaths, Target, TargetName } from '@jaypost/install'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const NOW = new Date('2026-10-19T08:00:00Z')
const API_TOKEN = 'a'.repeat(43)
const PAIRING_PROVIDERS = [createPairingFakeProvider()]

let tmp: string
let paths: InstallPaths
let out: string[]
let err: string[]
let running: RunningService | undefined

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'log-'))
  paths = resolveInstallPaths({ HOME: tmp, XDG_CONFIG_HOME: join(tmp, 'cfg') })
  out = []
  err = []
})

afterEach(async () => {
  await running?.stop()
  running = undefined
})

function asked(id: string, at: string, project?: string): string {
  return `${JSON.stringify({
    v: 1,
    event: 'asked',
    id,
    at,
    ...(project === undefined ? {} : { project }),
    text: `question ${id}`,
    options: ['Approve', 'Decline'],
    timeoutOption: 'Decline',
    timeoutSeconds: 300,
    attachment: undefined,
  })}\n`
}

function askedBy(id: string, at: string, key: string): string {
  return `${JSON.stringify({
    v: 1,
    event: 'asked',
    id,
    at,
    text: `question ${id}`,
    options: ['Approve', 'Decline'],
    timeoutOption: 'Decline',
    timeoutSeconds: 300,
    key,
    pairing: 'p1',
  })}\n`
}

function settled(id: string, at: string): string {
  return `${JSON.stringify({ v: 1, event: 'settled', id, at, outcome: 'answered', answer: 'Approve' })}\n`
}

function many(count: number): string {
  return Array.from({ length: count }, (_, index) => {
    const minutes = String(index).padStart(2, '0')
    return asked(`id${minutes}`, `2026-10-19T07:${minutes}:00.000Z`)
  }).join('')
}

function fake(name: TargetName, log: string | Error = ''): Mutable<Target> {
  return {
    name,
    readAuditLog: vi.fn(async () => {
      if (log instanceof Error) {
        throw log
      }
      return log
    }),
  } as unknown as Mutable<Target>
}

function setup(log: string | Error = '', version = '1.0.0', recordVersion = '1.0.0') {
  const targets = {
    quadlet: fake('quadlet'),
    compose: fake('compose'),
    systemd: fake('systemd', log),
    launchd: fake('launchd'),
  }
  writeInstall(paths.installFile, { target: 'systemd', port: 9000, version: recordVersion })
  return targets
}

function deps(targets: LogDeps['targets'], over: Partial<LogDeps> = {}): LogDeps {
  return {
    targets,
    paths,
    env: { HOME: tmp, XDG_CONFIG_HOME: join(tmp, 'cfg') },
    token: NO_CLIENT_TOKEN,
    version: '1.0.0',
    now: () => NOW,
    print: (text) => out.push(text),
    printError: (text) => err.push(text),
    ...over,
  }
}

async function run(args: LogArgs, log: string | Error = '', version = '1.0.0') {
  const targets = setup(log, version, version)
  const code = await runLog(args, deps(targets, { version }))
  return { code, targets }
}

test('prints the merged table, oldest first', async () => {
  const log =
    asked('a', '2026-10-19T06:00:00.000Z') +
    asked('b', '2026-10-19T07:00:00.000Z') +
    settled('a', '2026-10-19T06:01:00.000Z')
  const { code } = await run({}, log)
  expect(code).toBe(0)
  expect(out).toHaveLength(1)
  const lines = (out[0] ?? '').split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[0]).toContain('question a')
  expect(lines[0]).toContain('Approve')
  expect(lines[1]).toContain('question b')
})

test('--json prints one merged entry per line', async () => {
  const log = asked('a', '2026-10-19T06:00:00.000Z') + settled('a', '2026-10-19T06:01:00.000Z')
  const { code } = await run({ json: true }, log)
  expect(code).toBe(0)
  const entries = (out[0] ?? '').split('\n').map((line) => JSON.parse(line))
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({ id: 'a', status: 'answered', answer: 'Approve' })
})

test('without --since shows the last 20; with --since shows all; explicit -n wins', async () => {
  const log = many(25)
  const count = () => (out[0] ?? '').split('\n').length
  await run({}, log)
  expect(count()).toBe(20)
  out = []
  await run({ since: new Date('2000-01-01') }, log)
  expect(count()).toBe(25)
  out = []
  await run({ since: new Date('2000-01-01'), limit: 3 }, log)
  expect(count()).toBe(3)
})

test('--project filters by exact name', async () => {
  const log =
    asked('a', '2026-10-19T06:00:00.000Z', 'web') + asked('b', '2026-10-19T06:01:00.000Z', 'webby')
  await run({ project: 'web' }, log)
  expect(out[0]).toContain('question a')
  expect(out[0]).not.toContain('question b')
})

test('empty log prints No questions logged. and exits 0', async () => {
  const { code } = await run({}, '')
  expect(code).toBe(0)
  expect(out).toEqual(['No questions logged.'])
})

test('filters that drop everything print No questions match.', async () => {
  const { code } = await run({ project: 'nope' }, asked('a', '2026-10-19T06:00:00.000Z'))
  expect(code).toBe(0)
  expect(out).toEqual(['No questions match.'])
})

test('skipped lines are reported on stderr after the output', async () => {
  const log = `${asked('a', '2026-10-19T06:00:00.000Z')}garbage\n{"v":\n`
  const { code } = await run({}, log)
  expect(code).toBe(0)
  expect(out).toHaveLength(1)
  expect(err).toEqual(['skipped 2 unreadable log lines'])
})

test('--json with no entries keeps stdout empty and says so on stderr', async () => {
  expect((await run({ json: true }, '')).code).toBe(0)
  expect(out).toEqual([])
  expect(err).toEqual(['No questions logged.'])
  err = []
  await run({ json: true, project: 'nope' }, asked('a', '2026-10-19T06:00:00.000Z'))
  expect(out).toEqual([])
  expect(err).toEqual(['No questions match.'])
})

test('a single unreadable line is reported in the singular', async () => {
  await run({}, `${asked('a', '2026-10-19T06:00:00.000Z')}garbage\n`)
  expect(err).toEqual(['skipped 1 unreadable log line'])
})

test('versions compare numerically: 0.10.0 and 1.0.0 are fine, unparsable is too old', async () => {
  for (const recordVersion of ['0.10.0', '1.0.0']) {
    const targets = setup(asked('a', '2026-10-19T06:00:00.000Z'), '1.0.0', recordVersion)
    out = []
    expect(await runLog({}, deps(targets, { version: '2.0.0' }))).toBe(0)
    expect(out[0]).toContain('question a')
  }
  err = []
  const targets = setup('', '1.0.0', 'banana')
  expect(await runLog({}, deps(targets, { version: '2.0.0' }))).toBe(1)
  expect(err[0]).toContain('(banana)')
})

test('legacy and 0.4.0 installs are too old and nothing runs', async () => {
  for (const recordVersion of ['0.4.0', 'legacy']) {
    err = []
    const targets = setup('', '1.0.0', recordVersion)
    expect(await runLog({}, deps(targets))).toBe(1)
    expect(err).toEqual([
      `the installed service (${recordVersion}) doesn't keep a log; run jaypost init to upgrade`,
    ])
    expect(targets.systemd.readAuditLog).not.toHaveBeenCalled()
  }
})

test('an install recorded with the running CLI version is read even below the minimum', async () => {
  const { code, targets } = await run({}, asked('a', '2026-10-19T06:00:00.000Z'), '0.4.0')
  expect(code).toBe(0)
  expect(targets.systemd.readAuditLog).toHaveBeenCalled()
  expect(out[0]).toContain('question a')
})

test('a failing readAuditLog prints its message and exits 1', async () => {
  const { code } = await run({}, new Error('boom'))
  expect(code).toBe(1)
  expect(err).toEqual(['boom'])
  expect(out).toEqual([])
})

test('without an install reads the files next to the env config', async () => {
  const directory = join(tmp, 'elsewhere')
  mkdirSync(directory)
  writeFileSync(join(directory, 'audit.jsonl'), asked('a', '2026-10-19T06:00:00.000Z'))
  const targets = {
    quadlet: fake('quadlet'),
    compose: fake('compose'),
    systemd: fake('systemd'),
    launchd: fake('launchd'),
  }
  const code = await runLog(
    {},
    deps(targets, { env: { HOME: tmp, JAYPOST_CONFIG: join(directory, 'config.json') } }),
  )
  expect(code).toBe(0)
  expect(out[0]).toContain('question a')
  expect(targets.systemd.readAuditLog).not.toHaveBeenCalled()
})

test.skipIf(process.getuid?.() === 0)(
  'without an install, an unreadable log exits 1 with the path',
  async () => {
    const directory = join(tmp, 'elsewhere')
    mkdirSync(directory)
    const file = join(directory, 'audit.jsonl')
    writeFileSync(file, asked('a', '2026-10-19T06:00:00.000Z'))
    chmodSync(file, 0o000)
    const targets = {
      quadlet: fake('quadlet'),
      compose: fake('compose'),
      systemd: fake('systemd'),
      launchd: fake('launchd'),
    }
    const code = await runLog(
      {},
      deps(targets, { env: { HOME: tmp, JAYPOST_CONFIG: join(directory, 'config.json') } }),
    )
    expect(code).toBe(1)
    expect(err).toHaveLength(1)
    expect(err[0]).toContain(file)
  },
)

type Started = { readonly port: number; readonly adminKey: string; readonly configPath: string }

/** A real service whose bot 1 (fakepair) is paired to u1 with key 1, its log holding `log`. */
async function start(log: string): Promise<Started> {
  const directory = join(tmp, 'service')
  mkdirSync(directory)
  const configPath = join(directory, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      provider: 'fakepair',
      fakeKey: 'seed-bot',
      fakeOwner: 'u1',
      apiToken: API_TOKEN,
    }),
  )
  running = await startService({
    version: '1.0.0',
    configPath,
    providers: PAIRING_PROVIDERS,
    seed: loadSeed({ JAYPOST_CONFIG: configPath }, PAIRING_PROVIDERS),
    log: vi.fn(),
  })
  await running.started
  await running.server.listen({ port: 0, host: '127.0.0.1' })
  const { port } = running.server.server.address() as AddressInfo
  const files = resolveBotFiles(configPath, 'b1')
  mkdirSync(files.directory, { recursive: true })
  writeFileSync(files.auditPath, log)
  const adminKey = readFileSync(resolveAdminKeyPath(configPath), 'utf8').trim()
  return { port, adminKey, configPath }
}

/** Targets where systemd is the install on `port`, reading `adminKey` and `log`. */
function installedOn(port: number, adminKey: string, log = '') {
  const systemd = fake('systemd', log)
  systemd.readAdminKey = vi.fn(async () => adminKey)
  writeInstall(paths.installFile, { target: 'systemd', port, version: '1.0.0' })
  return { quadlet: fake('quadlet'), compose: fake('compose'), systemd, launchd: fake('launchd') }
}

const TWO_KEYS_LOG =
  askedBy('a', '2026-10-19T06:00:00.000Z', 'k1') + askedBy('b', '2026-10-19T06:01:00.000Z', 'k2')

test("audit dump prints the seed bot's lines", () => {
  const directory = join(tmp, 'data')
  mkdirSync(directory)
  const configPath = join(directory, 'config.json')
  writeFileSync(configPath, JSON.stringify({ provider: 'fakepair', fakeKey: 'k', fakeOwner: 'u1' }))
  writeFileSync(join(directory, 'audit.jsonl'), asked('legacy', '2026-10-19T05:00:00.000Z'))
  const { auditPath } = resolveBotFiles(configPath, 'b1')
  mkdirSync(dirname(auditPath), { recursive: true })
  writeFileSync(auditPath, asked('a', '2026-10-19T06:00:00.000Z'))
  const env = { JAYPOST_CONFIG: configPath }
  const loaded = loadSeed(env, PAIRING_PROVIDERS)
  if (loaded.kind !== 'seed') {
    throw new Error(loaded.message)
  }
  const seeded = applySeed(createEmptyRegistry(), loaded.seed, true, () => 'SEED1111', NOW)
  const database = openDatabase(resolveDatabasePath(configPath))
  try {
    new RegistryStore(database).save(seeded.registry)
  } finally {
    database.close()
  }
  const written: string[] = []
  expect(runAudit(['dump'], env, (text) => written.push(text))).toBe(0)
  expect(written).toEqual([asked('a', '2026-10-19T06:00:00.000Z')])
})

test('log --key k2 goes through the admin route with the local admin key', async () => {
  const started = await start(TWO_KEYS_LOG)
  const targets = installedOn(started.port, started.adminKey)
  expect(await runLog({ key: 'k2', json: true }, deps(targets))).toBe(0)
  expect(targets.systemd.readAdminKey).toHaveBeenCalled()
  expect(targets.systemd.readAuditLog).not.toHaveBeenCalled()
  expect((out[0] ?? '').split('\n').map((line) => JSON.parse(line))).toEqual([
    expect.objectContaining({ id: 'b', key: 'k2', pairing: 'p1', bot: 'b1' }),
  ])
  expect(err).toEqual([])
})

test('log --all reads every bot through the admin route', async () => {
  const started = await start(TWO_KEYS_LOG)
  const targets = installedOn(started.port, started.adminKey)
  expect(await runLog({ all: true, json: true }, deps(targets))).toBe(0)
  expect((out[0] ?? '').split('\n').map((line) => JSON.parse(line).id)).toEqual(['a', 'b'])
})

test('log without flags still reads the install files', async () => {
  const started = await start(TWO_KEYS_LOG)
  const targets = installedOn(
    started.port,
    started.adminKey,
    asked('f', '2026-10-19T06:00:00.000Z'),
  )
  expect(await runLog({}, deps(targets))).toBe(0)
  expect(targets.systemd.readAuditLog).toHaveBeenCalled()
  expect(targets.systemd.readAdminKey).not.toHaveBeenCalled()
  expect(out).toHaveLength(1)
  expect(out[0]).toContain('question f')
  expect(out[0]).not.toContain('question b')
})

test('log with JAYPOST_URL and no admin key reads GET /log with the client token', async () => {
  const started = await start(TWO_KEYS_LOG)
  const targets = installedOn(started.port, started.adminKey)
  const env = { HOME: tmp, JAYPOST_URL: `http://127.0.0.1:${started.port}` }
  const token = { kind: 'token', token: API_TOKEN, source: 'env' } as const
  expect(await runLog({ json: true }, deps(targets, { env, token }))).toBe(0)
  expect(targets.systemd.readAdminKey).not.toHaveBeenCalled()
  expect((out[0] ?? '').split('\n').map((line) => JSON.parse(line).id)).toEqual(['a'])
  expect(err).toEqual([])
})

test('log --all with JAYPOST_URL and no admin key says to set it', async () => {
  const started = await start(TWO_KEYS_LOG)
  const targets = installedOn(started.port, started.adminKey)
  const env = { HOME: tmp, JAYPOST_URL: `http://127.0.0.1:${started.port}` }
  const token = { kind: 'token', token: API_TOKEN, source: 'env' } as const
  expect(await runLog({ all: true, json: true }, deps(targets, { env, token }))).toBe(0)
  expect((out[0] ?? '').split('\n').map((line) => JSON.parse(line).id)).toEqual(['a'])
  expect(err).toEqual([
    "JAYPOST_URL is set, so set JAYPOST_ADMIN_KEY too; showing only this client's questions, without --bot, --pairing, --key or --all",
  ])
})

test('log --key without a readable admin key says it shows only the client key', async () => {
  const started = await start(TWO_KEYS_LOG)
  const targets = installedOn(started.port, started.adminKey)
  targets.systemd.readAdminKey = vi.fn(async () => {
    throw new Error('no admin key here')
  })
  const token = { kind: 'token', token: API_TOKEN, source: 'file' } as const
  expect(await runLog({ key: 'k2', json: true }, deps(targets, { token }))).toBe(0)
  expect((out[0] ?? '').split('\n').map((line) => JSON.parse(line).id)).toEqual(['a'])
  expect(err).toEqual([
    "no admin key here; showing only this client's questions, without --bot, --pairing, --key or --all",
  ])
})

test('log through the API reports a rejected admin key and exits 1', async () => {
  const started = await start(TWO_KEYS_LOG)
  const targets = installedOn(started.port, 'jpa_wrong'.padEnd(47, 'x'))
  expect(await runLog({ pairing: 'p1' }, deps(targets))).toBe(1)
  expect(err).toEqual([
    'jaypost service rejected the admin key; check JAYPOST_ADMIN_KEY, or the admin key file if the key was rotated',
  ])
  expect(out).toEqual([])
})

test('log with a corrupt registry and no install exits 1 without quoting it', async () => {
  const directory = join(tmp, 'elsewhere')
  mkdirSync(directory)
  const configPath = join(directory, 'config.json')
  const database = openDatabase(resolveDatabasePath(configPath))
  database
    .prepare(
      "INSERT INTO bots (id, provider, settings, created_at) VALUES ('b1', 'fakepair', ?, '')",
    )
    .run('{"fakeKey": "secret-bot-token"')
  database.close()
  const targets = {
    quadlet: fake('quadlet'),
    compose: fake('compose'),
    systemd: fake('systemd'),
    launchd: fake('launchd'),
  }
  expect(await runLog({}, deps(targets, { env: { HOME: tmp, JAYPOST_CONFIG: configPath } }))).toBe(
    1,
  )
  expect(err).toEqual([
    `database ${JSON.stringify(resolveDatabasePath(configPath))} has an invalid registry`,
  ])
})
