import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import {
  applySeed,
  createEmptyRegistry,
  loadSeed,
  NO_CLIENT_TOKEN,
  openDatabase,
  RegistryStore,
  resolveAdminKeyPath,
  resolveDatabasePath,
} from '@jaypost/store'
import type { ClientToken } from '@jaypost/store'
import { toLocalEndpoint } from '@jaypost/client'
import { startService } from '@jaypost/service'
import type { RunningService } from '@jaypost/service'
import { resolveInstallPaths, writeInstall } from '@jaypost/install'
import type { InstallPaths, Target, TargetName } from '@jaypost/install'
import { createPairingFakeProvider } from '@jaypost/testing'
import { runAdminLog, runAudit, runLog } from '../../src/commands/index.ts'
import type { AdminLogDeps, LogArgs, LogDeps } from '../../src/commands/index.ts'
import { UNREACHABLE_STATUS } from '../../src/commands/constants.ts'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const NOW = new Date('2026-10-19T08:00:00Z')
const PAIRING_PROVIDERS = [createPairingFakeProvider()]
const KEY = 'jpk_'.padEnd(47, 'k')

type Seen = {
  readonly url: string
  readonly authorization: string | undefined
}

let tmp: string
let paths: InstallPaths
let out: string[]
let err: string[]
let running: RunningService | undefined
const servers: Server[] = []

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'log-'))
  paths = resolveInstallPaths({ HOME: tmp, XDG_CONFIG_HOME: join(tmp, 'cfg') })
  out = []
  err = []
})

afterEach(async () => {
  await running?.stop()
  running = undefined
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    }),
  )
})

function entry(id: string, askedAt: string, project?: string) {
  return {
    id,
    askedAt,
    ...(project === undefined ? {} : { project }),
    text: `question ${id}`,
    options: ['Approve', 'Decline'],
    timeoutOption: 'Decline',
    timeoutSeconds: 300,
    status: 'answered',
    answer: 'Approve',
    settledAt: askedAt,
  }
}

function asked(id: string, at: string): string {
  return `${JSON.stringify({
    v: 1,
    event: 'asked',
    id,
    at,
    text: `question ${id}`,
    options: ['Approve', 'Decline'],
    timeoutOption: 'Decline',
    timeoutSeconds: 300,
    attachment: undefined,
  })}\n`
}

/** A service whose GET /log answers `page`, recording what it was asked. */
async function startLogService(
  page: unknown,
): Promise<{ readonly port: number; readonly seen: Seen[] }> {
  const seen: Seen[] = []
  const server = createServer((request, response) => {
    seen.push({
      url: request.url ?? '',
      authorization: request.headers.authorization,
    })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(page))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, seen }
}

async function run(
  page: unknown,
  args: LogArgs = {},
  token: ClientToken = NO_CLIENT_TOKEN,
): Promise<{ readonly code: number; readonly seen: Seen[] }> {
  const { port, seen } = await startLogService(page)
  const deps: LogDeps = {
    endpoint: toLocalEndpoint(port),
    token,
    print: (text) => out.push(text),
    printError: (text) => err.push(text),
  }
  return { code: await runLog(args, deps), seen }
}

function searchOf(seen: Seen | undefined): URLSearchParams {
  return new URL(seen?.url ?? '', 'http://localhost').searchParams
}

test("log reads GET /log with the bot's key", async () => {
  const { code, seen } = await run(
    { entries: [entry('a', '2026-10-19T06:00:00.000Z')], skippedCount: 0 },
    {},
    { kind: 'token', token: KEY, source: 'inbox' },
  )
  expect(code).toBe(0)
  expect(seen).toHaveLength(1)
  expect(seen[0]?.url.startsWith('/log')).toBe(true)
  expect(seen[0]?.authorization).toBe(`Bearer ${KEY}`)
  expect(out).toHaveLength(1)
  expect(out[0]).toContain('question a')
  expect(out.join('\n') + err.join('\n')).not.toContain(KEY)
})

test('prints the table in the order the service sent', async () => {
  const { code } = await run({
    entries: [entry('a', '2026-10-19T06:00:00.000Z'), entry('b', '2026-10-19T07:00:00.000Z')],
    skippedCount: 0,
  })
  expect(code).toBe(0)
  const lines = (out[0] ?? '').split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[0]).toContain('question a')
  expect(lines[1]).toContain('question b')
})

test('--json prints one entry per line', async () => {
  const { code } = await run(
    { entries: [entry('a', '2026-10-19T06:00:00.000Z')], skippedCount: 0 },
    { json: true },
  )
  expect(code).toBe(0)
  const entries = (out[0] ?? '').split('\n').map((line) => JSON.parse(line))
  expect(entries).toEqual([expect.objectContaining({ id: 'a', status: 'answered' })])
})

test('without --since asks for the last 20; with --since for all; explicit -n wins', async () => {
  const page = { entries: [], skippedCount: 0 }
  expect(searchOf((await run(page)).seen[0]).get('limit')).toBe('20')
  const since = new Date('2000-01-01')
  expect(searchOf((await run(page, { since })).seen[0]).has('limit')).toBe(false)
  expect(searchOf((await run(page, { since, limit: 3 })).seen[0]).get('limit')).toBe('3')
})

test('--since and --project go to the service as query fields', async () => {
  const page = { entries: [], skippedCount: 0 }
  const { seen } = await run(page, {
    since: new Date('2026-10-18T00:00:00Z'),
    project: 'web',
  })
  const search = searchOf(seen[0])
  expect(search.get('project')).toBe('web')
  expect(search.has('since')).toBe(true)
})

test('an empty log prints No questions logged. and exits 0', async () => {
  const { code } = await run({ entries: [], skippedCount: 0 })
  expect(code).toBe(0)
  expect(out).toEqual(['No questions logged.'])
})

test('filters that drop everything print No questions match.', async () => {
  const { code } = await run({ entries: [], skippedCount: 0 }, { project: 'nope' })
  expect(code).toBe(0)
  expect(out).toEqual(['No questions match.'])
})

test('skipped lines are reported on stderr after the output', async () => {
  const { code } = await run({
    entries: [entry('a', '2026-10-19T06:00:00.000Z')],
    skippedCount: 2,
  })
  expect(code).toBe(0)
  expect(out).toHaveLength(1)
  expect(err).toEqual(['skipped 2 unreadable log lines'])
})

test('a single unreadable line is reported in the singular', async () => {
  await run({ entries: [], skippedCount: 1 })
  expect(err).toEqual(['skipped 1 unreadable log line'])
})

test('--json with no entries keeps stdout empty and says so on stderr', async () => {
  expect((await run({ entries: [], skippedCount: 0 }, { json: true })).code).toBe(0)
  expect(out).toEqual([])
  expect(err).toEqual(['No questions logged.'])
})

test('an unusable key fails with its message and prints nothing', async () => {
  const { code, seen } = await run(
    { entries: [], skippedCount: 0 },
    {},
    { kind: 'unusable', message: 'bad key here' },
  )
  expect(code).toBe(1)
  expect(seen).toEqual([])
  expect(err).toEqual(['bad key here'])
  expect(out).toEqual([])
})

test('a service that is down exits 1 with the failure message', async () => {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  const code = await runLog(
    {},
    {
      endpoint: toLocalEndpoint(port),
      token: NO_CLIENT_TOKEN,
      print: (text) => out.push(text),
      printError: (text) => err.push(text),
    },
  )
  expect(code).toBe(1)
  expect(err).toHaveLength(1)
  expect(out).toEqual([])
})

/** Seeds the db next to `configPath` with the seed bot (b1) as the service would have. */
function seedRegistry(configPath: string): void {
  writeFileSync(configPath, JSON.stringify({ provider: 'fakepair', fakeKey: 'k', fakeOwner: 'u1' }))
  const loaded = loadSeed({ JAYPOST_CONFIG: configPath }, PAIRING_PROVIDERS)
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
}

/** Puts the jsonl `log` lines into bot 1's question rows, as the service would have written them. */
function saveQuestions(configPath: string, log: string): void {
  const database = openDatabase(resolveDatabasePath(configPath))
  try {
    for (const line of log.split('\n').filter(Boolean)) {
      const record = JSON.parse(line)
      database
        .prepare(
          "INSERT INTO questions (bot_id, id, asked_at, project, text, options, timeout_option, timeout_seconds, key_id, contact_id) VALUES ('b1', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          record.id,
          record.at,
          record.project ?? null,
          record.text,
          JSON.stringify(record.options),
          record.timeoutOption,
          record.timeoutSeconds,
          record.key ?? null,
          record.contact ?? null,
        )
    }
  } finally {
    database.close()
  }
}

test("audit dump prints the seed bot's lines, not other bots'", () => {
  const directory = join(tmp, 'data')
  mkdirSync(directory)
  const configPath = join(directory, 'config.json')
  seedRegistry(configPath)
  saveQuestions(configPath, asked('a', '2026-10-19T06:00:00.000Z'))
  const database = openDatabase(resolveDatabasePath(configPath))
  try {
    database
      .prepare(
        "INSERT INTO questions (bot_id, id, asked_at, text, options, timeout_option, timeout_seconds) VALUES ('b2', 'x', '2026-10-19T06:30:00.000Z', 'other', '[]', 'No', 1)",
      )
      .run()
  } finally {
    database.close()
  }
  const written: string[] = []
  expect(runAudit(['dump'], { JAYPOST_CONFIG: configPath }, (text) => written.push(text))).toBe(0)
  const lines = written.join('').split('\n').filter(Boolean)
  expect(lines.map((line) => JSON.parse(line).id)).toEqual(['a'])
})

function fakeTarget(name: TargetName, log: string | Error = ''): Mutable<Target> {
  return {
    name,
    readAuditLog: vi.fn(async () => {
      if (log instanceof Error) {
        throw log
      }
      return log
    }),
    readAdminKey: vi.fn(async () => `jpa_${'k'.repeat(43)}`),
  } as unknown as Mutable<Target>
}

/** Targets where systemd reads `log`; the others are never asked. */
function targetsWith(log: string | Error = '') {
  return {
    quadlet: fakeTarget('quadlet'),
    compose: fakeTarget('compose'),
    systemd: fakeTarget('systemd', log),
    launchd: fakeTarget('launchd'),
  }
}

function adminDeps(env: NodeJS.ProcessEnv, over: Partial<AdminLogDeps> = {}): AdminLogDeps {
  return {
    env,
    paths,
    targets: targetsWith(),
    providers: PAIRING_PROVIDERS,
    prompt: {
      confirm: async () => true,
      password: async () => '',
      text: async () => '',
      select: async (_message, _options, initialValue) => initialValue,
    },
    print: (text) => out.push(text),
    printError: (text) => err.push(text),
    fetchStatus: async () => UNREACHABLE_STATUS,
    now: () => NOW,
    inboxPath: join(tmp, 'inbox.json'),
    service: undefined,
    isInteractive: false,
    version: '1.0.0',
    ...over,
  }
}

/** A port nothing listens on. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

/** A systemd install on a port nothing answers, with targets reading `log`. */
async function stoppedInstall(log: string | Error, recordVersion = '1.0.0') {
  const targets = targetsWith(log)
  writeInstall(paths.installFile, {
    target: 'systemd',
    port: await freePort(),
    version: recordVersion,
  })
  return targets
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
    contact: 'c1',
  })}\n`
}

/** A real service whose seed bot b1 logged `a` (key k1) and `b` (key k2); b2 logged `c`. */
async function startWithQuestions(): Promise<NodeJS.ProcessEnv> {
  const directory = join(tmp, 'service')
  mkdirSync(directory)
  const configPath = join(directory, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({ provider: 'fakepair', fakeKey: 'seed-bot', fakeOwner: 'u1' }),
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
  saveQuestions(
    configPath,
    askedBy('a', '2026-10-19T06:00:00.000Z', 'k1') + askedBy('b', '2026-10-19T06:01:00.000Z', 'k2'),
  )
  const database = openDatabase(resolveDatabasePath(configPath))
  try {
    database
      .prepare(
        "INSERT INTO questions (bot_id, id, asked_at, text, options, timeout_option, timeout_seconds) VALUES ('b2', 'c', '2026-10-19T06:02:00.000Z', 'question c', '[\"Yes\"]', 'Yes', 1)",
      )
      .run()
  } finally {
    database.close()
  }
  return {
    HOME: tmp,
    JAYPOST_URL: `http://127.0.0.1:${port}`,
    JAYPOST_ADMIN_KEY: readFileSync(resolveAdminKeyPath(configPath), 'utf8').trim(),
  }
}

function printedIds(): readonly string[] {
  return (out[0] ?? '').split('\n').map((line) => JSON.parse(line).id)
}

test("admin log with no flag reads every bot's questions", async () => {
  const env = await startWithQuestions()
  expect(await runAdminLog({ json: true }, adminDeps(env))).toBe(0)
  expect((out[0] ?? '').split('\n').map((line) => JSON.parse(line))).toEqual([
    expect.objectContaining({ id: 'a', bot: 'b1', key: 'k1' }),
    expect.objectContaining({ id: 'b', bot: 'b1', key: 'k2' }),
    expect.objectContaining({ id: 'c', bot: 'b2' }),
  ])
  expect(err).toEqual([])
})

test('admin log --key narrows to that key', async () => {
  const env = await startWithQuestions()
  expect(await runAdminLog({ key: 'k2', json: true }, adminDeps(env))).toBe(0)
  expect(printedIds()).toEqual(['b'])
})

test('admin log --contact narrows to that contact', async () => {
  const env = await startWithQuestions()
  expect(await runAdminLog({ contact: 'c1', json: true }, adminDeps(env))).toBe(0)
  expect(printedIds()).toEqual(['a', 'b'])
})

test('admin log --contact of another contact prints nothing', async () => {
  const env = await startWithQuestions()
  expect(await runAdminLog({ contact: 'c9', json: true }, adminDeps(env))).toBe(0)
  expect(out.join('\n')).not.toMatch(/"id"/)
})

test('admin log with a rejected admin key exits 1', async () => {
  const env = await startWithQuestions()
  const deps = adminDeps({ ...env, JAYPOST_ADMIN_KEY: `jpa_${'z'.repeat(43)}` })
  expect(await runAdminLog({}, deps)).toBe(1)
  expect(err).toEqual([
    'jaypost service rejected the admin key; check JAYPOST_ADMIN_KEY, or the admin key file if the key was rotated',
  ])
  expect(out).toEqual([])
})

test("admin log falls back to the install's files when the local service doesn't answer", async () => {
  const targets = await stoppedInstall(askedBy('f', '2026-10-19T06:00:00.000Z', 'k1'))
  expect(await runAdminLog({}, adminDeps({ HOME: tmp }, { targets }))).toBe(0)
  expect(targets.systemd.readAuditLog).toHaveBeenCalled()
  expect(out).toHaveLength(1)
  expect(out[0]).toContain('question f')
  expect(err).toEqual([
    "the service didn't answer; showing the seed bot's questions from its files",
  ])
})

test('admin log from the files still applies --key', async () => {
  const targets = await stoppedInstall(
    askedBy('f', '2026-10-19T06:00:00.000Z', 'k1') + askedBy('g', '2026-10-19T06:01:00.000Z', 'k2'),
  )
  expect(await runAdminLog({ key: 'k2', json: true }, adminDeps({ HOME: tmp }, { targets }))).toBe(
    0,
  )
  expect(printedIds()).toEqual(['g'])
})

test('admin log --bot fails when only the files can be read', async () => {
  const targets = await stoppedInstall(askedBy('f', '2026-10-19T06:00:00.000Z', 'k1'))
  expect(await runAdminLog({ bot: 'b1' }, adminDeps({ HOME: tmp }, { targets }))).toBe(1)
  expect(err).toEqual([
    "the service didn't answer; --bot needs the service running, so start it or leave --bot out",
  ])
  expect(out).toEqual([])
  expect(targets.systemd.readAuditLog).not.toHaveBeenCalled()
})

test('admin log from the files reports a failing read', async () => {
  const targets = await stoppedInstall(new Error('boom'))
  expect(await runAdminLog({}, adminDeps({ HOME: tmp }, { targets }))).toBe(1)
  expect(err).toEqual([
    "the service didn't answer; showing the seed bot's questions from its files",
    'boom',
  ])
  expect(out).toEqual([])
})

test('admin log versions compare numerically: 0.10.0 and 1.0.0 are read, unparsable is too old', async () => {
  for (const recordVersion of ['0.10.0', '1.0.0']) {
    out = []
    const targets = await stoppedInstall(
      askedBy('a', '2026-10-19T06:00:00.000Z', 'k1'),
      recordVersion,
    )
    expect(await runAdminLog({}, adminDeps({ HOME: tmp }, { targets, version: '2.0.0' }))).toBe(0)
    expect(out[0]).toContain('question a')
  }
  err = []
  const targets = await stoppedInstall('', 'banana')
  expect(await runAdminLog({}, adminDeps({ HOME: tmp }, { targets, version: '2.0.0' }))).toBe(1)
  expect(err.at(-1)).toContain('(banana)')
})

test('admin log on legacy, 0.4.0 and 0.9.0 installs is too old and reads nothing', async () => {
  for (const recordVersion of ['0.4.0', '0.9.0', 'legacy']) {
    err = []
    const targets = await stoppedInstall('', recordVersion)
    expect(await runAdminLog({}, adminDeps({ HOME: tmp }, { targets }))).toBe(1)
    expect(err).toEqual([
      "the service didn't answer; showing the seed bot's questions from its files",
      `the installed service (${recordVersion}) keeps its log where this CLI can't read it; run jaypost service install to upgrade`,
    ])
    expect(targets.systemd.readAuditLog).not.toHaveBeenCalled()
  }
})

test('admin log on an install recorded with the running CLI version reads it below the minimum', async () => {
  const targets = await stoppedInstall(askedBy('a', '2026-10-19T06:00:00.000Z', 'k1'), '0.4.0')
  expect(await runAdminLog({}, adminDeps({ HOME: tmp }, { targets, version: '0.4.0' }))).toBe(0)
  expect(out[0]).toContain('question a')
})

test('admin log with no install and nothing answering reads the db next to the config', async () => {
  const directory = join(tmp, 'elsewhere')
  mkdirSync(directory)
  const configPath = join(directory, 'config.json')
  seedRegistry(configPath)
  saveQuestions(configPath, asked('a', '2026-10-19T06:00:00.000Z'))
  const env = { HOME: tmp, JAYPOST_CONFIG: configPath, JAYPOST_PORT: String(await freePort()) }
  expect(await runAdminLog({}, adminDeps(env))).toBe(0)
  expect(out[0]).toContain('question a')
  expect(err).toEqual([
    `no admin key in ${JSON.stringify(resolveAdminKeyPath(configPath))} yet; start the service once so it writes one; showing the seed bot's questions from its files`,
  ])
})
