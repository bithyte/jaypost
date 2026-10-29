import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import {
  loadSeed,
  openDatabase,
  RegistryStore,
  resolveAdminKeyPath,
  resolveDatabasePath,
  writeTokenFile,
} from '@jaypost/store'
import type { Registry } from '@jaypost/store'
import { ADMIN_KEY_REJECTED_MESSAGE } from '@jaypost/client'
import { startService } from '@jaypost/service'
import type { RunningService } from '@jaypost/service'
import { resolveInstallPaths, writeInstall } from '@jaypost/install'
import type { InstallPaths, InstallRecord, Target, TargetName } from '@jaypost/install'
import { createFakeProvider, createPairingFakeProvider } from '@jaypost/testing'
import {
  runAdminKeyRotate,
  runAdminKeyShow,
  runBotAdd,
  runBotList,
  runBotRemove,
  runKeyCreate,
  runKeyLabel,
  runKeyList,
  runKeyRevoke,
  runPairingCreate,
  runPairingList,
  runPairingRemove,
} from '../../src/commands/index.ts'
import type { AdminDeps, FetchStatus, Prompts } from '../../src/commands/index.ts'
import { UNREACHABLE_STATUS } from '../../src/commands/constants.ts'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const API_TOKEN = 'a'.repeat(43)
const NEW_BOT_TOKEN = 'new-bot-token-secret'
const SEED_BOT_TOKEN = 'seed-bot-token'
const CODES = ['PAIR2222', 'PAIR3333', 'PAIR4444']
const PROVIDERS = [createPairingFakeProvider(), createFakeProvider()] as const

let tmp: string
let paths: InstallPaths
let out: string[]
let err: string[]
let running: RunningService | undefined

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'admin-cli-'))
  paths = resolveInstallPaths({ HOME: tmp, XDG_CONFIG_HOME: join(tmp, 'cfg') })
  out = []
  err = []
})

afterEach(async () => {
  await running?.stop()
  running = undefined
})

type Started = { readonly port: number; readonly adminKey: string; readonly configPath: string }

/** The registry in the db next to `configPath`, read over a connection of its own. */
function readRegistry(configPath: string): Registry {
  const database = openDatabase(resolveDatabasePath(configPath))
  try {
    return new RegistryStore(database).load()
  } finally {
    database.close()
  }
}

/** A real service whose bot 1 (fakepair) is paired to u1 with key 1. */
async function start(): Promise<Started> {
  const directory = join(tmp, 'service')
  mkdirSync(directory)
  const configPath = join(directory, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      provider: 'fakepair',
      fakeKey: SEED_BOT_TOKEN,
      fakeOwner: 'u1',
      apiToken: API_TOKEN,
    }),
  )
  const codes = [...CODES]
  running = await startService({
    version: '1.2.3',
    configPath,
    providers: PROVIDERS,
    seed: loadSeed({ JAYPOST_CONFIG: configPath }, PROVIDERS),
    log: vi.fn(),
    generateCode: () => codes.shift() ?? 'PAIR9999',
  })
  await running.started
  await running.server.listen({ port: 0, host: '127.0.0.1' })
  const { port } = running.server.server.address() as AddressInfo
  const adminKey = readFileSync(resolveAdminKeyPath(configPath), 'utf8').trim()
  return { port, adminKey, configPath }
}

/** The env of a remote admin: JAYPOST_URL and JAYPOST_ADMIN_KEY. */
function remoteEnv(started: Started): NodeJS.ProcessEnv {
  return {
    HOME: tmp,
    JAYPOST_URL: `http://127.0.0.1:${started.port}`,
    JAYPOST_ADMIN_KEY: started.adminKey,
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

function fakeTarget(name: TargetName, adminKey: () => Promise<string>): Mutable<Target> {
  return {
    name,
    readAdminKey: vi.fn(adminKey),
    isRunning: vi.fn(async () => false),
    logsHint: vi.fn(() => 'logs hint'),
  } as unknown as Mutable<Target>
}

function targets(over: Partial<Record<TargetName, Target>> = {}) {
  const unused = async (): Promise<string> => {
    throw new Error('not this target')
  }
  return {
    quadlet: fakeTarget('quadlet', unused),
    compose: fakeTarget('compose', unused),
    systemd: fakeTarget('systemd', unused),
    launchd: fakeTarget('launchd', unused),
    ...over,
  }
}

function createPrompts(over: Partial<Prompts> = {}): Prompts {
  return {
    confirm: vi.fn(async () => true),
    password: vi.fn(async () => NEW_BOT_TOKEN),
    text: vi.fn(async () => ''),
    select: vi.fn(async (_message, _options, initialValue) => initialValue),
    ...over,
  }
}

function createDeps(env: NodeJS.ProcessEnv, over: Partial<AdminDeps> = {}): AdminDeps {
  return {
    env,
    paths,
    targets: targets(),
    providers: [createFakeProvider()],
    prompt: createPrompts(),
    print: (text) => out.push(text),
    printError: (text) => err.push(text),
    fetchStatus: vi.fn<FetchStatus>(async () => UNREACHABLE_STATUS),
    now: () => new Date('2026-10-26T12:00:00Z'),
    ...over,
  }
}

function countOccurrences(text: string, part: string): number {
  return text.split(part).length - 1
}

test('key create prints the key once and the pairing code when pending', async () => {
  const started = await start()
  expect(await runKeyCreate({ bot: 'b1', label: 'ci' }, createDeps(remoteEnv(started)))).toBe(0)
  const printed = [...out, ...err].join('\n')
  const key = /jpk_[\w-]+/.exec(printed)?.[0]
  if (key === undefined) {
    throw new Error(`no key printed: ${printed}`)
  }
  expect(countOccurrences(printed, key)).toBe(1)
  expect(out).toEqual([
    [
      `Key k2 (pairing p2): ${key}`,
      "This key isn't shown again; store it now.",
      'Pairing code: PAIR-2222',
      'Say PAIR2222 to fake',
      'The key works once someone sends that code to the bot.',
    ].join('\n'),
  ])
  expect(err).toEqual([])
})

test('key create for a paired pairing prints no code', async () => {
  const started = await start()
  expect(await runKeyCreate({ sameAs: 'k1' }, createDeps(remoteEnv(started)))).toBe(0)
  expect(out).toEqual([
    expect.stringMatching(
      /^Key k2 \(pairing p1\): jpk_\S+\nThis key isn't shown again; store it now\.$/,
    ),
  ])
})

test('key create --json prints the created key as JSON and the note on stderr', async () => {
  const started = await start()
  expect(await runKeyCreate({ pairing: 'p1', json: true }, createDeps(remoteEnv(started)))).toBe(0)
  expect(JSON.parse(out.join('\n'))).toEqual({
    id: 'k2',
    key: expect.stringMatching(/^jpk_/),
    pairing: 'p1',
  })
  expect(err).toEqual(["This key isn't shown again; store it now."])
})

test('key create needs exactly one of --bot, --pairing and --same-as', async () => {
  const deps = createDeps({ HOME: tmp })
  expect(await runKeyCreate({}, deps)).toBe(2)
  expect(await runKeyCreate({ bot: 'b1', pairing: 'p1' }, deps)).toBe(2)
  expect(err).toEqual([
    'give exactly one of --bot, --pairing and --same-as',
    'give exactly one of --bot, --pairing and --same-as',
  ])
  expect(out).toEqual([])
})

test('JAYPOST_URL without JAYPOST_ADMIN_KEY fails with a hint and no request', async () => {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(String(request.url))
    response.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    const deps = createDeps({ HOME: tmp, JAYPOST_URL: `http://127.0.0.1:${port}` })
    expect(await runBotList({}, deps)).toBe(1)
    expect(await runBotAdd({}, deps)).toBe(1)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  expect(err).toEqual([
    'JAYPOST_URL is set, so set JAYPOST_ADMIN_KEY too',
    'JAYPOST_URL is set, so set JAYPOST_ADMIN_KEY too',
  ])
  expect(requests).toEqual([])
})

test('an invalid JAYPOST_ADMIN_KEY fails without quoting it', async () => {
  const deps = createDeps({
    HOME: tmp,
    JAYPOST_URL: 'http://127.0.0.1:1',
    JAYPOST_ADMIN_KEY: 'not-a-key',
  })
  expect(await runBotList({}, deps)).toBe(1)
  expect(err).toEqual(["JAYPOST_ADMIN_KEY isn't a valid jaypost admin key"])
})

test('a wrong admin key says the service rejected it', async () => {
  const started = await start()
  const env = { ...remoteEnv(started), JAYPOST_ADMIN_KEY: `jpa_${'z'.repeat(43)}` }
  expect(await runBotList({}, createDeps(env))).toBe(1)
  expect(err).toEqual([ADMIN_KEY_REJECTED_MESSAGE])
})

test('bot add writes the registry directly when the local service is down', async () => {
  const configPath = join(tmp, 'cfg', 'jaypost', 'service', 'config.json')
  writeTokenFile(resolveAdminKeyPath(configPath), `jpa_${'k'.repeat(43)}`)
  const env = {
    HOME: tmp,
    XDG_CONFIG_HOME: join(tmp, 'cfg'),
    JAYPOST_PORT: String(await freePort()),
  }
  const deps = createDeps(env)
  expect(await runBotAdd({ label: 'ci' }, deps)).toBe(0)
  expect(out).toEqual(['Added bot b1 (Fake).'])
  expect(err).toEqual(["The service isn't running; it starts the bot on its next start."])
  expect(readRegistry(configPath).bots).toEqual([
    {
      id: 'b1',
      provider: 'fake',
      settings: { fakeKey: NEW_BOT_TOKEN },
      label: 'ci',
      createdAt: '2026-10-26T12:00:00.000Z',
    },
  ])
  expect(statSync(resolveDatabasePath(configPath)).mode & 0o777).toBe(0o600)
  expect([...out, ...err].join('\n')).not.toContain(NEW_BOT_TOKEN)
})

test('bot add writes the registry when no admin key exists and nothing answers', async () => {
  const configPath = join(tmp, 'cfg', 'jaypost', 'service', 'config.json')
  const port = await freePort()
  const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, 'cfg'), JAYPOST_PORT: String(port) }
  const deps = createDeps(env)
  expect(await runBotAdd({ json: true }, deps)).toBe(0)
  expect(deps.fetchStatus).toHaveBeenCalledWith(new URL(`http://127.0.0.1:${port}/`), undefined)
  expect(JSON.parse(out.join('\n'))).toEqual({ bot: { id: 'b1', provider: 'fake' } })
  expect(readRegistry(configPath).bots).toHaveLength(1)
})

test('bot add without an admin key refuses the registry when the service starts meanwhile', async () => {
  const configPath = join(tmp, 'cfg', 'jaypost', 'service', 'config.json')
  const env = {
    HOME: tmp,
    XDG_CONFIG_HOME: join(tmp, 'cfg'),
    JAYPOST_PORT: String(await freePort()),
  }
  const fetchStatus = vi
    .fn<FetchStatus>()
    .mockResolvedValueOnce(UNREACHABLE_STATUS)
    .mockResolvedValue({ kind: 'unauthorized' })
  expect(await runBotAdd({}, createDeps(env, { fetchStatus }))).toBe(1)
  expect(err).toEqual([
    'The service started while the settings were asked, so nothing was written. Run jaypost bot add again.',
  ])
  expect(fetchStatus).toHaveBeenCalledTimes(2)
  expect(readRegistry(configPath).bots).toEqual([])
})

test('bot add with an admin key uses the api when the service starts meanwhile', async () => {
  const directory = join(tmp, 'cfg', 'jaypost', 'service')
  const configPath = join(directory, 'config.json')
  mkdirSync(directory, { recursive: true })
  const adminKey = `jpa_${'k'.repeat(43)}`
  writeTokenFile(resolveAdminKeyPath(configPath), adminKey)
  const port = await freePort()
  const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, 'cfg'), JAYPOST_PORT: String(port) }
  // The service comes up while the bot token is asked for, seeded from a config of its own.
  const password = vi.fn(async () => {
    writeFileSync(configPath, JSON.stringify({ provider: 'fake', fakeKey: SEED_BOT_TOKEN }))
    running = await startService({
      version: '1.2.3',
      configPath,
      providers: PROVIDERS,
      seed: loadSeed({ JAYPOST_CONFIG: configPath }, PROVIDERS),
      log: vi.fn(),
      generateCode: () => 'PAIR9999',
    })
    await running.started
    await running.server.listen({ port, host: '127.0.0.1' })
    return NEW_BOT_TOKEN
  })
  const deps = createDeps(env, { providers: PROVIDERS, prompt: createPrompts({ password }) })
  expect(await runBotAdd({ provider: 'fake' }, deps)).toBe(0)
  expect(out).toEqual(['Added bot b2 (Fake, fake): running.'])
  await running?.stop()
  running = undefined
  expect(readRegistry(configPath).bots).toEqual([
    expect.objectContaining({ id: 'b1', settings: { fakeKey: SEED_BOT_TOKEN } }),
    expect.objectContaining({ id: 'b2', settings: { fakeKey: NEW_BOT_TOKEN } }),
  ])
})

test('bot add for a native install that never started this version writes its registry', async () => {
  const configPath = join(tmp, 'native', 'config.json')
  writeInstall(paths.installFile, {
    target: 'systemd',
    port: await freePort(),
    version: '1.0.0',
    configFile: configPath,
  })
  const systemd = fakeTarget('systemd', async () => {
    throw new Error('no admin key yet')
  })
  const deps = createDeps({ HOME: tmp }, { targets: targets({ systemd }) })
  expect(await runBotAdd({}, deps)).toBe(0)
  expect(readRegistry(configPath).bots).toEqual([
    expect.objectContaining({ id: 'b1', provider: 'fake' }),
  ])
})

test('bot add refuses the registry while a config file waits to be seeded', async () => {
  const configPath = join(tmp, 'cfg', 'jaypost', 'service', 'config.json')
  mkdirSync(join(tmp, 'cfg', 'jaypost', 'service'), { recursive: true })
  writeFileSync(configPath, JSON.stringify({ provider: 'fake', fakeKey: SEED_BOT_TOKEN }))
  const env = {
    HOME: tmp,
    XDG_CONFIG_HOME: join(tmp, 'cfg'),
    JAYPOST_PORT: String(await freePort()),
  }
  expect(await runBotAdd({}, createDeps(env))).toBe(1)
  expect(err).toEqual([
    "The service isn't running and hasn't set up its registry yet. Start it once, then run jaypost bot add again.",
  ])
  expect(readRegistry(configPath).bots).toEqual([])
})

test('bot add refuses credentials a stored bot already uses, without a server', async () => {
  const env = {
    HOME: tmp,
    XDG_CONFIG_HOME: join(tmp, 'cfg'),
    JAYPOST_PORT: String(await freePort()),
  }
  expect(await runBotAdd({}, createDeps(env))).toBe(0)
  err = []
  expect(await runBotAdd({}, createDeps(env))).toBe(1)
  expect(err).toEqual(['bot b1 already uses these credentials'])
})

test('bot add for a stopped container install says to start it first', async () => {
  writeInstall(paths.installFile, { target: 'compose', port: await freePort(), version: '1.0.0' })
  const compose = fakeTarget('compose', async () => `jpa_${'k'.repeat(43)}`)
  const prompt = createPrompts()
  const deps = createDeps({ HOME: tmp }, { targets: targets({ compose }), prompt })
  expect(await runBotAdd({}, deps)).toBe(1)
  expect(err).toEqual([
    "The compose service isn't running. Start it first, then run jaypost bot add again.",
  ])
  expect(prompt.password).not.toHaveBeenCalled()
})

test('bot add goes through the admin API when the service answers', async () => {
  const started = await start()
  const deps = createDeps(remoteEnv(started), { providers: PROVIDERS })
  expect(await runBotAdd({ provider: 'fake', label: 'ci' }, deps)).toBe(0)
  expect(out).toEqual(['Added bot b2 (Fake, fake): running.'])
  expect([...out, ...err].join('\n')).not.toContain(NEW_BOT_TOKEN)
  expect(readRegistry(started.configPath).bots).toEqual([
    expect.objectContaining({ id: 'b1' }),
    expect.objectContaining({ id: 'b2', label: 'ci', settings: { fakeKey: NEW_BOT_TOKEN } }),
  ])
})

test('bot add shows the service refusing duplicate credentials', async () => {
  const started = await start()
  const prompt = createPrompts({ password: vi.fn(async () => SEED_BOT_TOKEN) })
  const deps = createDeps(remoteEnv(started), { providers: PROVIDERS, prompt })
  expect(await runBotAdd({ provider: 'fakepair' }, deps)).toBe(1)
  expect(err).toEqual(['bot b1 already uses these credentials'])
})

test('bot add with an unknown provider fails', async () => {
  const started = await start()
  expect(await runBotAdd({ provider: 'nope' }, createDeps(remoteEnv(started)))).toBe(1)
  expect(err).toEqual(['Unknown provider "nope".'])
})

test('a container install reads the admin key through the target', async () => {
  const started = await start()
  const record: InstallRecord = { target: 'quadlet', port: started.port, version: '1.0.0' }
  writeInstall(paths.installFile, record)
  const quadlet = fakeTarget('quadlet', async () => started.adminKey)
  const deps = createDeps({ HOME: tmp }, { targets: targets({ quadlet }) })
  expect(await runBotList({}, deps)).toBe(0)
  expect(quadlet.readAdminKey).toHaveBeenCalledWith(record)
  expect(out).toEqual([
    [
      'ID  PROVIDER  LABEL  ACCOUNT  STATE    PAIRINGS  KEYS',
      'b1  fakepair  -      fake     running  1         1',
    ].join('\n'),
  ])
})

test('a container install whose key can not be read says why', async () => {
  writeInstall(paths.installFile, { target: 'compose', port: 1, version: '1.0.0' })
  const compose = fakeTarget('compose', async () => {
    throw new Error("couldn't read the admin key from the container: boom")
  })
  expect(await runBotList({}, createDeps({ HOME: tmp }, { targets: targets({ compose }) }))).toBe(1)
  expect(err).toEqual(["couldn't read the admin key from the container: boom"])
})

test('JAYPOST_ADMIN_KEY wins over the target for a local install', async () => {
  const started = await start()
  writeInstall(paths.installFile, { target: 'compose', port: started.port, version: '1.0.0' })
  const compose = fakeTarget('compose', async () => 'unused')
  const env = { HOME: tmp, JAYPOST_ADMIN_KEY: started.adminKey }
  expect(await runBotList({ json: true }, createDeps(env, { targets: targets({ compose }) }))).toBe(
    0,
  )
  expect(err).toEqual([])
  expect(compose.readAdminKey).not.toHaveBeenCalled()
})

test('with no install the admin key file and port come from the config', async () => {
  const started = await start()
  const env = { HOME: tmp, JAYPOST_CONFIG: started.configPath, JAYPOST_PORT: String(started.port) }
  expect(await runBotList({ json: true }, createDeps(env))).toBe(0)
  expect(JSON.parse(out.join('\n'))).toEqual({
    bots: [
      {
        id: 'b1',
        provider: 'fakepair',
        displayName: 'fake',
        state: 'running',
        pairingCount: 1,
        keyCount: 1,
      },
    ],
  })
})

test('with no install and no admin key file the hint says to start the service', async () => {
  const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, 'cfg') }
  expect(await runBotList({}, createDeps(env))).toBe(1)
  expect(err).toEqual([
    `no admin key in ${JSON.stringify(join(tmp, 'cfg', 'jaypost', 'service', 'admin-key'))} yet; start the service once so it writes one`,
  ])
})

test('bot remove says how many keys go and asks first', async () => {
  const started = await start()
  const confirm = vi.fn(async () => false)
  const deps = createDeps(remoteEnv(started), { prompt: createPrompts({ confirm }) })
  expect(await runBotRemove({ id: 'b1' }, deps)).toBe(0)
  expect(confirm).toHaveBeenCalledWith(
    'Remove bot b1 (fake)? This removes 1 pairing and revokes 1 key.',
    false,
  )
  expect(err).toEqual(['Nothing removed.'])
  confirm.mockResolvedValue(true)
  expect(await runBotRemove({ id: 'b1' }, deps)).toBe(0)
  expect(out).toEqual(['Removed bot b1 and 1 key (k1).'])
})

test('bot remove of an unknown bot fails before asking', async () => {
  const started = await start()
  const confirm = vi.fn(async () => true)
  const deps = createDeps(remoteEnv(started), { prompt: createPrompts({ confirm }) })
  expect(await runBotRemove({ id: 'b9' }, deps)).toBe(1)
  expect(err).toEqual(['unknown bot "b9"'])
  expect(confirm).not.toHaveBeenCalled()
})

test('bot remove --yes skips the question', async () => {
  const started = await start()
  const confirm = vi.fn(async () => false)
  const deps = createDeps(remoteEnv(started), { prompt: createPrompts({ confirm }) })
  expect(await runBotRemove({ id: 'b1', yes: true, json: true }, deps)).toBe(0)
  expect(confirm).not.toHaveBeenCalled()
  expect(JSON.parse(out.join('\n'))).toEqual({ removedKeys: ['k1'] })
})

test('pairing create prints the code and pairing list shows it', async () => {
  const started = await start()
  const deps = createDeps(remoteEnv(started))
  expect(await runPairingCreate({ bot: 'b1' }, deps)).toBe(0)
  expect(await runPairingList({ bot: 'b1' }, deps)).toBe(0)
  expect(out).toEqual([
    'Pairing p2 on bot b1.\nPairing code: PAIR-2222\nSay PAIR2222 to fake',
    [
      'ID  BOT  STATE    PERSON  CODE       KEYS',
      'p1  b1   paired   u1      -          k1',
      'p2  b1   pending  -       PAIR-2222  -',
    ].join('\n'),
  ])
})

test('pairing remove says how many keys it revokes and asks first', async () => {
  const started = await start()
  const confirm = vi.fn(async () => true)
  const deps = createDeps(remoteEnv(started), { prompt: createPrompts({ confirm }) })
  expect(await runPairingRemove({ id: 'p1' }, deps)).toBe(0)
  expect(confirm).toHaveBeenCalledWith('Remove pairing p1 on bot b1? This revokes 1 key.', false)
  expect(out).toEqual(['Removed pairing p1 and revoked 1 key (k1).'])
})

test('key list, label and revoke', async () => {
  const started = await start()
  const deps = createDeps(remoteEnv(started))
  expect(await runKeyCreate({ sameAs: 'k1', label: 'ci', externalId: 'user-7' }, deps)).toBe(0)
  out = []
  expect(await runKeyLabel({ id: 'k2', label: '', externalId: 'user-8' }, deps)).toBe(0)
  expect(await runKeyRevoke({ id: 'k1' }, deps)).toBe(0)
  expect(await runKeyList({ pairing: 'p1' }, deps)).toBe(0)
  expect(out).toEqual([
    'ID  BOT  PAIRING  LABEL  EXTERNAL ID  CREATED\n' +
      `k2  b1   p1       -      user-8       ${new Date().toISOString().slice(0, 10)}`,
    'Revoked key k1.',
    'ID  BOT  PAIRING  LABEL  EXTERNAL ID  CREATED\n' +
      `k2  b1   p1       -      user-8       ${new Date().toISOString().slice(0, 10)}`,
  ])
})

test('key label needs a field to change', async () => {
  expect(await runKeyLabel({ id: 'k1' }, createDeps({ HOME: tmp }))).toBe(2)
  expect(err).toEqual(['give --label, --external-id or both (an empty value clears it)'])
})

test('key revoke of an unknown key prints the service error', async () => {
  const started = await start()
  expect(await runKeyRevoke({ id: 'k9' }, createDeps(remoteEnv(started)))).toBe(1)
  expect(err).toEqual(['unknown key "k9"'])
})

test('key list with no keys says so', async () => {
  const started = await start()
  const deps = createDeps(remoteEnv(started))
  expect(await runKeyRevoke({ id: 'k1' }, deps)).toBe(0)
  out = []
  expect(await runKeyList({}, deps)).toBe(0)
  expect(out).toEqual(['No keys.'])
})

test('admin-key rotate locally prints the new key, which the service saved', async () => {
  const started = await start()
  const env = { HOME: tmp, JAYPOST_CONFIG: started.configPath, JAYPOST_PORT: String(started.port) }
  expect(await runAdminKeyRotate({}, createDeps(env))).toBe(0)
  const saved = readFileSync(resolveAdminKeyPath(started.configPath), 'utf8').trim()
  expect(saved).not.toBe(started.adminKey)
  expect(out).toEqual([`New admin key: ${saved}`])
  expect(err).toEqual([
    'The old admin key stopped working. The service saved the new one to its admin key file, where commands on this machine find it.',
  ])
  expect(await runBotList({}, createDeps(env))).toBe(0)
})

test('admin-key rotate --json prints the new key and the old one stops working', async () => {
  const started = await start()
  expect(await runAdminKeyRotate({ json: true }, createDeps(remoteEnv(started)))).toBe(0)
  expect(JSON.parse(out.join('\n'))).toEqual({ adminKey: expect.stringMatching(/^jpa_/) })
  out = []
  err = []
  expect(await runAdminKeyRotate({}, createDeps(remoteEnv(started)))).toBe(1)
  expect(err).toEqual([ADMIN_KEY_REJECTED_MESSAGE])
})

test('admin-key rotate with JAYPOST_ADMIN_KEY set says to update it', async () => {
  const started = await start()
  expect(await runAdminKeyRotate({}, createDeps(remoteEnv(started)))).toBe(0)
  expect(err).toEqual([
    'The old admin key stopped working.',
    'Set JAYPOST_ADMIN_KEY to the new key.',
  ])
})

test('admin-key show prints the key file next to the config', async () => {
  const configPath = join(tmp, 'data', 'config.json')
  const key = `jpa_${'k'.repeat(43)}`
  writeTokenFile(resolveAdminKeyPath(configPath), key)
  const print = vi.fn()
  const printError = vi.fn()
  expect(runAdminKeyShow({ JAYPOST_CONFIG: configPath }, print, printError)).toBe(0)
  expect(print).toHaveBeenCalledWith(key)
  expect(printError).not.toHaveBeenCalled()
})

test('admin-key show fails without the file or with an invalid one, never quoting it', () => {
  const configPath = join(tmp, 'data', 'config.json')
  const keyPath = resolveAdminKeyPath(configPath)
  const print = vi.fn()
  const printError = vi.fn()
  expect(runAdminKeyShow({ JAYPOST_CONFIG: configPath }, print, printError)).toBe(1)
  mkdirSync(join(tmp, 'data'), { recursive: true })
  writeFileSync(keyPath, 'garbage\n')
  expect(runAdminKeyShow({ JAYPOST_CONFIG: configPath }, print, printError)).toBe(1)
  expect(print).not.toHaveBeenCalled()
  expect(printError.mock.calls).toEqual([
    [`no admin key in ${JSON.stringify(keyPath)} yet; start the service once so it writes one`],
    [`admin key file ${JSON.stringify(keyPath)} isn't a valid jaypost admin key`],
  ])
})
