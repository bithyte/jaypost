import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, expect, test, vi } from 'vite-plus/test'
import { readConfigFile } from '../../src/config/index.ts'
import {
  resolveInstallPaths,
  createSystemdTarget,
  findUnitConfigFile,
  findUnitExecWords,
  formatSystemdUnit,
} from '../../src/install/index.ts'
import { MissingCommandError } from '../../src/system/index.ts'
import type { Exec } from '../../src/system/index.ts'
import { NO_AUTH } from '../../src/auth/index.ts'
import { telegramProvider } from '../../src/telegram/index.ts'
import { createFakeProvider } from '../provider/fake.ts'

let tmp: string
let calls: [string, readonly string[]][]
let prefixOut: string
let rootOut: string
let failRestart: boolean

const fakeExec: Exec = async (cmd, args, options) => {
  calls.push([cmd, args])
  if (cmd === 'npm' && args[0] === 'i') {
    options?.onOutput?.('STEP 1/7\n')
  }
  if (cmd === 'npm' && args[0] === 'prefix') {
    return { code: 0, stdout: prefixOut + '\n', stderr: '' }
  }
  if (cmd === 'npm' && args[0] === 'root') {
    return { code: 0, stdout: rootOut + '\n', stderr: '' }
  }
  if (cmd === 'systemctl' && args[1] === 'restart' && failRestart) {
    return { code: 1, stdout: '', stderr: 'boom' }
  }
  if (cmd === 'loginctl') {
    return { code: 0, stdout: 'Linger=yes\n', stderr: '' }
  }
  return { code: 0, stdout: '', stderr: '' }
}

function make(env: NodeJS.ProcessEnv = {}, selfPath = '/src/dist/cli.js') {
  const e = { HOME: tmp, ...env }
  const paths = resolveInstallPaths(e)
  const t = createSystemdTarget(
    {
      exec: fakeExec,
      paths,
      env: e,
      user: 'me',
      providers: [telegramProvider, createFakeProvider()],
      platform: 'linux',
      uid: 501,
    },
    { kind: 'npm', selfPath, nodePath: '/usr/bin/node' },
  )
  return { t, paths }
}

function makeBinary(env: NodeJS.ProcessEnv = {}, binaryPath = join(tmp, 'dl', 'jaypost')) {
  if (!existsSync(binaryPath)) {
    mkdirSync(dirname(binaryPath), { recursive: true })
    writeFileSync(binaryPath, 'binary v2')
  }
  const e = { HOME: tmp, PATH: '/usr/bin', ...env }
  const paths = resolveInstallPaths(e)
  const t = createSystemdTarget(
    {
      exec: fakeExec,
      paths,
      env: e,
      user: 'me',
      providers: [telegramProvider, createFakeProvider()],
      platform: 'linux',
      uid: 501,
    },
    { kind: 'binary', binaryPath },
  )
  return { t, paths, binaryPath }
}

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'
const base = {
  version: '0.1.0',
  port: 8787,
  provider: telegramProvider,
  settings: { botToken: 't' },
  auth: NO_AUTH,
  print: () => {},
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'sd-')))
  calls = []
  prefixOut = '/usr'
  rootOut = '/usr/lib/node_modules'
  failRestart = false
})

test('installs from npm into a user prefix when global prefix is not writable', async () => {
  const { t, paths } = make()
  const rec = await t.install(base)
  expect(calls).toContainEqual([
    'npm',
    ['i', '-g', '--prefix', paths.userNpmPrefix, 'jaypost@0.1.0'],
  ])
  expect(rec.cliPath).toBe(
    join(paths.userNpmPrefix, 'lib', 'node_modules', 'jaypost', 'dist', 'cli.js'),
  )
})

test('systemd install streams npm install output to the output callback', async () => {
  const { t } = make()
  const chunks: string[] = []
  await t.install({ ...base, output: (chunk) => chunks.push(chunk) })
  expect(chunks).toEqual(['STEP 1/7\n'])
})

test('installs globally when prefix is writable', async () => {
  prefixOut = tmp
  rootOut = join(tmp, 'lib', 'node_modules')
  const { t } = make()
  const rec = await t.install({ ...base, tarball: '/x/pkg.tgz' })
  expect(calls).toContainEqual(['npm', ['i', '-g', '/x/pkg.tgz']])
  expect(rec.cliPath).toBe(join(rootOut, 'jaypost', 'dist', 'cli.js'))
})

test('install writes unit, config 0600, enables', async () => {
  const { t, paths } = make()
  const rec = await t.install(base)
  expect(calls).toContainEqual(['systemctl', ['--user', 'daemon-reload']])
  expect(calls).toContainEqual(['systemctl', ['--user', 'enable', '--now', 'jaypost']])
  expect(calls.some(([c]) => c === 'sudo')).toBe(false)
  expect(readConfigFile(paths.configFile)).toEqual({
    provider: 'telegram',
    botToken: 't',
    port: 8787,
  })
  expect(statSync(paths.configFile).mode & 0o777).toBe(0o600)
  const unit = readFileSync(paths.systemdUnit, 'utf8')
  expect(unit).toContain(`ExecStart="/usr/bin/node" "${rec.cliPath}" start`)
  expect(unit).toContain(`Environment="JAYPOST_CONFIG=${paths.configFile}"`)
  expect(rec).toMatchObject({
    target: 'systemd',
    provider: 'telegram',
    port: 8787,
    version: '0.1.0',
    configFile: paths.configFile,
  })
})

test('unit stays quoted with spaces in paths and config env', async () => {
  const cfg = join(tmp, 'my dir', 'c.json')
  rootOut = join(tmp, 'my root')
  const self = join(rootOut, 'jaypost', 'dist', 'cli.js')
  const { t, paths } = make({ JAYPOST_CONFIG: cfg }, self)
  await t.install(base)
  const unit = readFileSync(paths.systemdUnit, 'utf8')
  expect(unit).toContain(`ExecStart="/usr/bin/node" "${self}" start`)
  expect(unit).toContain(`Environment="JAYPOST_CONFIG=${cfg}"`)
  expect(readConfigFile(cfg).botToken).toBe('t')
})

test('install keeps a reused owner id', async () => {
  const { t, paths } = make()
  await t.install({ ...base, settings: { botToken: 't', ownerId: 42 } })
  expect(readConfigFile(paths.configFile)).toEqual({
    provider: 'telegram',
    botToken: 't',
    port: 8787,
    ownerId: 42,
  })
  expect(await t.readSecrets({} as never)).toEqual({
    provider: 'telegram',
    settings: { botToken: 't', ownerId: 42 },
  })
  await t.clearOwner({} as never)
  expect(readConfigFile(paths.configFile).ownerId).toBeUndefined()
})

test('already global: no npm install', async () => {
  const self = join(rootOut, 'jaypost', 'dist', 'cli.js')
  const { t } = make({}, self)
  const rec = await t.install(base)
  expect(calls.some(([c, a]) => c === 'npm' && a[0] === 'i')).toBe(false)
  expect(rec.cliPath).toBe(self)
})

test('remove without purge keeps config; with purge deletes it', async () => {
  const { t, paths } = make()
  const rec = await t.install(base)
  const stateFile = join(dirname(paths.configFile), 'state.json')
  writeFileSync(stateFile, '{}')
  await t.remove(rec, false)
  expect(existsSync(paths.systemdUnit)).toBe(false)
  expect(existsSync(paths.configFile)).toBe(true)
  expect(existsSync(stateFile)).toBe(true)
  expect(calls).toContainEqual(['systemctl', ['--user', 'disable', '--now', 'jaypost']])
  await t.remove(rec, true)
  expect(existsSync(paths.configFile)).toBe(false)
  expect(existsSync(stateFile)).toBe(false)
})

test('available is false when systemctl is missing', async () => {
  const e = { HOME: tmp }
  const t = createSystemdTarget(
    {
      exec: async (cmd) => {
        throw new MissingCommandError(cmd)
      },
      paths: resolveInstallPaths(e),
      env: e,
      user: 'me',
      providers: [telegramProvider],
      platform: 'darwin',
      uid: 501,
    },
    { kind: 'npm', selfPath: '/src/dist/cli.js', nodePath: '/usr/bin/node' },
  )
  expect(await t.available()).toEqual({ ok: false, reason: 'systemctl not available' })
})

test('available, isRunning, restart, logsHint', async () => {
  const { t } = make()
  expect(await t.available()).toEqual({ ok: true })
  expect(await t.isRunning({} as never)).toBe(true)
  await t.restart({} as never)
  expect(calls).toContainEqual(['systemctl', ['--user', 'restart', 'jaypost']])
  expect(t.logsHint({} as never)).toBe('journalctl --user -u jaypost -f')
})

test('restart throws on a non-zero exit without leaking stderr', async () => {
  failRestart = true
  const { t } = make()
  await expect(t.restart({} as never)).rejects.toThrow('systemctl restart failed (exit 1)')
})

test('relative JAYPOST_CONFIG is resolved to an absolute path and recorded', async () => {
  const cwd = process.cwd()
  process.chdir(tmp)
  try {
    const { t, paths } = make({ JAYPOST_CONFIG: 'rel/c.json' })
    const rec = await t.install(base)
    const abs = join(tmp, 'rel', 'c.json')
    expect(rec.configFile).toBe(abs)
    expect(readFileSync(paths.systemdUnit, 'utf8')).toContain(`Environment="JAYPOST_CONFIG=${abs}"`)
    expect(readConfigFile(abs).botToken).toBe('t')
  } finally {
    process.chdir(cwd)
  }
})

test('readSecrets, clearOwner and purge use the recorded configFile, not the env', async () => {
  const recorded = join(tmp, 'recorded.json')
  writeFileSync(recorded, JSON.stringify({ botToken: 'rt', ownerId: 5 }))
  const recordedState = join(tmp, 'state.json')
  writeFileSync(recordedState, '{}')
  const { t, paths } = make({ JAYPOST_CONFIG: join(tmp, 'other.json') })
  const rec = { target: 'systemd' as const, port: 1, version: 'v', configFile: recorded }
  expect(await t.readSecrets(rec)).toEqual({
    provider: 'telegram',
    settings: { botToken: 'rt', ownerId: 5 },
  })
  await t.clearOwner(rec)
  expect(readConfigFile(recorded)).toEqual({ botToken: 'rt' })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  await t.remove(rec, true)
  expect(existsSync(recorded)).toBe(false)
  expect(existsSync(recordedState)).toBe(false)
  expect(existsSync(paths.configFile)).toBe(false)
})

test('readAuditLog reads both files next to the recorded configFile', async () => {
  const directory = join(tmp, 'recorded-dir')
  mkdirSync(directory)
  writeFileSync(join(directory, 'audit.jsonl.1'), 'old\n')
  writeFileSync(join(directory, 'audit.jsonl'), 'new\n')
  const { t } = make({ JAYPOST_CONFIG: join(tmp, 'other.json') })
  const rec = {
    target: 'systemd' as const,
    port: 1,
    version: 'v',
    configFile: join(directory, 'config.json'),
  }
  expect(await t.readAuditLog(rec)).toBe('old\nnew\n')
  expect(await t.readAuditLog({ ...rec, configFile: join(tmp, 'empty', 'config.json') })).toBe('')
})

test('purge deletes audit.jsonl and audit.jsonl.1; remove without purge keeps them', async () => {
  const configFile = join(tmp, 'config.json')
  writeFileSync(configFile, '{}')
  const current = join(tmp, 'audit.jsonl')
  const rotated = join(tmp, 'audit.jsonl.1')
  writeFileSync(current, 'a\n')
  writeFileSync(rotated, 'b\n')
  const { t } = make()
  const rec = { target: 'systemd' as const, port: 1, version: 'v', configFile }
  await t.remove(rec, false)
  expect(existsSync(current)).toBe(true)
  expect(existsSync(rotated)).toBe(true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  await t.remove(rec, true)
  expect(existsSync(current)).toBe(false)
  expect(existsSync(rotated)).toBe(false)
})

test('install without ownerId keeps a stored owner', async () => {
  const { t, paths } = make()
  mkdirSync(dirname(paths.configFile), { recursive: true })
  writeFileSync(paths.configFile, JSON.stringify({ botToken: 'old', ownerId: 42 }))
  await t.install(base)
  expect(readConfigFile(paths.configFile)).toEqual({
    provider: 'telegram',
    botToken: 't',
    port: 8787,
    ownerId: 42,
  })
})

test("install drops another provider's keys", async () => {
  const { t, paths } = make()
  mkdirSync(dirname(paths.configFile), { recursive: true })
  writeFileSync(paths.configFile, JSON.stringify({ provider: 'fake', fakeKey: 'k', extra: 1 }))
  await t.install(base)
  expect(readConfigFile(paths.configFile)).toEqual({
    provider: 'telegram',
    botToken: 't',
    port: 8787,
    extra: 1,
  })
})

test('readSecrets on an old config without provider reads as telegram', async () => {
  const { t, paths } = make()
  mkdirSync(dirname(paths.configFile), { recursive: true })
  writeFileSync(paths.configFile, JSON.stringify({ botToken: 'old', port: 1, ownerId: 42 }))
  expect(await t.readSecrets({} as never)).toEqual({
    provider: 'telegram',
    settings: { botToken: 'old', ownerId: 42 },
  })
})

test('readSecrets reads the provider named in the config', async () => {
  const { t, paths } = make()
  mkdirSync(dirname(paths.configFile), { recursive: true })
  writeFileSync(paths.configFile, JSON.stringify({ provider: 'fake', fakeKey: 'k', botToken: 'x' }))
  expect(await t.readSecrets({} as never)).toEqual({ provider: 'fake', settings: { fakeKey: 'k' } })
})

test('purge hint names the user prefix when the fallback was used', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const { t, paths } = make()
  const rec = await t.install(base)
  await t.remove(rec, true)
  expect(log).toHaveBeenCalledWith(
    `The npm package was left in place; remove it with: npm rm -g --prefix ${paths.userNpmPrefix} jaypost`,
  )
  log.mockClear()
  await t.remove({ ...rec, cliPath: '/usr/lib/node_modules/jaypost/dist/cli.js' }, true)
  expect(log).toHaveBeenCalledWith(
    'The npm package was left in place; remove it with: npm rm -g jaypost',
  )
  log.mockRestore()
})

test('purge hint goes to the given print instead of stdout', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const { t } = make()
  const rec = await t.install(base)
  const printed: string[] = []
  await t.remove({ ...rec, cliPath: '/usr/lib/node_modules/jaypost/dist/cli.js' }, true, (text) =>
    printed.push(text),
  )
  expect(printed).toEqual(['The npm package was left in place; remove it with: npm rm -g jaypost'])
  expect(log).not.toHaveBeenCalled()
  log.mockRestore()
})

test('findUnitConfigFile parses quoted and unquoted Environment lines', () => {
  expect(findUnitConfigFile('[Service]\nEnvironment="JAYPOST_CONFIG=/a b/50%%/c.json"\n')).toBe(
    '/a b/50%/c.json',
  )
  expect(findUnitConfigFile('Environment="JAYPOST_CONFIG=/x\\"q.json"\n')).toBe('/x"q.json')
  expect(findUnitConfigFile('Environment=JAYPOST_CONFIG=/plain/c.json\n')).toBe('/plain/c.json')
  expect(findUnitConfigFile('Environment="FOO=bar"\nExecStart=x\n')).toBeUndefined()
  expect(findUnitConfigFile('[Unit]\n')).toBeUndefined()
})

test('install writes apiToken, and a later install without a token deletes it', async () => {
  const { t, paths } = make()
  await t.install({ ...base, auth: { kind: 'token', token: TOKEN } })
  expect(readConfigFile(paths.configFile).apiToken).toBe(TOKEN)
  await t.install({ ...base, auth: NO_AUTH })
  expect('apiToken' in readConfigFile(paths.configFile)).toBe(false)
})

test('binary install copies itself to ~/.local/bin and runs it directly', async () => {
  const { t, paths, binaryPath } = makeBinary()
  const binDirectory = join(tmp, '.local', 'bin')
  expect(existsSync(binDirectory)).toBe(false)
  expect(paths.binaryCopy).toBe(join(tmp, '.local', 'bin', 'jaypost'))
  const rec = await t.install(base)
  expect(statSync(paths.binaryCopy).mode & 0o777).toBe(0o755)
  expect(readFileSync(paths.binaryCopy, 'utf8')).toBe(readFileSync(binaryPath, 'utf8'))
  const unit = readFileSync(paths.systemdUnit, 'utf8')
  expect(unit).toContain(`ExecStart="${paths.binaryCopy}" start`)
  expect(unit).not.toContain('node')
  expect(calls.some(([c]) => c === 'npm')).toBe(false)
  expect(calls).toContainEqual(['systemctl', ['--user', 'enable', '--now', 'jaypost']])
  expect(rec).toMatchObject({ target: 'systemd', cliKind: 'binary', cliPath: paths.binaryCopy })
  expect(readdirSync(binDirectory)).toEqual(['jaypost'])
})

test('binary install over an existing copy replaces it with a new inode', async () => {
  const { t, paths } = makeBinary()
  mkdirSync(dirname(paths.binaryCopy), { recursive: true })
  writeFileSync(paths.binaryCopy, 'binary v1')
  const before = statSync(paths.binaryCopy).ino
  await t.install(base)
  expect(statSync(paths.binaryCopy).ino).not.toBe(before)
  expect(readFileSync(paths.binaryCopy, 'utf8')).toBe('binary v2')
  expect(readdirSync(dirname(paths.binaryCopy))).toEqual(['jaypost'])
})

test('binary install from the copy itself skips the copy', async () => {
  const copy = join(tmp, '.local', 'bin', 'jaypost')
  mkdirSync(dirname(copy), { recursive: true })
  writeFileSync(copy, 'binary v1')
  const before = statSync(copy).ino
  const { t, paths } = makeBinary({}, copy)
  expect(paths.binaryCopy).toBe(copy)
  const rec = await t.install(base)
  expect(statSync(copy).ino).toBe(before)
  expect(readFileSync(copy, 'utf8')).toBe('binary v1')
  expect(rec).toMatchObject({ cliKind: 'binary', cliPath: copy })
})

test('binary unit stays quoted with spaces and $ in HOME', async () => {
  const home = join(tmp, 'my $home')
  const { t, paths } = makeBinary({ HOME: home })
  await t.install(base)
  const unit = readFileSync(paths.systemdUnit, 'utf8')
  const quoted = join(tmp, 'my $$home', '.local', 'bin', 'jaypost')
  expect(unit).toContain(`ExecStart="${quoted}" start`)
  expect(readFileSync(join(home, '.local', 'bin', 'jaypost'), 'utf8')).toBe('binary v2')
})

test("binary install prints a PATH hint when ~/.local/bin isn't on PATH", async () => {
  const hint = "~/.local/bin isn't on your PATH; add it to run jaypost from anywhere."
  const printed: string[] = []
  const { t } = makeBinary({ PATH: '/usr/bin:/bin' })
  await t.install({ ...base, print: (text) => printed.push(text) })
  expect(printed).toContain(hint)
  const onPath: string[] = []
  const { t: t2 } = makeBinary({ PATH: `/usr/bin:${join(tmp, '.local', 'bin')}` })
  await t2.install({ ...base, print: (text) => onPath.push(text) })
  expect(onPath).not.toContain(hint)
})

test('npm install records cliKind npm', async () => {
  const { t } = make()
  const rec = await t.install(base)
  expect(rec).toMatchObject({ target: 'systemd', cliKind: 'npm' })
})

function plantCopy(paths: { readonly binaryCopy: string }, kind: 'file' | 'symlink'): void {
  mkdirSync(dirname(paths.binaryCopy), { recursive: true })
  if (kind === 'file') {
    writeFileSync(paths.binaryCopy, 'binary v1')
    return
  }
  symlinkSync('../lib/node_modules/jaypost/dist/cli.js', paths.binaryCopy)
}

test('purge removes the binary copy', async () => {
  const { t, paths } = makeBinary()
  const rec = await t.install(base)
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  await t.remove(rec, true)
  expect(existsSync(paths.binaryCopy)).toBe(false)
  expect(log).not.toHaveBeenCalled()
  log.mockRestore()
})

test('remove without purge keeps the binary copy', async () => {
  const { t, paths } = makeBinary()
  const rec = await t.install(base)
  await t.remove(rec, false)
  expect(existsSync(paths.binaryCopy)).toBe(true)
})

test('binary target is unavailable when ~/.local/bin/jaypost is a symlink', async () => {
  const { t, paths } = makeBinary()
  plantCopy(paths, 'symlink')
  expect(await t.available()).toEqual({
    ok: false,
    reason: '~/.local/bin/jaypost is a symlink (npm\'s launcher?); run "npm rm -g jaypost" first',
  })
})

test('npm install deletes a leftover binary copy before npm i -g', async () => {
  const { paths } = make()
  plantCopy(paths, 'file')
  let existedAtNpmInstall: boolean | undefined
  const exec: Exec = async (cmd, args) => {
    if (cmd === 'npm' && args[0] === 'i') {
      existedAtNpmInstall = existsSync(paths.binaryCopy)
    }
    return fakeExec(cmd, args)
  }
  const target = createSystemdTarget(
    {
      exec,
      paths,
      env: { HOME: tmp },
      user: 'me',
      providers: [telegramProvider, createFakeProvider()],
      platform: 'linux',
      uid: 501,
    },
    { kind: 'npm', selfPath: '/src/dist/cli.js', nodePath: '/usr/bin/node' },
  )
  await target.install(base)
  expect(existedAtNpmInstall).toBe(false)
  expect(existsSync(paths.binaryCopy)).toBe(false)
})

test('npm install leaves a symlink at ~/.local/bin/jaypost alone', async () => {
  const { t, paths } = make()
  plantCopy(paths, 'symlink')
  await t.install(base)
  expect(lstatSync(paths.binaryCopy).isSymbolicLink()).toBe(true)
})

test('upgrade rewrites the unit and restarts', async () => {
  const { t, paths } = make()
  const previous = await t.install(base)
  calls = []
  const record = await t.upgrade({ ...base, version: '0.2.0' }, previous)
  expect(record).toMatchObject({ target: 'systemd', version: '0.2.0', cliKind: 'npm' })
  expect(readFileSync(paths.systemdUnit, 'utf8')).toContain('ExecStart="/usr/bin/node"')
  const ctl = calls.filter(([c]) => c === 'systemctl').map(([, a]) => a.slice(1).join(' '))
  expect(ctl).toEqual(['daemon-reload', 'enable --now jaypost', 'restart jaypost'])
})

test('upgrade throws when the restart fails', async () => {
  const { t } = make()
  const previous = await t.install(base)
  failRestart = true
  await expect(t.upgrade(base, previous)).rejects.toThrow('systemctl restart failed (exit 1)')
})

test('findUnitExecWords returns the ExecStart words without start', () => {
  expect(findUnitExecWords('[Service]\nExecStart="/usr/bin/node" "/x/cli.js" start\n')).toEqual([
    '/usr/bin/node',
    '/x/cli.js',
  ])
  expect(findUnitExecWords('ExecStart="/h/.local/bin/jaypost" start\n')).toEqual([
    '/h/.local/bin/jaypost',
  ])
  expect(findUnitExecWords('ExecStart=/usr/bin/node /x/cli.js start\n')).toEqual([
    '/usr/bin/node',
    '/x/cli.js',
  ])
  expect(findUnitExecWords('[Unit]\nDescription=x\n')).toBeUndefined()
})

test('findUnitExecWords undoes the quoting formatSystemdUnit applies', () => {
  const words = ['/a b/$HOME/50%/"q"\\x', '/c.js']
  const unit = formatSystemdUnit({ exec: words, config: '/c.json' })
  expect(findUnitExecWords(unit)).toEqual(words)
})
