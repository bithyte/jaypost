import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, expect, test } from 'vite-plus/test'
import {
  findDefaultTarget,
  detectTargets,
  findExistingInstall,
  findLeftoverSecrets,
  resolveInstallPaths,
  resolveTargetOrder,
  TARGET_ORDER,
  writeInstall,
} from '../../src/install/index.ts'
import type { Target, TargetName } from '../../src/install/index.ts'
import { telegramProvider } from '@jaypost/providers'
import { createFakeProvider } from '@jaypost/testing'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'targets-'))
})

function fake(name: TargetName, ok: boolean): Target {
  return {
    name,
    available: async () => (ok ? { ok: true } : { ok: false, reason: `${name} missing` }),
  } as Target
}

function fakes(ok: Record<Exclude<TargetName, 'launchd'>, boolean>): Record<TargetName, Target> {
  return {
    systemd: fake('systemd', ok.systemd),
    compose: fake('compose', ok.compose),
    quadlet: fake('quadlet', ok.quadlet),
    launchd: fake('launchd', false),
  }
}

test('order is quadlet, compose, systemd', () => {
  expect(TARGET_ORDER).toEqual(['quadlet', 'compose', 'systemd'])
})

test('darwin order starts with launchd', () => {
  expect(resolveTargetOrder('darwin')).toEqual(['launchd', 'quadlet', 'compose', 'systemd'])
})

test('linux order never lists launchd', () => {
  expect(resolveTargetOrder('linux')).toEqual(['quadlet', 'compose', 'systemd'])
})

test('darwin default is launchd when it is available', async () => {
  const targets = {
    ...fakes({ systemd: false, compose: true, quadlet: false }),
    launchd: fake('launchd', true),
  }
  const d = await detectTargets(targets, resolveTargetOrder('darwin'))
  expect(d.map((x) => x.name)).toEqual(['launchd', 'quadlet', 'compose', 'systemd'])
  expect(findDefaultTarget(d)).toBe('launchd')
})

test('default is quadlet when all ok', async () => {
  const d = await detectTargets(fakes({ systemd: true, compose: true, quadlet: true }))
  expect(d.map((x) => x.name)).toEqual(['quadlet', 'compose', 'systemd'])
  expect(findDefaultTarget(d)).toBe('quadlet')
})

test('default is compose when podman missing', async () => {
  const d = await detectTargets(fakes({ systemd: true, compose: true, quadlet: false }))
  expect(d[0]).toEqual({ name: 'quadlet', ok: false, reason: 'quadlet missing' })
  expect(findDefaultTarget(d)).toBe('compose')
})

test('default undefined when none ok', async () => {
  const d = await detectTargets(fakes({ systemd: false, compose: false, quadlet: false }))
  expect(findDefaultTarget(d)).toBeUndefined()
})

test('legacy unit with no install.json', () => {
  const paths = resolveInstallPaths({ HOME: tmp })
  mkdirSync(dirname(paths.systemdUnit), { recursive: true })
  writeFileSync(paths.systemdUnit, '[Unit]\n')
  mkdirSync(paths.configDirectory, { recursive: true })
  writeFileSync(paths.configFile, JSON.stringify({ port: 9000 }))
  const found = findExistingInstall(paths, fakes({ systemd: true, compose: true, quadlet: true }), {
    HOME: tmp,
  })
  expect(found).toEqual({
    record: { target: 'systemd', port: 9000, version: 'legacy', configFile: paths.configFile },
    legacy: true,
  })
})

test('legacy port defaults to 8787', () => {
  const paths = resolveInstallPaths({ HOME: tmp })
  mkdirSync(dirname(paths.systemdUnit), { recursive: true })
  writeFileSync(paths.systemdUnit, '[Unit]\n')
  const found = findExistingInstall(paths, fakes({ systemd: true, compose: true, quadlet: true }), {
    HOME: tmp,
  })
  expect(found?.record.port).toBe(8787)
})

test('legacy port honors JAYPOST_CONFIG', () => {
  const env = { HOME: tmp, JAYPOST_CONFIG: join(tmp, 'other.json') }
  writeFileSync(env.JAYPOST_CONFIG, JSON.stringify({ port: 9100 }))
  const paths = resolveInstallPaths(env)
  mkdirSync(dirname(paths.systemdUnit), { recursive: true })
  writeFileSync(paths.systemdUnit, '[Unit]\n')
  expect(
    findExistingInstall(paths, fakes({ systemd: true, compose: true, quadlet: true }), env)?.record
      .port,
  ).toBe(9100)
})

test('nothing found', () => {
  const paths = resolveInstallPaths({ HOME: tmp })
  expect(
    findExistingInstall(paths, fakes({ systemd: true, compose: true, quadlet: true }), {
      HOME: tmp,
    }),
  ).toBeUndefined()
})

test('install.json wins over legacy unit', () => {
  const paths = resolveInstallPaths({ HOME: tmp })
  mkdirSync(dirname(paths.systemdUnit), { recursive: true })
  writeFileSync(paths.systemdUnit, '[Unit]\n')
  writeInstall(paths.installFile, { target: 'compose', port: 8800, version: '1.2.3' })
  const found = findExistingInstall(paths, fakes({ systemd: true, compose: true, quadlet: true }), {
    HOME: tmp,
  })
  expect(found).toEqual({
    record: { target: 'compose', port: 8800, version: '1.2.3' },
    legacy: false,
  })
})

test('legacy unit Environment=JAYPOST_CONFIG wins over the env', () => {
  const env = { HOME: tmp, JAYPOST_CONFIG: join(tmp, 'env.json') }
  const paths = resolveInstallPaths(env)
  const pinned = join(tmp, 'pin ned.json')
  writeFileSync(pinned, JSON.stringify({ port: 9200 }))
  mkdirSync(dirname(paths.systemdUnit), { recursive: true })
  writeFileSync(
    paths.systemdUnit,
    `[Service]\nEnvironment="JAYPOST_CONFIG=${pinned}"\nExecStart=/n /c start\n`,
  )
  expect(
    findExistingInstall(paths, fakes({ systemd: true, compose: true, quadlet: true }), env),
  ).toEqual({
    record: { target: 'systemd', port: 9200, version: 'legacy', configFile: pinned },
    legacy: true,
  })
})

test('leftover secrets: none', () => {
  expect(findLeftoverSecrets(resolveInstallPaths({ HOME: tmp }), { HOME: tmp })).toBeUndefined()
})

test('leftover secrets from config.json (honoring JAYPOST_CONFIG)', () => {
  const env = { HOME: tmp, JAYPOST_CONFIG: join(tmp, 'c.json') }
  writeFileSync(env.JAYPOST_CONFIG, JSON.stringify({ botToken: 'ct', ownerId: 3 }))
  expect(findLeftoverSecrets(resolveInstallPaths(env), env)).toEqual({
    provider: 'telegram',
    settings: { botToken: 'ct', ownerId: 3 },
  })
})

test('leftover secrets from a container .env', () => {
  const paths = resolveInstallPaths({ HOME: tmp })
  mkdirSync(paths.composeDirectory, { recursive: true })
  writeFileSync(
    join(paths.composeDirectory, '.env'),
    'JAYPOST_BOT_TOKEN=et\nJAYPOST_PORT=1\nJAYPOST_OWNER_ID=8\n',
  )
  expect(findLeftoverSecrets(paths, { HOME: tmp })).toEqual({
    provider: 'telegram',
    settings: { botToken: 'et', ownerId: 8 },
  })
  mkdirSync(paths.quadletDirectory, { recursive: true })
  writeFileSync(
    join(paths.quadletDirectory, '.env'),
    'JAYPOST_PROVIDER=telegram\nJAYPOST_BOT_TOKEN=qt\nJAYPOST_PORT=1\n',
  )
  expect(findLeftoverSecrets(paths, { HOME: tmp })).toEqual({
    provider: 'telegram',
    settings: { botToken: 'qt' },
  })
})

test('leftover secrets ignore corrupt config and token-less files', () => {
  const paths = resolveInstallPaths({ HOME: tmp })
  mkdirSync(paths.configDirectory, { recursive: true })
  writeFileSync(paths.configFile, '{oops')
  mkdirSync(paths.quadletDirectory, { recursive: true })
  writeFileSync(join(paths.quadletDirectory, '.env'), 'JAYPOST_PORT=1\nJAYPOST_OWNER_ID=2\n')
  expect(findLeftoverSecrets(paths, { HOME: tmp })).toBeUndefined()
})

test('leftover with an unknown provider is skipped', () => {
  const paths = resolveInstallPaths({ HOME: tmp })
  mkdirSync(paths.quadletDirectory, { recursive: true })
  writeFileSync(
    join(paths.quadletDirectory, '.env'),
    'JAYPOST_PROVIDER=nope\nJAYPOST_BOT_TOKEN=qt\n',
  )
  mkdirSync(paths.composeDirectory, { recursive: true })
  writeFileSync(join(paths.composeDirectory, '.env'), 'JAYPOST_BOT_TOKEN=et\n')
  expect(findLeftoverSecrets(paths, { HOME: tmp })).toEqual({
    provider: 'telegram',
    settings: { botToken: 'et' },
  })
})

test('leftover needs every required secret', () => {
  const paths = resolveInstallPaths({ HOME: tmp })
  const providers = [telegramProvider, createFakeProvider()]
  mkdirSync(paths.composeDirectory, { recursive: true })
  writeFileSync(
    join(paths.composeDirectory, '.env'),
    'JAYPOST_PROVIDER=fake\nJAYPOST_BOT_TOKEN=x\n',
  )
  mkdirSync(paths.configDirectory, { recursive: true })
  writeFileSync(paths.configFile, JSON.stringify({ provider: 'fake', fakeKey: 'k' }))
  expect(findLeftoverSecrets(paths, { HOME: tmp }, providers)).toEqual({
    provider: 'fake',
    settings: { fakeKey: 'k' },
  })
})

test('resolveInstallPaths locates the token file next to the config', () =>
  expect(resolveInstallPaths({ HOME: '/h' }).tokenFile).toBe('/h/.config/jaypost/service/token'))
