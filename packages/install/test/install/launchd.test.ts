import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, expect, test, vi } from 'vite-plus/test'
import {
  createEmptyRegistry,
  MissingCommandError,
  NO_AUTH,
  openDatabase,
  RegistryStore,
  resolveDatabasePath,
} from '@jaypost/store'
import {
  createLaunchdTarget,
  findPlistExecWords,
  formatLaunchdPlist,
  resolveInstallPaths,
  resolveStableNodePath,
} from '../../src/install/index.ts'
import type { Exec } from '@jaypost/store'
import { telegramProvider } from '@jaypost/providers'
import { createFakeProvider } from '@jaypost/testing'

const LABEL = 'io.github.bithyte.jaypost'
const SERVICE = `gui/501/${LABEL}`

let tmp: string
let calls: [string, readonly string[]][]
let domainCode: number
let serviceCode: number
let serviceStdout: string
let bootoutCode: number
let bootoutStderr: string
let bootstrapCode: number
let kickstartCode: number
let xattr: 'ok' | 'fail' | 'missing'
let isLaunchctlMissing: boolean

const fakeExec: Exec = async (cmd, args) => {
  calls.push([cmd, args])
  if (cmd === 'npm' && args[0] === 'prefix') {
    return { code: 0, stdout: '/usr\n', stderr: '' }
  }
  if (cmd === 'npm' && args[0] === 'root') {
    return { code: 0, stdout: '/usr/lib/node_modules\n', stderr: '' }
  }
  if (cmd === 'xattr') {
    if (xattr === 'missing') {
      throw new MissingCommandError('xattr')
    }
    return xattr === 'fail'
      ? { code: 1, stdout: '', stderr: 'No such xattr: com.apple.quarantine' }
      : { code: 0, stdout: '', stderr: '' }
  }
  if (cmd !== 'launchctl') {
    return { code: 0, stdout: '', stderr: '' }
  }
  if (isLaunchctlMissing) {
    throw new MissingCommandError('launchctl')
  }
  if (args[0] === 'print' && args[1] === 'gui/501') {
    return { code: domainCode, stdout: '', stderr: '' }
  }
  if (args[0] === 'print' && args[1] === SERVICE) {
    return { code: serviceCode, stdout: serviceStdout, stderr: '' }
  }
  if (args[0] === 'bootout') {
    return { code: bootoutCode, stdout: '', stderr: bootoutStderr }
  }
  if (args[0] === 'bootstrap') {
    return {
      code: bootstrapCode,
      stdout: '',
      stderr: bootstrapCode === 0 ? '' : 'nope',
    }
  }
  if (args[0] === 'kickstart') {
    return { code: kickstartCode, stdout: '', stderr: '' }
  }
  return { code: 0, stdout: '', stderr: '' }
}

function launchctlCalls(): (readonly string[])[] {
  return calls.filter(([c]) => c === 'launchctl').map(([, a]) => a)
}

function make(
  env: NodeJS.ProcessEnv = {},
  nodePath = '/usr/bin/node',
  platform = 'darwin',
  exec: Exec = fakeExec,
) {
  const e = { HOME: tmp, ...env }
  const paths = resolveInstallPaths(e)
  const t = createLaunchdTarget(
    {
      exec,
      paths,
      env: e,
      user: 'me',
      providers: [telegramProvider, createFakeProvider()],
      platform,
      uid: 501,
    },
    { kind: 'npm', selfPath: '/src/dist/cli.js', nodePath },
  )
  return { t, paths }
}

function makeBinary(env: NodeJS.ProcessEnv = {}) {
  const binaryPath = join(tmp, 'dl', 'jaypost')
  if (!existsSync(binaryPath)) {
    mkdirSync(dirname(binaryPath), { recursive: true })
    writeFileSync(binaryPath, 'binary v2')
  }
  const e = { HOME: tmp, PATH: '/usr/bin', ...env }
  const paths = resolveInstallPaths(e)
  const t = createLaunchdTarget(
    {
      exec: fakeExec,
      paths,
      env: e,
      user: 'me',
      providers: [telegramProvider, createFakeProvider()],
      platform: 'darwin',
      uid: 501,
    },
    { kind: 'binary', binaryPath },
  )
  return { t, paths, binaryPath }
}

const base = {
  version: '0.1.0',
  port: 8787,
  provider: telegramProvider,
  settings: { botToken: 't' },
  auth: NO_AUTH,
  print: () => {},
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ld-')))
  calls = []
  domainCode = 0
  serviceCode = 0
  serviceStdout = `${SERVICE} = {\n\tstate = running\n\tpid = 123\n}\n`
  bootoutCode = 0
  bootoutStderr = ''
  bootstrapCode = 0
  kickstartCode = 0
  xattr = 'ok'
  isLaunchctlMissing = false
})

test('install from the binary writes the plist, copies, clears quarantine and bootstraps', async () => {
  const { t, paths } = makeBinary()
  const rec = await t.install(base)
  expect(paths.launchdPlist).toBe(join(tmp, 'Library', 'LaunchAgents', `${LABEL}.plist`))
  expect(paths.launchdLogFile).toBe(join(tmp, 'Library', 'Logs', 'jaypost', 'jaypost.log'))
  expect(readFileSync(paths.launchdPlist, 'utf8')).toBe(
    formatLaunchdPlist({
      label: LABEL,
      exec: [paths.binaryCopy],
      config: paths.configFile,
      logFile: paths.launchdLogFile,
    }),
  )
  expect(readFileSync(paths.binaryCopy, 'utf8')).toBe('binary v2')
  expect(calls).toContainEqual(['xattr', ['-d', 'com.apple.quarantine', paths.binaryCopy]])
  expect(launchctlCalls()).toEqual([
    ['bootout', SERVICE],
    ['enable', SERVICE],
    ['bootstrap', 'gui/501', paths.launchdPlist],
  ])
  expect(existsSync(dirname(paths.launchdLogFile))).toBe(true)
  expect(rec).toEqual({
    target: 'launchd',
    provider: 'telegram',
    port: 8787,
    version: '0.1.0',
    cliKind: 'binary',
    cliPath: paths.binaryCopy,
    configFile: paths.configFile,
  })
})

test('install from npm runs node with the cli script', async () => {
  const { t, paths } = make()
  const rec = await t.install(base)
  expect(findPlistExecWords(readFileSync(paths.launchdPlist, 'utf8'))).toEqual([
    '/usr/bin/node',
    rec.cliPath,
  ])
  expect(rec).toMatchObject({
    target: 'launchd',
    cliKind: 'npm',
    configFile: paths.configFile,
  })
  expect(calls.some(([c]) => c === 'xattr')).toBe(false)
})

test('install uses the stable Homebrew opt node path', async () => {
  const cellarNode = join(tmp, 'brew', 'Cellar', 'node', '24.1.0', 'bin', 'node')
  mkdirSync(dirname(cellarNode), { recursive: true })
  writeFileSync(cellarNode, 'node')
  mkdirSync(join(tmp, 'brew', 'opt'))
  symlinkSync('../Cellar/node/24.1.0', join(tmp, 'brew', 'opt', 'node'))
  const { t, paths } = make({}, cellarNode)
  await t.install(base)
  const words = findPlistExecWords(readFileSync(paths.launchdPlist, 'utf8'))
  expect(words?.[0]).toBe(join(tmp, 'brew', 'opt', 'node', 'bin', 'node'))
})

test('resolveStableNodePath keeps execPath when opt is missing or points elsewhere', () => {
  const cellarNode = join(tmp, 'brew', 'Cellar', 'node', '24.1.0', 'bin', 'node')
  const otherNode = join(tmp, 'brew', 'Cellar', 'node', '24.2.0', 'bin', 'node')
  for (const file of [cellarNode, otherNode]) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'node')
  }
  expect(resolveStableNodePath(cellarNode)).toBe(cellarNode)
  mkdirSync(join(tmp, 'brew', 'opt'))
  symlinkSync('../Cellar/node/24.2.0', join(tmp, 'brew', 'opt', 'node'))
  expect(resolveStableNodePath(cellarNode)).toBe(cellarNode)
  expect(resolveStableNodePath(otherNode)).toBe(join(tmp, 'brew', 'opt', 'node', 'bin', 'node'))
  expect(resolveStableNodePath('/usr/local/bin/node')).toBe('/usr/local/bin/node')
})

test("install ignores a bootout of an agent that isn't loaded", async () => {
  bootoutCode = 3
  bootoutStderr = 'Boot-out failed: 3: No such process\n'
  const { t, paths } = make()
  await t.install(base)
  expect(launchctlCalls()).toContainEqual(['bootstrap', 'gui/501', paths.launchdPlist])
})

test('install throws when bootout fails for another reason', async () => {
  bootoutCode = 5
  bootoutStderr = 'boom\n'
  const { t } = make()
  await expect(t.install(base)).rejects.toThrow('launchctl bootout failed: boom')
  expect(launchctlCalls().some(([command]) => command === 'bootstrap')).toBe(false)
})

test('install throws when bootstrap fails', async () => {
  bootstrapCode = 5
  const { t } = make()
  await expect(t.install(base)).rejects.toThrow('launchctl bootstrap failed:')
})

test("xattr failing or missing doesn't fail a binary install", async () => {
  xattr = 'fail'
  const { t } = makeBinary()
  await expect(t.install(base)).resolves.toMatchObject({ target: 'launchd' })
  xattr = 'missing'
  await expect(t.install(base)).resolves.toMatchObject({ target: 'launchd' })
})

test('upgrade with an unchanged plist kickstarts', async () => {
  const { t } = make()
  const previous = await t.install(base)
  calls = []
  const record = await t.upgrade(base, previous)
  expect(record).toEqual(previous)
  expect(launchctlCalls()).toEqual([
    ['print', SERVICE],
    ['kickstart', '-k', SERVICE],
  ])
})

test('upgrade with a changed plist reloads', async () => {
  const { t, paths } = make()
  const previous = await t.install(base)
  writeFileSync(paths.launchdPlist, '<plist>stale</plist>\n')
  calls = []
  await t.upgrade({ ...base, version: '0.2.0' }, previous)
  expect(launchctlCalls()).toEqual([
    ['bootout', SERVICE],
    ['enable', SERVICE],
    ['bootstrap', 'gui/501', paths.launchdPlist],
  ])
  expect(readFileSync(paths.launchdPlist, 'utf8')).toContain('<string>/usr/bin/node</string>')
})

test('upgrade with an unchanged plist but an unloaded agent bootstraps', async () => {
  const { t, paths } = make()
  const previous = await t.install(base)
  serviceCode = 113
  calls = []
  await t.upgrade(base, previous)
  const ctl = launchctlCalls()
  expect(ctl).toContainEqual(['bootstrap', 'gui/501', paths.launchdPlist])
  expect(ctl.some(([command]) => command === 'kickstart')).toBe(false)
})

test('isRunning is true with a pid, including while spawning', async () => {
  const { t } = make()
  expect(await t.isRunning({} as never)).toBe(true)
  expect(calls).toContainEqual(['launchctl', ['print', SERVICE]])
  serviceStdout = `${SERVICE} = {\n\tstate = xpcproxy\n\tpid = 9\n}\n`
  expect(await t.isRunning({} as never)).toBe(true)
  serviceStdout = `${SERVICE} = {\n\tstate = not running\n}\n`
  expect(await t.isRunning({} as never)).toBe(false)
  serviceStdout = `${SERVICE} = {\n\tstate = not running\n\tendpoints = {\n\t\tpid = 4\n\t}\n}\n`
  expect(await t.isRunning({} as never)).toBe(false)
  serviceStdout = `${SERVICE} = {\n\tpid = 123\n}\n`
  serviceCode = 113
  expect(await t.isRunning({} as never)).toBe(false)
})

test('restart throws on a non-zero exit', async () => {
  const { t } = make()
  await t.restart({} as never)
  expect(launchctlCalls()).toEqual([['kickstart', '-k', SERVICE]])
  kickstartCode = 113
  await expect(t.restart({} as never)).rejects.toThrow('launchctl kickstart failed (exit 113)')
})

test('remove boots out and deletes the plist; purge deletes config, state and the binary copy, keeps logs', async () => {
  const { t, paths } = makeBinary()
  const rec = await t.install(base)
  const stateFile = resolveDatabasePath(paths.configFile)
  writeFileSync(stateFile, 'db')
  writeFileSync(paths.launchdLogFile, 'log\n')
  calls = []
  await t.remove(rec, false)
  expect(launchctlCalls()).toEqual([['bootout', SERVICE]])
  expect(existsSync(paths.launchdPlist)).toBe(false)
  expect(existsSync(paths.configFile)).toBe(true)
  expect(existsSync(paths.binaryCopy)).toBe(true)
  bootoutCode = 3
  bootoutStderr = 'Boot-out failed: 3: No such process\n'
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  await t.remove(rec, true)
  log.mockRestore()
  expect(existsSync(paths.configFile)).toBe(false)
  expect(existsSync(stateFile)).toBe(false)
  expect(existsSync(paths.binaryCopy)).toBe(false)
  expect(existsSync(paths.launchdLogFile)).toBe(true)
})

test('purge also removes the db with its wal and shm, and the admin key', async () => {
  const { t, paths } = makeBinary()
  const rec = await t.install(base)
  const directory = dirname(paths.configFile)
  const databasePath = resolveDatabasePath(paths.configFile)
  writeFileSync(databasePath, 'db')
  writeFileSync(`${databasePath}-wal`, 'wal')
  writeFileSync(`${databasePath}-shm`, 'shm')
  writeFileSync(join(directory, 'admin-key'), 'key\n')
  bootoutCode = 3
  bootoutStderr = 'Boot-out failed: 3: No such process\n'
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  await t.remove(rec, true)
  log.mockRestore()
  expect(
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, join(directory, 'admin-key')].map(
      (file) => existsSync(file),
    ),
  ).toEqual([false, false, false, false])
})

test('remove keeps the plist when bootout fails', async () => {
  const { t, paths } = make()
  const rec = await t.install(base)
  bootoutCode = 5
  bootoutStderr = 'boom\n'
  await expect(t.remove(rec, true)).rejects.toThrow('launchctl bootout failed: boom')
  expect(existsSync(paths.launchdPlist)).toBe(true)
  expect(existsSync(paths.configFile)).toBe(true)
})

test('readSecrets, clearOwner and readAuditLog use the recorded configFile', async () => {
  const recorded = join(tmp, 'recorded.json')
  writeFileSync(recorded, JSON.stringify({ botToken: 'rt', ownerId: 5 }))
  const database = openDatabase(resolveDatabasePath(recorded))
  try {
    new RegistryStore(database).save({
      ...createEmptyRegistry(),
      lastIds: { bot: 1, pairing: 1, key: 1 },
      seed: { fingerprint: 'f', botId: 'b1', pairingId: 'p1', keyId: 'k1', isOpen: false },
    })
    database
      .prepare(
        "INSERT INTO questions (bot_id, id, asked_at, text, options, timeout_option, timeout_seconds) VALUES ('b1', 'mine', '2026-10-19T06:00:00.000Z', 'q', '[]', 'No', 1)",
      )
      .run()
  } finally {
    database.close()
  }
  const { t } = make({ JAYPOST_CONFIG: join(tmp, 'other.json') })
  const rec = {
    target: 'launchd' as const,
    port: 1,
    version: 'v',
    configFile: recorded,
  }
  expect(await t.readSecrets(rec)).toEqual({
    provider: 'telegram',
    settings: { botToken: 'rt', ownerId: 5 },
  })
  await t.clearOwner(rec)
  expect(JSON.parse(readFileSync(recorded, 'utf8'))).toEqual({
    botToken: 'rt',
  })
  expect(JSON.parse(await t.readAuditLog(rec))).toMatchObject({ id: 'mine' })
})

test('available on darwin with a desktop session', async () => {
  const { t } = make()
  expect(await t.available()).toEqual({ ok: true })
  expect(launchctlCalls()).toEqual([['print', 'gui/501']])
})

test('available on linux says macOS only', async () => {
  const { t } = make({}, '/usr/bin/node', 'linux')
  expect(await t.available()).toEqual({
    ok: false,
    reason: 'launchd is macOS only',
  })
  expect(calls).toEqual([])
})

test('available without a desktop session', async () => {
  domainCode = 113
  const { t } = make()
  expect(await t.available()).toEqual({
    ok: false,
    reason: 'no desktop session; log in on the Mac first',
  })
  isLaunchctlMissing = true
  expect(await t.available()).toEqual({
    ok: false,
    reason: 'launchctl not available',
  })
})

test('available reports a symlink at the binary copy', async () => {
  const { t, paths } = makeBinary()
  mkdirSync(dirname(paths.binaryCopy), { recursive: true })
  symlinkSync('../lib/node_modules/jaypost/dist/cli.js', paths.binaryCopy)
  expect(await t.available()).toEqual({
    ok: false,
    reason: '~/.local/bin/jaypost is a symlink (npm\'s launcher?); run "npm rm -g jaypost" first',
  })
})

test('logsHint names the log file', () => {
  const { t } = make()
  expect(t.logsHint({} as never)).toBe('tail -f ~/Library/Logs/jaypost/jaypost.log')
})

test('readAdminKey reads the admin key file next to the recorded configFile', async () => {
  const key = `jpa_${'k'.repeat(43)}`
  writeFileSync(join(tmp, 'admin-key'), `${key}\n`)
  const { t } = make({ JAYPOST_CONFIG: join(tmp, 'elsewhere', 'other.json') })
  expect(
    await t.readAdminKey({
      target: 'launchd',
      port: 1,
      version: 'v',
      configFile: join(tmp, 'recorded.json'),
    }),
  ).toBe(key)
})
