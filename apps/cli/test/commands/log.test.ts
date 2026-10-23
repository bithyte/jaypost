import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test, vi } from 'vite-plus/test'
import { runLog } from '../../src/commands/index.ts'
import type { LogArgs, LogDeps } from '../../src/commands/index.ts'
import { resolveInstallPaths, writeInstall } from '@jaypost/install'
import type { InstallPaths, Target, TargetName } from '@jaypost/install'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const NOW = new Date('2026-10-19T08:00:00Z')

let tmp: string
let paths: InstallPaths
let out: string[]
let err: string[]

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'log-'))
  paths = resolveInstallPaths({ HOME: tmp, XDG_CONFIG_HOME: join(tmp, 'cfg') })
  out = []
  err = []
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
