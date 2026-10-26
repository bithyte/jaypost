import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vite-plus/test'
import { createComposeTarget, resolveInstallPaths } from '../../src/install/index.ts'
import type { Exec } from '@jaypost/store'
import { NO_AUTH } from '@jaypost/store'
import { telegramProvider } from '@jaypost/providers'
import { createFakeProvider, createPairingFakeProvider } from '@jaypost/testing'

let tmp: string
let calls: [string, readonly string[]][]
let fail: (cmd: string, args: readonly string[]) => boolean
let ownerOut: string
let imageIds: string[]
let adminKeyOut: string

const ADMIN_KEY = `jpa_${'k'.repeat(43)}`

const fakeExec: Exec = async (cmd, args, options) => {
  calls.push([cmd, args])
  if (args.includes('up')) {
    options?.onOutput?.('STEP 1/7\n')
  }
  if (fail(cmd, args)) {
    return { code: 1, stdout: '', stderr: 'x' }
  }
  if (args.includes('images')) {
    return { code: 0, stdout: `${imageIds.shift() ?? ''}\n`, stderr: '' }
  }
  if (args.includes('admin-key')) {
    return { code: 0, stdout: adminKeyOut, stderr: '' }
  }
  if (args.includes('audit')) {
    return { code: 0, stdout: 'LINES', stderr: '' }
  }
  if (args.includes('owner') && args.includes('get')) {
    return { code: 0, stdout: ownerOut, stderr: '' }
  }
  return { code: 0, stdout: '', stderr: '' }
}

function make() {
  const env = { HOME: tmp }
  const paths = resolveInstallPaths(env)
  return {
    t: createComposeTarget({
      exec: fakeExec,
      paths,
      env,
      user: 'me',
      providers: PROVIDERS,
      platform: 'linux',
      uid: 501,
    }),
    paths,
  }
}
const PAIRING_FAKE = createPairingFakeProvider()
const PROVIDERS = [telegramProvider, PAIRING_FAKE]
const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'
const base = {
  version: '0.1.0',
  port: 8787,
  provider: telegramProvider,
  settings: { botToken: 't' },
  auth: NO_AUTH,
  print: () => {},
}
const withOwner = { ...base, settings: { botToken: 't', ownerId: 9 } }
const rec = { target: 'compose' as const, port: 8787, version: '0.1.0' }

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cmp-'))
  calls = []
  fail = () => false
  ownerOut = ''
  imageIds = []
  adminKeyOut = ''
})

test('unavailable when compose v2 is missing', async () => {
  const { t } = make()
  fail = (c) => c === 'docker'
  expect(await t.available()).toEqual({ ok: false, reason: 'docker compose v2 not available' })
})

test('unavailable when docker missing entirely (throws)', async () => {
  const { paths } = make()
  const env = { HOME: tmp }
  const t = createComposeTarget({
    exec: async () => {
      throw new Error('ENOENT')
    },
    paths,
    env,
    user: 'me',
    providers: PROVIDERS,
    platform: 'linux',
    uid: 501,
  })
  expect(await t.available()).toEqual({ ok: false, reason: 'docker not installed' })
})

test('unavailable when docker info fails', async () => {
  const { t } = make()
  fail = (_c, a) => a[0] === 'info'
  expect(await t.available()).toEqual({
    ok: false,
    reason: "can't talk to docker (not in the docker group?)",
  })
})

test('available when both ok', async () => {
  const { t } = make()
  expect(await t.available()).toEqual({ ok: true })
})

test('install writes files and runs up -d --build', async () => {
  const { t, paths } = make()
  const tar = join(tmp, 'pkg-1.tgz')
  writeFileSync(tar, 'x')
  const r = await t.install({ ...withOwner, tarball: tar })
  expect(r).toEqual({ target: 'compose', provider: 'telegram', port: 8787, version: '0.1.0' })
  expect(readFileSync(join(paths.composeDirectory, 'Dockerfile'), 'utf8')).toContain(
    'COPY pkg-1.tgz',
  )
  expect(existsSync(join(paths.composeDirectory, 'pkg-1.tgz'))).toBe(true)
  expect(existsSync(join(paths.composeDirectory, 'compose.yaml'))).toBe(true)
  const envPath = join(paths.composeDirectory, '.env')
  expect(statSync(envPath).mode & 0o777).toBe(0o600)
  expect(readFileSync(envPath, 'utf8')).toBe(
    'JAYPOST_PROVIDER=telegram\nJAYPOST_BOT_TOKEN=t\nJAYPOST_PORT=8787\nJAYPOST_OWNER_ID=9\n',
  )
  expect(readFileSync(join(paths.composeDirectory, '.dockerignore'), 'utf8')).toBe('.env\n')
  expect(calls.at(-1)).toEqual([
    'docker',
    ['compose', '-f', join(paths.composeDirectory, 'compose.yaml'), 'up', '-d', '--build'],
  ])
})

test('compose install streams docker compose output to the output callback', async () => {
  const { t } = make()
  const chunks: string[] = []
  await t.install({ ...base, output: (chunk) => chunks.push(chunk) })
  expect(chunks).toEqual(['STEP 1/7\n'])
})

test('install throws when up fails', async () => {
  const { t } = make()
  fail = (_c, a) => a.includes('up')
  await expect(t.install(base)).rejects.toThrow(/docker compose up/)
})

test('readSecrets prefers JAYPOST_OWNER_ID in .env, falls back to owner get', async () => {
  const { t } = make()
  await t.install(withOwner)
  expect(await t.readSecrets(rec)).toEqual({
    provider: 'telegram',
    settings: { botToken: 't', ownerId: 9 },
  })
  await t.clearOwner(rec)
  ownerOut = '77\n'
  calls = []
  expect(await t.readSecrets(rec)).toEqual({
    provider: 'telegram',
    settings: { botToken: 't', ownerId: 77 },
  })
  expect(calls[0]![1]).toEqual(
    expect.arrayContaining(['run', '--rm', '--no-deps', 'bot', 'jaypost', 'owner', 'get']),
  )
  ownerOut = ''
  expect(await t.readSecrets(rec)).toEqual({ provider: 'telegram', settings: { botToken: 't' } })
})

test('readAuditLog runs audit dump without a tty', async () => {
  const { t, paths } = make()
  expect(await t.readAuditLog(rec)).toBe('LINES')
  expect(calls).toEqual([
    [
      'docker',
      [
        'compose',
        '-f',
        join(paths.composeDirectory, 'compose.yaml'),
        'run',
        '--rm',
        '--no-deps',
        '-T',
        'bot',
        'jaypost',
        'audit',
        'dump',
      ],
    ],
  ])
})

test('readAuditLog throws with stderr when compose run fails', async () => {
  const { t } = make()
  fail = (_c, a) => a.includes('audit')
  await expect(t.readAuditLog(rec)).rejects.toThrow("couldn't read the log from the container: x")
})

test('readSecrets on an old env file reads as telegram', async () => {
  const { t, paths } = make()
  mkdirSync(paths.composeDirectory, { recursive: true })
  writeFileSync(
    join(paths.composeDirectory, '.env'),
    'JAYPOST_BOT_TOKEN=t\nJAYPOST_PORT=1\nJAYPOST_OWNER_ID=8\n',
  )
  expect(await t.readSecrets(rec)).toEqual({
    provider: 'telegram',
    settings: { botToken: 't', ownerId: 8 },
  })
  expect(calls).toEqual([])
})

test('readSecrets of an unknown provider has no settings', async () => {
  const { t, paths } = make()
  mkdirSync(paths.composeDirectory, { recursive: true })
  writeFileSync(
    join(paths.composeDirectory, '.env'),
    'JAYPOST_PROVIDER=nope\nJAYPOST_BOT_TOKEN=t\n',
  )
  expect(await t.readSecrets(rec)).toEqual({ provider: 'nope', settings: {} })
})

test("clearOwner removes the owner env var of the record's provider", async () => {
  const { t, paths } = make()
  const record = await t.install({
    ...base,
    provider: PAIRING_FAKE,
    settings: { fakeKey: 'k', fakeOwner: 'o' },
  })
  expect(record.provider).toBe('fakepair')
  const envPath = join(paths.composeDirectory, '.env')
  expect(readFileSync(envPath, 'utf8')).toBe(
    'JAYPOST_PROVIDER=fakepair\nFAKE_KEY=k\nJAYPOST_PORT=8787\nFAKE_OWNER=o\n',
  )
  await t.clearOwner(record)
  expect(readFileSync(envPath, 'utf8')).toBe(
    'JAYPOST_PROVIDER=fakepair\nFAKE_KEY=k\nJAYPOST_PORT=8787\n',
  )
})

test('clearOwner throws when the provider has no owner setting', async () => {
  const { paths } = make()
  const t = createComposeTarget({
    exec: fakeExec,
    paths,
    env: { HOME: tmp },
    user: 'me',
    providers: [createFakeProvider()],
    platform: 'linux',
    uid: 501,
  })
  await expect(t.clearOwner({ ...rec, provider: 'fake' })).rejects.toThrow(
    'provider "fake" has no owner setting',
  )
})

test('clearOwner removes env key and runs owner clear', async () => {
  const { t, paths } = make()
  await t.install(withOwner)
  calls = []
  await t.clearOwner(rec)
  expect(readFileSync(join(paths.composeDirectory, '.env'), 'utf8')).not.toContain(
    'JAYPOST_OWNER_ID',
  )
  expect(calls[0]![1]).toContain('clear')
})

test('remove without purge keeps .env and volume', async () => {
  const { t, paths } = make()
  await t.install(base)
  calls = []
  await t.remove(rec, false)
  expect(calls.some(([, a]) => a.includes('-v'))).toBe(false)
  expect(calls.some(([, a]) => a.includes('down'))).toBe(true)
  expect(existsSync(join(paths.composeDirectory, '.env'))).toBe(true)
})

test('remove with purge uses down -v and deletes dir', async () => {
  const { t, paths } = make()
  await t.install(base)
  calls = []
  await t.remove(rec, true)
  expect(calls.some(([, a]) => a.includes('down') && a.includes('-v'))).toBe(true)
  expect(existsSync(paths.composeDirectory)).toBe(false)
})

test('restart, isRunning, logsHint', async () => {
  const { t, paths } = make()
  await t.restart(rec)
  expect(calls[0]![1]).toEqual(expect.arrayContaining(['up', '-d', '--force-recreate']))
  expect(await t.isRunning(rec)).toBe(false)
  expect(t.logsHint(rec)).toBe(
    `docker compose -f ${join(paths.composeDirectory, 'compose.yaml')} logs -f`,
  )
})

test('clearOwner throws when the container command fails', async () => {
  const { t } = make()
  await t.install(base)
  fail = (_c, a) => a.includes('clear')
  await expect(t.clearOwner(rec)).rejects.toThrow(/clear the owner/)
})

test('failing down leaves files in place', async () => {
  const { t, paths } = make()
  await t.install(base)
  fail = (_c, a) => a.includes('down')
  await expect(t.remove(rec, true)).rejects.toThrow(/down failed/)
  expect(existsSync(join(paths.composeDirectory, '.env'))).toBe(true)
})

test('install skips copying a tarball already in the build dir', async () => {
  const { t, paths } = make()
  mkdirSync(paths.composeDirectory, { recursive: true })
  const tar = join(paths.composeDirectory, 'pkg-2.tgz')
  writeFileSync(tar, 'x')
  await t.install({ ...base, tarball: tar })
  expect(readFileSync(tar, 'utf8')).toBe('x')
})

test('restart throws on a non-zero exit', async () => {
  const { t } = make()
  fail = (_c, a) => a.includes('--force-recreate')
  await expect(t.restart(rec)).rejects.toThrow('docker compose up failed (exit 1)')
})

test('install writes TZ into .env when a time zone is given', async () => {
  const { t, paths } = make()
  await t.install({ ...base, timeZone: 'Europe/Bucharest' })
  const lines = readFileSync(join(paths.composeDirectory, '.env'), 'utf8').split('\n')
  expect(lines).toContain('TZ=Europe/Bucharest')
})

test('install writes no TZ line without a time zone', async () => {
  const { t, paths } = make()
  await t.install(base)
  expect(readFileSync(join(paths.composeDirectory, '.env'), 'utf8')).not.toContain('TZ=')
})

test('install writes the api token into .env and keeps it out of the Dockerfile', async () => {
  const { t, paths } = make()
  await t.install({ ...base, auth: { kind: 'token', token: TOKEN } })
  const directory = paths.composeDirectory
  expect(readFileSync(join(directory, '.env'), 'utf8')).toContain(`JAYPOST_TOKEN=${TOKEN}\n`)
  expect(readFileSync(join(directory, 'Dockerfile'), 'utf8')).not.toContain(TOKEN)
})

test('upgrade removes the previous image', async () => {
  const { t, paths } = make()
  const previous = await t.install(base)
  imageIds = ['old123', 'new456']
  calls = []
  const record = await t.upgrade({ ...base, version: '0.2.0' }, previous)
  expect(record).toEqual({ target: 'compose', provider: 'telegram', port: 8787, version: '0.2.0' })
  const file = join(paths.composeDirectory, 'compose.yaml')
  expect(calls).toEqual([
    ['docker', ['compose', '-f', file, 'images', '-q', 'bot']],
    ['docker', ['compose', '-f', file, 'up', '-d', '--build']],
    ['docker', ['compose', '-f', file, 'images', '-q', 'bot']],
    ['docker', ['image', 'rm', 'old123']],
  ])
})

test('upgrade keeps the image when it did not change', async () => {
  const { t } = make()
  const previous = await t.install(base)
  imageIds = ['same1', 'same1']
  calls = []
  await t.upgrade(base, previous)
  expect(calls.some(([, a]) => a[0] === 'image')).toBe(false)
})

test('upgrade without an old image removes nothing', async () => {
  const { t } = make()
  imageIds = ['', 'new456']
  calls = []
  await t.upgrade(base, rec)
  expect(calls.some(([, a]) => a[0] === 'image')).toBe(false)
})

test('upgrade prints a failed image rm instead of throwing', async () => {
  const { t } = make()
  const previous = await t.install(base)
  imageIds = ['old123', 'new456']
  fail = (_c, a) => a[0] === 'image'
  const printed: string[] = []
  await t.upgrade({ ...base, print: (text) => printed.push(text) }, previous)
  expect(printed).toContain("Couldn't remove the old image old123: x")
})

test('upgrade throws when the build fails and removes nothing', async () => {
  const { t } = make()
  const previous = await t.install(base)
  imageIds = ['old123', 'new456']
  fail = (_c, a) => a.includes('up')
  calls = []
  await expect(t.upgrade(base, previous)).rejects.toThrow(/docker compose up/)
  expect(calls.some(([, a]) => a[0] === 'image')).toBe(false)
})

test('readAdminKey runs admin-key show without a tty', async () => {
  const { t, paths } = make()
  adminKeyOut = `${ADMIN_KEY}\n`
  expect(await t.readAdminKey(rec)).toBe(ADMIN_KEY)
  expect(calls).toEqual([
    [
      'docker',
      [
        'compose',
        '-f',
        join(paths.composeDirectory, 'compose.yaml'),
        'run',
        '--rm',
        '--no-deps',
        '-T',
        'bot',
        'jaypost',
        'admin-key',
        'show',
      ],
    ],
  ])
})

test('readAdminKey throws with stderr when the container fails', async () => {
  const { t } = make()
  fail = (_command, args) => args.includes('admin-key')
  await expect(t.readAdminKey(rec)).rejects.toThrow(
    "couldn't read the admin key from the container: x",
  )
})

test('readAdminKey refuses output that is not an admin key, without quoting it', async () => {
  const { t } = make()
  adminKeyOut = 'garbage output\n'
  const reading = t.readAdminKey(rec)
  await expect(reading).rejects.toThrow("the container didn't print a valid admin key")
  await expect(reading).rejects.not.toThrow('garbage')
})
