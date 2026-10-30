import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import { decodeInvite, readInbox, writeInbox } from '@jaypost/store'
import type { Inbox } from '@jaypost/store'
import { resolveInstallPaths } from '@jaypost/install'
import type { Target, TargetName } from '@jaypost/install'
import { runKeyCreate } from '../../src/commands/index.ts'
import type { AdminDeps, Prompts } from '../../src/commands/index.ts'
import { UNREACHABLE_STATUS } from '../../src/commands/constants.ts'

const ADMIN_KEY = `jpa_${'a'.repeat(43)}`
const KEY = `jpk_${'n'.repeat(43)}`
const CREATED = {
  id: 'k2',
  key: KEY,
  pairing: 'p2',
  code: 'PAIR-2222',
  instructions: 'Say PAIR2222 to workbot',
}
const BOTS = {
  bots: [
    {
      id: 'b2',
      provider: 'fake',
      label: 'Work',
      displayName: 'workbot',
      state: 'running',
      pairingCount: 1,
      keyCount: 1,
    },
  ],
}
const KEYS = {
  keys: [{ id: 'k1', pairing: 'p2', bot: 'b2', createdAt: '2026-10-29T00:00:00.000Z' }],
}
const PAIRINGS = {
  pairings: [{ id: 'p2', bot: 'b2', person: 'u1', state: 'paired', keys: ['k1'] }],
}
const KEY_LINES = [
  `Key k2 (pairing p2): ${KEY}`,
  "This key isn't shown again; store it now.",
  'Pairing code: PAIR-2222',
  'Say PAIR2222 to workbot',
  'The key works once someone sends that code to the bot.',
].join('\n')

let tmp: string
let inboxPath: string
let server: Server
let url: string
let seen: string[]
let out: string[]
let err: string[]

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'key-cli-'))
  inboxPath = join(tmp, 'inbox.json')
  seen = []
  out = []
  err = []
  server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`)
    request.resume()
    request.on('end', () => {
      response.setHeader('content-type', 'application/json')
      if (request.headers.authorization !== `Bearer ${ADMIN_KEY}`) {
        response.statusCode = 401
        response.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      const routes: Record<string, unknown> = {
        'POST /admin/keys': CREATED,
        'GET /admin/keys': KEYS,
        'GET /admin/bots': BOTS,
        'GET /admin/pairings': PAIRINGS,
      }
      response.end(JSON.stringify(routes[`${request.method} ${request.url}`] ?? {}))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function unusedTargets(): Readonly<Record<TargetName, Target>> {
  const target = { readAdminKey: vi.fn() } as unknown as Target
  return { quadlet: target, compose: target, systemd: target, launchd: target }
}

function createPrompts(over: Partial<Prompts> = {}): Prompts {
  return {
    confirm: vi.fn(async () => true),
    password: vi.fn(async () => ''),
    text: vi.fn(async () => ''),
    select: vi.fn(async (_message, _options, initialValue) => initialValue),
    ...over,
  }
}

/** Deps whose inbox holds the fake service as remote `x`, picked with -s. */
function createDeps(over: Partial<AdminDeps> = {}): AdminDeps {
  return {
    env: { HOME: tmp },
    paths: resolveInstallPaths({ HOME: tmp, XDG_CONFIG_HOME: join(tmp, 'cfg') }),
    targets: unusedTargets(),
    providers: [],
    prompt: createPrompts(),
    print: (text) => out.push(text),
    printError: (text) => err.push(text),
    fetchStatus: async () => UNREACHABLE_STATUS,
    inboxPath,
    service: 'x',
    isInteractive: false,
    ...over,
  }
}

function writeRemoteInbox(bots: Inbox['bots'] = []): Inbox {
  const inbox: Inbox = {
    version: 1,
    ...(bots[0] === undefined ? {} : { default: bots[0].alias }),
    remotes: [{ name: 'x', url, adminKey: ADMIN_KEY }],
    bots,
  }
  writeInbox(inboxPath, inbox)
  return inbox
}

test('key create prints the key and leaves the inbox alone', async () => {
  const inbox = writeRemoteInbox()
  expect(await runKeyCreate({ bot: 'b2' }, createDeps())).toBe(0)
  expect(out).toEqual([KEY_LINES])
  expect(err).toEqual([])
  expect(readInbox(inboxPath)).toEqual(inbox)
})

test("key create --save stores the key under the bot's label", async () => {
  writeRemoteInbox()
  expect(await runKeyCreate({ sameAs: 'k1', save: true }, createDeps())).toBe(0)
  expect(out).toEqual([KEY_LINES, 'Saved as "Work" in your inbox.'])
  expect(readInbox(inboxPath)).toEqual({
    version: 1,
    default: 'Work',
    remotes: [{ name: 'x', url, adminKey: ADMIN_KEY }],
    bots: [{ alias: 'Work', url, key: KEY }],
  })
  expect(seen).toEqual(['GET /admin/keys', 'GET /admin/bots', 'POST /admin/keys'])
})

test("key create --save --pairing finds the pairing's bot before making the key", async () => {
  writeRemoteInbox()
  expect(await runKeyCreate({ pairing: 'p2', save: true }, createDeps())).toBe(0)
  expect(out.at(-1)).toBe('Saved as "Work" in your inbox.')
  expect(seen).toEqual(['GET /admin/pairings', 'GET /admin/bots', 'POST /admin/keys'])
})

test('key create --save for an unknown pairing fails before making a key', async () => {
  const inbox = writeRemoteInbox()
  expect(await runKeyCreate({ pairing: 'p9', save: true }, createDeps())).toBe(1)
  expect(err).toEqual(['unknown pairing "p9"'])
  expect(seen).toEqual(['GET /admin/pairings'])
  expect(readInbox(inboxPath)).toEqual(inbox)
})

test('key create --save keeps a label with spaces and unicode as the alias', async () => {
  writeRemoteInbox()
  expect(await runKeyCreate({ bot: 'b2', save: true, as: 'Équipe ops 🚀' }, createDeps())).toBe(0)
  expect(readInbox(inboxPath).bots).toEqual([{ alias: 'Équipe ops 🚀', url, key: KEY }])
})

test('key create --save --as uses the alias and keeps the default', async () => {
  writeRemoteInbox([{ alias: 'home', url: 'http://127.0.0.1:1/' }])
  expect(await runKeyCreate({ bot: 'b2', save: true, as: 'ops' }, createDeps())).toBe(0)
  expect(out.at(-1)).toBe('Saved as "ops" in your inbox.')
  expect(readInbox(inboxPath)).toEqual(
    expect.objectContaining({
      default: 'home',
      bots: [
        { alias: 'home', url: 'http://127.0.0.1:1/' },
        { alias: 'ops', url, key: KEY },
      ],
    }),
  )
})

test('key create --save --as fails off a terminal when the alias is taken', async () => {
  const inbox = writeRemoteInbox([{ alias: 'ops', url: 'http://127.0.0.1:1/' }])
  expect(await runKeyCreate({ bot: 'b2', save: true, as: 'OPS' }, createDeps())).toBe(1)
  expect(err).toEqual(['a bot is already named "OPS"; pick another with --as'])
  expect(seen).toEqual([])
  expect(readInbox(inboxPath)).toEqual(inbox)
})

test('key create --save asks before replacing an alias on a terminal', async () => {
  writeRemoteInbox([{ alias: 'Work', url: 'http://127.0.0.1:1/' }])
  const confirm = vi.fn(async () => true)
  const deps = createDeps({ isInteractive: true, prompt: createPrompts({ confirm }) })
  expect(await runKeyCreate({ bot: 'b2', save: true }, deps)).toBe(0)
  expect(confirm).toHaveBeenCalledWith('Replace "Work" in your inbox?', false)
  expect(readInbox(inboxPath).bots).toEqual([{ alias: 'Work', url, key: KEY }])
})

test('key create --save off a terminal with a taken label makes no key and prints nothing', async () => {
  const inbox = writeRemoteInbox([{ alias: 'work', url: 'http://127.0.0.1:1/' }])
  expect(await runKeyCreate({ bot: 'b2', save: true }, createDeps())).toBe(1)
  expect(out).toEqual([])
  expect(err).toEqual(['a bot is already named "Work"; pick another with --as'])
  expect(seen).toEqual(['GET /admin/bots'])
  expect(readInbox(inboxPath)).toEqual(inbox)
})

test('key create --save declined on a terminal makes no key', async () => {
  const inbox = writeRemoteInbox([{ alias: 'Work', url: 'http://127.0.0.1:1/' }])
  const confirm = vi.fn(async () => false)
  const deps = createDeps({ isInteractive: true, prompt: createPrompts({ confirm }) })
  expect(await runKeyCreate({ bot: 'b2', save: true }, deps)).toBe(1)
  expect(err).toEqual(['Cancelled.'])
  expect(out).toEqual([])
  expect(seen).toEqual(['GET /admin/bots'])
  expect(readInbox(inboxPath)).toEqual(inbox)
})

test('key create --save --json keeps stdout parseable', async () => {
  writeRemoteInbox()
  expect(await runKeyCreate({ bot: 'b2', save: true, json: true }, createDeps())).toBe(0)
  expect(JSON.parse(out.join('\n'))).toEqual(CREATED)
  expect(err).toEqual([
    "This key isn't shown again; store it now.",
    'Saved as "Work" in your inbox.',
  ])
})

test('key create --invite prints a join line that decodes to the remote url and key', async () => {
  const inbox = writeRemoteInbox()
  expect(await runKeyCreate({ bot: 'b2', label: 'alice', invite: true }, createDeps())).toBe(0)
  const printed = out.join('\n')
  const invite = /jaypost inbox join (jpi_\S+)/.exec(printed)?.[1]
  if (invite === undefined) {
    throw new Error(`no invite printed: ${printed}`)
  }
  expect(decodeInvite(invite)).toEqual({ url, key: KEY })
  expect(out).toEqual([
    [
      'Send this to alice (it holds their key, send it privately):',
      '',
      `  jaypost inbox join ${invite}`,
      "This key isn't shown again; store it now.",
      'Pairing code: PAIR-2222',
      'Say PAIR2222 to workbot',
      'The key works once someone sends that code to the bot.',
    ].join('\n'),
  ])
  expect(printed).not.toContain(KEY)
  expect(printed).not.toContain(ADMIN_KEY)
  expect(readInbox(inboxPath)).toEqual(inbox)
})

test('key create --invite without a label sends it to them', async () => {
  writeRemoteInbox()
  expect(await runKeyCreate({ bot: 'b2', invite: true }, createDeps())).toBe(0)
  expect(out[0]?.split('\n')[0]).toBe('Send this to them (it holds their key, send it privately):')
})

test('key create --invite --json adds the invite to the created key', async () => {
  writeRemoteInbox()
  expect(await runKeyCreate({ bot: 'b2', invite: true, json: true }, createDeps())).toBe(0)
  const created = JSON.parse(out.join('\n'))
  expect(created).toEqual({ ...CREATED, invite: expect.stringMatching(/^jpi_/) })
  expect(decodeInvite(created.invite)).toEqual({ url, key: KEY })
})

test('key create --invite against the local service fails', async () => {
  const port = (server.address() as AddressInfo).port
  const deps = createDeps({
    env: { HOME: tmp, JAYPOST_PORT: String(port), JAYPOST_ADMIN_KEY: ADMIN_KEY },
    service: undefined,
  })
  expect(await runKeyCreate({ bot: 'b2', invite: true }, deps)).toBe(1)
  expect(err).toEqual(['invites need a remote; add one with "jaypost admin remote add" and use -s'])
  expect(seen).toEqual([])
  expect(out).toEqual([])
})

test('key create --invite against a loopback JAYPOST_URL fails', async () => {
  const port = (server.address() as AddressInfo).port
  const deps = createDeps({
    env: { HOME: tmp, JAYPOST_URL: `http://127.0.0.1:${port}`, JAYPOST_ADMIN_KEY: ADMIN_KEY },
    service: undefined,
  })
  expect(await runKeyCreate({ bot: 'b2', invite: true }, deps)).toBe(1)
  expect(err).toEqual(['invites need a remote; add one with "jaypost admin remote add" and use -s'])
  expect(seen).toEqual([])
  expect(out).toEqual([])
})

test('key create takes at most one of --save and --invite, and --as only with --save', async () => {
  writeRemoteInbox()
  expect(await runKeyCreate({ bot: 'b2', save: true, invite: true }, createDeps())).toBe(2)
  expect(await runKeyCreate({ bot: 'b2', as: 'ops' }, createDeps())).toBe(2)
  expect(err).toEqual(['give at most one of --save and --invite', 'give --as only with --save'])
  expect(seen).toEqual([])
})

test('key create --save with a corrupt inbox fails before creating the key', async () => {
  writeFileSync(inboxPath, '[]')
  expect(await runKeyCreate({ bot: 'b2', save: true }, createDeps({ service: undefined }))).toBe(1)
  expect(err).toEqual([`inbox ${JSON.stringify(inboxPath)} isn't valid: (root)`])
  expect(seen).toEqual([])
  expect(readFileSync(inboxPath, 'utf8')).toBe('[]')
})
