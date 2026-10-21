import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import { writeTokenFile } from '../../src/auth/index.ts'
import { runFinishUpdate, runUpdate } from '../../src/commands/index.ts'
import type { UpdateDeps } from '../../src/commands/index.ts'
import {
  formatLaunchdPlist,
  readInstall,
  resolveInstallPaths,
  writeInstall,
} from '../../src/install/index.ts'
import type {
  CliLocation,
  InstallOptions,
  InstallPaths,
  InstallRecord,
  Target,
  TargetName,
} from '../../src/install/index.ts'
import type { Exec, ExecOptions } from '../../src/system/index.ts'
import { telegramProvider } from '../../src/telegram/index.ts'
import { createFakeProvider } from '../provider/fake.ts'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }
type Call = readonly [string, readonly string[], ExecOptions | undefined]

const ASSET = 'jaypost-linux-x64.gz'
const NEW_BINARY = Buffer.from('#!/bin/sh\necho 0.5.0\n')
const OLD_BINARY = 'old binary'
const GZIPPED = gzipSync(NEW_BINARY)
const NODE = '/opt/node/bin/node'
const NPM_ROOT = '/usr/lib/node_modules'
const NPM_CLI = `${NPM_ROOT}/jaypost/dist/cli.js`
const TOKEN = 'T'.repeat(43)

let tmp: string
let paths: InstallPaths
let out: string[]
let calls: Call[]
let server: Server | undefined
let base: string
let holdAsset: boolean

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'update-'))
  paths = resolveInstallPaths({ HOME: tmp, XDG_CONFIG_HOME: join(tmp, 'cfg') })
  out = []
  calls = []
  holdAsset = false
  base = await serve({
    '/release': JSON.stringify({
      tag_name: 'v0.5.0',
      assets: ['SHA256SUMS', ASSET].map((name) => ({
        name,
        browser_download_url: `BASE/${name}`,
      })),
    }),
    '/release-without-asset': JSON.stringify({
      tag_name: 'v0.5.0',
      assets: [{ name: 'SHA256SUMS', browser_download_url: 'BASE/SHA256SUMS' }],
    }),
    '/npm': JSON.stringify({ version: '0.5.0' }),
    '/SHA256SUMS': `${createHash('sha256').update(GZIPPED).digest('hex')}  ${ASSET}\n`,
    [`/${ASSET}`]: GZIPPED,
  })
})

afterEach(() => {
  server?.closeAllConnections()
  server?.close()
  server = undefined
  rmSync(tmp, { recursive: true, force: true })
})

async function serve(files: Readonly<Record<string, Buffer | string>>): Promise<string> {
  const created = createServer((request, response) => {
    const url = request.url ?? ''
    if (url === `/${ASSET}` && holdAsset) {
      return
    }
    if (url === '/forbidden') {
      response.writeHead(403).end()
      return
    }
    const body = files[url]
    if (body === undefined) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200).end(typeof body === 'string' ? body.replaceAll('BASE', base) : body)
  })
  server = created
  await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(created.address() as AddressInfo).port}`
}

function fake(name: TargetName): Mutable<Target> {
  return {
    name,
    available: vi.fn(),
    install: vi.fn(),
    upgrade: vi.fn(
      async (options: InstallOptions, previous: InstallRecord): Promise<InstallRecord> => ({
        ...previous,
        version: options.version,
      }),
    ),
    readSecrets: vi.fn(async () => ({ provider: 'telegram', settings: { botToken: 'secret' } })),
    remove: vi.fn(),
    restart: vi.fn(),
    clearOwner: vi.fn(),
    isRunning: vi.fn(async () => true),
    logsHint: vi.fn(() => 'logs hint'),
  } as unknown as Mutable<Target>
}

/**
 * Fake exec: `--version` answers come from `versions`, `npm root -g` from NPM_ROOT. A successful
 * `npm i -g` makes every npm CLI report the installed version, unless `isNpmStale`.
 */
function createExec(
  versions: Readonly<Record<string, string>> = {},
  codes: { readonly npm?: number; readonly handoff?: number; readonly isNpmStale?: boolean } = {},
  onCall: (command: string, args: readonly string[]) => void = () => {},
): Exec {
  let installed: string | undefined
  return async (command, args, options) => {
    calls.push([command, args, options])
    onCall(command, args)
    if (command === 'npm' && args[0] === 'root') {
      return { code: 0, stdout: `${NPM_ROOT}\n`, stderr: '' }
    }
    if (command === 'npm') {
      const code = codes.npm ?? 0
      if (code === 0 && !codes.isNpmStale) {
        installed = args.at(-1)?.split('@')[1]
      }
      return { code, stdout: '', stderr: 'npm broke' }
    }
    if (args.includes('--finish')) {
      return { code: codes.handoff ?? 0, stdout: '', stderr: '' }
    }
    if (command.endsWith('.tmp')) {
      return { code: 0, stdout: '0.5.0\n', stderr: '' }
    }
    const key = args[0] === '--version' ? command : (args[0] ?? command)
    const version = command === NODE && installed !== undefined ? installed : versions[key]
    return version === undefined
      ? { code: 1, stdout: '', stderr: 'no' }
      : { code: 0, stdout: `${version}\n`, stderr: '' }
  }
}

function deps(over: Partial<UpdateDeps> = {}): UpdateDeps {
  const targets = {
    systemd: fake('systemd'),
    quadlet: fake('quadlet'),
    compose: fake('compose'),
    launchd: fake('launchd'),
  }
  return {
    targets,
    paths,
    providers: [telegramProvider, createFakeProvider()],
    exec: createExec(),
    cli: { kind: 'binary', binaryPath: join(tmp, 'running') },
    version: '0.4.0',
    platform: 'linux',
    arch: 'x64',
    releasesUrl: `${base}/release`,
    npmLatestUrl: `${base}/npm`,
    print: (text: string) => out.push(text),
    env: { HOME: tmp, XDG_CONFIG_HOME: join(tmp, 'cfg') },
    ...over,
  }
}

function seedBinary(): string {
  const copy = paths.binaryCopy
  mkdirSync(dirname(copy), { recursive: true })
  writeFileSync(copy, OLD_BINARY)
  writeInstall(paths.installFile, {
    target: 'systemd',
    port: 9000,
    version: '0.4.0',
    cliPath: copy,
    cliKind: 'binary',
  })
  return copy
}

function writeUnit(words: readonly string[]): void {
  mkdirSync(dirname(paths.systemdUnit), { recursive: true })
  writeFileSync(
    paths.systemdUnit,
    `[Service]\nExecStart=${words.map((word) => `"${word}"`).join(' ')} start\n`,
  )
}

function seedNpm(cliPath = NPM_CLI): void {
  writeUnit([NODE, cliPath])
  writeInstall(paths.installFile, {
    target: 'systemd',
    port: 9000,
    version: '0.4.0',
    cliPath,
    cliKind: 'npm',
  })
}

function npmCli(selfPath: string): CliLocation {
  return { kind: 'npm', selfPath, nodePath: NODE }
}

function lastCall(): Call | undefined {
  return calls.at(-1)
}

test('already current exits 0 without touching anything', async () => {
  seedNpm()
  writeInstall(paths.installFile, { target: 'systemd', port: 9000, version: '0.5.0' })
  const d = deps()
  expect(await runUpdate(d)).toBe(0)
  expect(out).toEqual(['Already on 0.5.0.'])
  expect(calls.filter(([command]) => command === 'npm')).toEqual([])
  expect(calls.filter(([, args]) => args.includes('--finish'))).toEqual([])
  expect(d.targets.systemd.upgrade).not.toHaveBeenCalled()
})

test('binary systemd install swaps the copy then hands off to it', async () => {
  const copy = seedBinary()
  const d = deps({ exec: createExec({ [copy]: '0.4.0' }) })
  expect(await runUpdate(d)).toBe(0)
  expect(readFileSync(copy)).toEqual(NEW_BINARY)
  expect(lastCall()).toEqual([copy, ['update', '--finish'], { inherit: true }])
  expect(out).toEqual([])
})

test('npm systemd install runs npm i -g then hands off with the unit node', async () => {
  seedNpm()
  const d = deps({ exec: createExec({ [NPM_CLI]: '0.4.0' }) })
  expect(await runUpdate(d)).toBe(0)
  expect(calls.map(([command, args]) => [command, args])).toContainEqual([
    'npm',
    ['i', '-g', 'jaypost@0.5.0'],
  ])
  expect(lastCall()).toEqual([NODE, [NPM_CLI, 'update', '--finish'], { inherit: true }])
})

function seedLaunchd(cliKind: 'npm' | 'binary', cliPath: string): void {
  mkdirSync(dirname(paths.launchdPlist), { recursive: true })
  writeFileSync(
    paths.launchdPlist,
    formatLaunchdPlist({
      label: 'ask.telegram',
      exec: cliKind === 'npm' ? [NODE, cliPath] : [cliPath],
      config: join(tmp, 'config.json'),
      logFile: paths.launchdLogFile,
    }),
  )
  writeInstall(paths.installFile, {
    target: 'launchd',
    port: 9000,
    version: '0.4.0',
    cliPath,
    cliKind,
  })
}

test('launchd npm install updates the package the plist runs', async () => {
  seedLaunchd('npm', NPM_CLI)
  const d = deps({ exec: createExec({ [NPM_CLI]: '0.4.0' }) })
  expect(await runUpdate(d)).toBe(0)
  expect(calls.map(([command, args]) => [command, args])).toContainEqual([
    'npm',
    ['i', '-g', 'jaypost@0.5.0'],
  ])
  expect(lastCall()).toEqual([NODE, [NPM_CLI, 'update', '--finish'], { inherit: true }])
})

test('launchd binary install replaces the recorded copy', async () => {
  const copy = paths.binaryCopy
  mkdirSync(dirname(copy), { recursive: true })
  writeFileSync(copy, OLD_BINARY)
  seedLaunchd('binary', copy)
  const d = deps({ exec: createExec({ [copy]: '0.4.0' }) })
  expect(await runUpdate(d)).toBe(0)
  expect(readFileSync(copy)).toEqual(NEW_BINARY)
  expect(lastCall()).toEqual([copy, ['update', '--finish'], { inherit: true }])
})

test('npm install under the fallback prefix passes --prefix', async () => {
  const cliPath = join(paths.userNpmPrefix, 'lib', 'node_modules', 'jaypost', 'dist', 'cli.js')
  seedNpm(cliPath)
  const d = deps({ exec: createExec({ [cliPath]: '0.4.0' }) })
  expect(await runUpdate(d)).toBe(0)
  expect(calls.map(([command, args]) => [command, args])).toContainEqual([
    'npm',
    ['i', '-g', '--prefix', paths.userNpmPrefix, 'jaypost@0.5.0'],
  ])
  expect(lastCall()).toEqual([NODE, [cliPath, 'update', '--finish'], { inherit: true }])
})

test('legacy install takes cliPath and node from the unit', async () => {
  writeUnit([NODE, NPM_CLI])
  const d = deps({ exec: createExec({ [NPM_CLI]: '0.1.0' }) })
  expect(await runUpdate(d)).toBe(0)
  expect(calls.map(([command, args]) => [command, args])).toContainEqual([
    'npm',
    ['i', '-g', 'jaypost@0.5.0'],
  ])
  expect(lastCall()).toEqual([NODE, [NPM_CLI, 'update', '--finish'], { inherit: true }])
})

test('npm install that already reports the latest skips npm and hands off', async () => {
  seedNpm()
  const d = deps({ exec: createExec({ [NPM_CLI]: '0.5.0' }) })
  expect(await runUpdate(d)).toBe(0)
  expect(calls.filter(([command]) => command === 'npm')).toEqual([])
  expect(lastCall()).toEqual([NODE, [NPM_CLI, 'update', '--finish'], { inherit: true }])
})

test('npm failure exits 1 without handing off', async () => {
  seedNpm()
  const d = deps({ exec: createExec({ [NPM_CLI]: '0.4.0' }, { npm: 1 }) })
  expect(await runUpdate(d)).toBe(1)
  expect(out).toEqual(['Update failed: npm install failed: npm broke'])
  expect(calls.filter(([, args]) => args.includes('--finish'))).toEqual([])
})

test('npm install that leaves the CLI on the old version exits 1 without handing off', async () => {
  seedNpm()
  const d = deps({ exec: createExec({ [NPM_CLI]: '0.4.0' }, { isNpmStale: true }) })
  expect(await runUpdate(d)).toBe(1)
  expect(out).toEqual([
    `Update failed: npm installed jaypost@0.5.0 but ${NPM_CLI} still reports another version`,
  ])
  expect(calls.filter(([, args]) => args.includes('--finish'))).toEqual([])
  expect(d.targets.systemd.upgrade).not.toHaveBeenCalled()
})

test('interrupt after npm install exits 130 without handing off', async () => {
  seedNpm()
  const controller = new AbortController()
  const exec = createExec({ [NPM_CLI]: '0.4.0' }, {}, (command, args) => {
    if (command === 'npm' && args[0] === 'i') {
      controller.abort()
    }
  })
  const d = deps({ exec, signal: controller.signal })
  expect(await runUpdate(d)).toBe(130)
  expect(calls.filter(([, args]) => args.includes('--finish'))).toEqual([])
  expect(d.targets.systemd.upgrade).not.toHaveBeenCalled()
})

test('missing asset exits 1 and leaves the copy', async () => {
  const copy = seedBinary()
  const d = deps({
    exec: createExec({ [copy]: '0.4.0' }),
    releasesUrl: `${base}/release-without-asset`,
  })
  expect(await runUpdate(d)).toBe(1)
  expect(out).toEqual([`Update failed: no ${ASSET} on release 0.5.0 yet`])
  expect(readFileSync(copy, 'utf8')).toBe(OLD_BINARY)
  expect(readdirSync(dirname(copy))).toEqual(['jaypost'])
  expect(calls.filter(([, args]) => args.includes('--finish'))).toEqual([])
})

test('github 403 exits 1 with one line and changes nothing', async () => {
  const copy = seedBinary()
  const d = deps({ exec: createExec({ [copy]: '0.4.0' }), releasesUrl: `${base}/forbidden` })
  expect(await runUpdate(d)).toBe(1)
  expect(out).toEqual(['Update failed: GitHub release lookup failed: HTTP 403'])
  expect(readFileSync(copy, 'utf8')).toBe(OLD_BINARY)
  expect(calls).toEqual([])
})

test('unsupported platform names the platform', async () => {
  const copy = seedBinary()
  const d = deps({ exec: createExec({ [copy]: '0.4.0' }), platform: 'win32' })
  expect(await runUpdate(d)).toBe(1)
  expect(out).toEqual(['Update failed: no binary for win32-x64'])
  expect(readFileSync(copy, 'utf8')).toBe(OLD_BINARY)
})

test('container install with an old npx CLI asks for npx jaypost@latest', async () => {
  writeInstall(paths.installFile, { target: 'quadlet', port: 9000, version: '0.4.0' })
  const d = deps({ cli: npmCli('/home/u/.npm/_npx/abc/node_modules/jaypost/dist/cli.js') })
  expect(await runUpdate(d)).toBe(1)
  expect(out).toEqual([
    `Can't update this copy; run "npx jaypost@latest update" or download the latest binary.`,
  ])
  expect(d.targets.quadlet.upgrade).not.toHaveBeenCalled()
  expect(calls.filter(([command, args]) => command === 'npm' && args[0] === 'i')).toEqual([])
})

test('container install already on the latest CLI finishes in-process', async () => {
  writeInstall(paths.installFile, { target: 'compose', port: 9000, version: '0.4.0' })
  writeTokenFile(paths.tokenFile, TOKEN)
  const d = deps({
    cli: npmCli('/home/u/.npm/_npx/abc/node_modules/jaypost/dist/cli.js'),
    version: '0.5.0',
  })
  expect(await runUpdate(d)).toBe(0)
  expect(d.targets.compose.upgrade).toHaveBeenCalledWith(
    expect.objectContaining({ version: '0.5.0', port: 9000 }),
    expect.objectContaining({ version: '0.4.0' }),
  )
  expect(readInstall(paths.installFile)?.version).toBe('0.5.0')
  expect(out).toEqual(['Updated jaypost 0.4.0 -> 0.5.0.'])
  expect(calls.filter(([, args]) => args.includes('--finish'))).toEqual([])
})

test('container install with a global npm CLI runs npm i -g then hands off', async () => {
  writeInstall(paths.installFile, { target: 'quadlet', port: 9000, version: '0.4.0' })
  const d = deps({ cli: npmCli(NPM_CLI) })
  expect(await runUpdate(d)).toBe(0)
  expect(calls.map(([command, args]) => [command, args])).toContainEqual([
    'npm',
    ['i', '-g', 'jaypost@0.5.0'],
  ])
  expect(lastCall()).toEqual([NODE, [NPM_CLI, 'update', '--finish'], { inherit: true }])
})

test('nothing installed updates the running binary only', async () => {
  const running = join(tmp, 'running')
  writeFileSync(running, OLD_BINARY)
  const d = deps()
  expect(await runUpdate(d)).toBe(0)
  expect(readFileSync(running)).toEqual(NEW_BINARY)
  expect(out).toEqual(['Updated jaypost 0.4.0 -> 0.5.0.'])
  expect(calls.filter(([, args]) => args.includes('--finish'))).toEqual([])
})

test('failed handoff prints the retry hint', async () => {
  const copy = seedBinary()
  const d = deps({ exec: createExec({ [copy]: '0.4.0' }, { handoff: 1 }) })
  expect(await runUpdate(d)).toBe(1)
  expect(out).toEqual([
    'The new version is in place; run "jaypost update" again or "jaypost init".',
  ])
})

test('interrupt during download exits 130', async () => {
  const copy = seedBinary()
  holdAsset = true
  const controller = new AbortController()
  const d = deps({ exec: createExec({ [copy]: '0.4.0' }), signal: controller.signal })
  setTimeout(() => controller.abort(), 100)
  expect(await runUpdate(d)).toBe(130)
  expect(readFileSync(copy, 'utf8')).toBe(OLD_BINARY)
  expect(readdirSync(dirname(copy))).toEqual(['jaypost'])
  expect(calls.filter(([, args]) => args.includes('--finish'))).toEqual([])
})

test('runFinishUpdate upgrades with the saved secrets and token', async () => {
  writeInstall(paths.installFile, {
    target: 'quadlet',
    port: 9123,
    version: '0.4.0',
    provider: 'telegram',
  })
  writeTokenFile(paths.tokenFile, TOKEN)
  const d = deps({ version: '0.5.0', timeZone: 'Europe/Paris' })
  expect(await runFinishUpdate(d)).toBe(0)
  const [options, previous] = vi.mocked(d.targets.quadlet.upgrade).mock.calls[0] ?? []
  expect(options).toMatchObject({
    version: '0.5.0',
    port: 9123,
    provider: telegramProvider,
    settings: { botToken: 'secret' },
    auth: { kind: 'token', token: TOKEN },
    timeZone: 'Europe/Paris',
  })
  expect(previous).toMatchObject({ version: '0.4.0' })
  expect(readInstall(paths.installFile)).toEqual({
    target: 'quadlet',
    port: 9123,
    version: '0.5.0',
    provider: 'telegram',
  })
  expect(out).toEqual(['Updated jaypost 0.4.0 -> 0.5.0.'])
})

test('runFinishUpdate without a token file warns and installs without auth', async () => {
  writeInstall(paths.installFile, { target: 'compose', port: 9000, version: '0.4.0' })
  const d = deps({ version: '0.5.0' })
  expect(await runFinishUpdate(d)).toBe(0)
  expect(vi.mocked(d.targets.compose.upgrade).mock.calls[0]?.[0]).toMatchObject({
    auth: { kind: 'none' },
  })
  expect(out).toEqual([
    `No API token file at ${paths.tokenFile}; the service will not require an API token. Run "jaypost init" to set one.`,
    'Updated jaypost 0.4.0 -> 0.5.0.',
  ])
})

test('runFinishUpdate failure keeps install.json and exits 1', async () => {
  writeInstall(paths.installFile, { target: 'compose', port: 9000, version: '0.4.0' })
  writeTokenFile(paths.tokenFile, TOKEN)
  const d = deps({ version: '0.5.0' })
  vi.mocked(d.targets.compose.upgrade).mockRejectedValue(new Error('build failed'))
  expect(await runFinishUpdate(d)).toBe(1)
  expect(out).toEqual(['Update failed: build failed'])
  expect(readInstall(paths.installFile)?.version).toBe('0.4.0')
})

test('runFinishUpdate with nothing installed exits 1', async () => {
  expect(await runFinishUpdate(deps({ version: '0.5.0' }))).toBe(1)
  expect(out).toEqual(['Not installed.'])
})
