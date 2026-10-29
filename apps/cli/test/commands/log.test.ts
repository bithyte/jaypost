import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vite-plus/test'
import {
  applySeed,
  createEmptyRegistry,
  loadSeed,
  NO_CLIENT_TOKEN,
  openDatabase,
  RegistryStore,
  resolveDatabasePath,
} from '@jaypost/store'
import type { ClientToken } from '@jaypost/store'
import { toLocalEndpoint } from '@jaypost/client'
import { createPairingFakeProvider } from '@jaypost/testing'
import { runAudit, runLog } from '../../src/commands/index.ts'
import type { LogArgs, LogDeps } from '../../src/commands/index.ts'

const NOW = new Date('2026-10-19T08:00:00Z')
const PAIRING_PROVIDERS = [createPairingFakeProvider()]
const KEY = 'jpk_'.padEnd(47, 'k')

type Seen = {
  readonly url: string
  readonly authorization: string | undefined
}

let tmp: string
let out: string[]
let err: string[]
const servers: Server[] = []

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'log-'))
  out = []
  err = []
})

afterEach(async () => {
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
    { kind: 'token', token: KEY, source: 'book' },
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
          "INSERT INTO questions (bot_id, id, asked_at, project, text, options, timeout_option, timeout_seconds, key_id, pairing_id) VALUES ('b1', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
          record.pairing ?? null,
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
