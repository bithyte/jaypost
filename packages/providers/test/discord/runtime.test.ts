import { EventEmitter } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test, vi } from 'vite-plus/test'
import { OWNER_COMMANDS, PAIRED_REPLY } from '@jaypost/core'
import {
  REJECTED_TOKEN_FATAL,
  createDiscordClient,
  createDiscordRuntime,
  toCommandDefinitions,
} from '../../src/discord/index.ts'
import type { DiscordClient } from '../../src/discord/index.ts'
import type { RuntimeHandlers } from '@jaypost/core'
import { createFakeDiscord } from './fake.ts'
import type { FakeDiscord } from './fake.ts'

const TOKEN = 'SECRET.BOT.TOKEN'

function handlers(overrides: Pick<RuntimeHandlers, 'pair'> = {}) {
  return {
    answer: vi.fn(() => 'accepted' as const),
    reply: vi.fn(() => 'accepted' as const),
    dismiss: vi.fn(() => true),
    isPaired: (senderId: string) => senderId === '5',
    listPaired: () => ['5'],
    commands: OWNER_COMMANDS,
    command: vi.fn(() => undefined),
    fatal: vi.fn<(message: string) => void>(),
    ...overrides,
  }
}

function setup(fake: FakeDiscord = createFakeDiscord(), settings: Record<string, string> = {}) {
  const log = vi.fn<(line: string) => void>()
  const createClient = vi.fn((_token: string) => fake.client)
  const runtime = createDiscordRuntime({ botToken: TOKEN, ...settings }, log, createClient)
  return { fake, log, createClient, runtime }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

const plain = (text: string) => ({ text, spans: [] })

class FakeGateway extends EventEmitter {
  public destroyCount = 0

  public connect(): Promise<void> {
    return Promise.resolve()
  }

  public destroy(): void {
    this.destroyCount += 1
  }
}

/** A real client over a REST server that answers 401 to everything and a fake gateway. */
async function withRejectingDiscord(
  run: (createClient: (token: string) => DiscordClient, gateway: FakeGateway) => Promise<void>,
): Promise<void> {
  const server = http.createServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ message: '401: Unauthorized', code: 0 }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const gateway = new FakeGateway()
  const createClient = (token: string): DiscordClient => ({
    ...createDiscordClient(token, {
      apiRoot: `http://127.0.0.1:${port}/api`,
      timeoutMs: 5000,
      createGateway: () => gateway,
    }),
    getIdentity: async () => ({
      kind: 'ok',
      userId: 'bot1',
      username: 'jaybot',
      applicationId: 'app1',
    }),
    setCommands: async () => {},
  })
  try {
    await run(createClient, gateway)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('checkCredentials reports @username', async () => {
  const { runtime, createClient } = setup()
  expect(await runtime.checkCredentials()).toEqual({ ok: true, displayName: '@jaybot' })
  expect(createClient).toHaveBeenCalledWith(TOKEN)
})

test('a rejected token reason has the status and no token', async () => {
  const { runtime } = setup(
    createFakeDiscord({ getIdentity: async () => ({ kind: 'rejected', status: 401 }) }),
  )
  const check = await runtime.checkCredentials()
  expect(check).toEqual({
    ok: false,
    reason: 'Discord rejected the bot token (401); check it with `jaypost init`',
  })
  expect(JSON.stringify(check)).not.toContain(TOKEN)
})

test('unreachable discord has its own reason', async () => {
  const { runtime } = setup(
    createFakeDiscord({ getIdentity: async () => ({ kind: 'unreachable' }) }),
  )
  expect(await runtime.checkCredentials()).toEqual({
    ok: false,
    reason: 'could not reach Discord to verify the bot token',
  })
})

test('pairing instructions have the invite link and the dashed code', async () => {
  const { runtime } = setup(
    createFakeDiscord({
      getIdentity: async () => ({
        kind: 'ok',
        userId: '111',
        username: 'mybot',
        applicationId: '222',
      }),
    }),
  )
  await runtime.checkCredentials()
  expect(runtime.pairingInstructions?.('ABCDEFGH')).toBe(
    'Invite the bot to a server you\'re in with https://discord.com/oauth2/authorize?client_id=222&scope=bot+applications.commands&permissions=0 then DM "ABCD-EFGH" to @mybot',
  )
  expect(runtime.statusFields).toBeUndefined()
})

test('start registers the owner commands', async () => {
  const { fake, log, runtime } = setup()
  await runtime.checkCredentials()
  runtime.start(handlers())
  await flush()
  expect(fake.commandSets).toEqual([
    { applicationId: 'app1', commands: toCommandDefinitions(OWNER_COMMANDS) },
  ])
  expect(fake.connectCalls()).toBe(1)
  fake.events()?.ready('jaybot')
  expect(log.mock.calls).toEqual([['bot @jaybot connected']])
})

test('start before a successful checkCredentials throws', () => {
  const { fake, runtime } = setup()
  expect(() => runtime.start(handlers())).toThrow(Error)
  expect(fake.connectCalls()).toBe(0)
})

test('a failed command registration is logged and not fatal', async () => {
  const { fake, log, runtime } = setup(
    createFakeDiscord({
      setCommands: async () => {
        throw new Error(`request failed with ${TOKEN}`)
      },
    }),
  )
  const runtimeHandlers = handlers()
  await runtime.checkCredentials()
  runtime.start(runtimeHandlers)
  await flush()
  expect(log.mock.calls).toEqual([['failed to set discord commands']])
  expect(runtimeHandlers.fatal).not.toHaveBeenCalled()
  expect(fake.connectCalls()).toBe(1)
})

test('a gateway fatal reaches handlers.fatal', async () => {
  const { fake, runtime } = setup()
  const runtimeHandlers = handlers()
  await runtime.checkCredentials()
  runtime.start(runtimeHandlers)
  fake.events()?.fatal(REJECTED_TOKEN_FATAL)
  expect(runtimeHandlers.fatal).toHaveBeenCalledWith(REJECTED_TOKEN_FATAL)
})

test('nothing is fatal after stop', async () => {
  const { fake, runtime } = setup()
  const runtimeHandlers = handlers()
  await runtime.checkCredentials()
  runtime.start(runtimeHandlers)
  await runtime.stop()
  expect(fake.destroyCalls()).toBe(1)
  fake.events()?.fatal('discord gateway closed (4014)')
  expect(runtimeHandlers.fatal).not.toHaveBeenCalled()
})

test('stop closes the real gateway and a later close or 401 is not fatal', async () => {
  await withRejectingDiscord(async (createClient, gateway) => {
    const runtime = createDiscordRuntime({ botToken: TOKEN }, vi.fn(), createClient)
    const runtimeHandlers = handlers()
    await runtime.checkCredentials()
    runtime.start(runtimeHandlers)
    await flush()
    await runtime.stop()
    expect(gateway.destroyCount).toBe(1)
    gateway.emit('closed', 4004)
    await expect(
      runtime.sendRequest('r1', plain('Run it?'), ['yes'], false, undefined, '5'),
    ).rejects.toThrow()
    expect(runtimeHandlers.fatal).not.toHaveBeenCalled()
  })
})

test('a rest 401 before stop is fatal without the token', async () => {
  await withRejectingDiscord(async (createClient) => {
    const runtime = createDiscordRuntime({ botToken: TOKEN }, vi.fn(), createClient)
    const runtimeHandlers = handlers()
    await runtime.checkCredentials()
    runtime.start(runtimeHandlers)
    await flush()
    await expect(
      runtime.sendRequest('r1', plain('Run it?'), ['yes'], false, undefined, '5'),
    ).rejects.toThrow()
    expect(runtimeHandlers.fatal).toHaveBeenCalledWith(REJECTED_TOKEN_FATAL)
    expect(JSON.stringify(runtimeHandlers.fatal.mock.calls)).not.toContain(TOKEN)
    await runtime.stop()
  })
})

test('stop swallows a destroy failure', async () => {
  const { runtime } = setup(
    createFakeDiscord({
      destroy: async () => {
        throw new Error('already closed')
      },
    }),
  )
  await runtime.checkCredentials()
  runtime.start(handlers())
  await expect(runtime.stop()).resolves.toBeUndefined()
})

test('gateway messages and interactions reach the handlers', async () => {
  const { fake, runtime } = setup()
  const runtimeHandlers = handlers()
  await runtime.checkCredentials()
  runtime.start(runtimeHandlers)
  const reference = await runtime.sendRequest('r1', plain('Name?'), ['a'], true, undefined, '5')
  expect(reference).toEqual({ channelId: 'dm1', messageId: 'm1', hasButtons: true })
  fake.events()?.message({
    id: 'u1',
    channelId: 'dm1',
    fromId: '5',
    fromBot: false,
    isDirect: true,
    text: 'bob',
    replyTo: { messageId: 'm1', fromId: 'bot1' },
  })
  fake.events()?.interaction({
    kind: 'button',
    id: 'i1',
    token: 'itoken',
    userId: '5',
    isDirect: true,
    customId: 'r1:0',
    channelId: 'dm1',
    messageId: 'm1',
  })
  await flush()
  expect(runtimeHandlers.reply).toHaveBeenCalledWith('r1', 'bob')
  expect(runtimeHandlers.answer).toHaveBeenCalledWith('r1', 0, '5')
  expect(fake.responses.map((entry) => entry.response)).toEqual([{ kind: 'acknowledge' }])
})

test('a throwing event handler is logged without its message', async () => {
  const { fake, log, runtime } = setup()
  const runtimeHandlers = handlers()
  runtimeHandlers.reply.mockImplementation(() => {
    throw new Error(`boom ${TOKEN}`)
  })
  await runtime.checkCredentials()
  runtime.start(runtimeHandlers)
  await runtime.sendRequest('r1', plain('Name?'), ['a'], true, undefined, '5')
  fake.events()?.message({
    id: 'u1',
    channelId: 'dm1',
    fromId: '5',
    fromBot: false,
    isDirect: true,
    text: 'bob',
    replyTo: { messageId: 'm1', fromId: 'bot1' },
  })
  await flush()
  expect(log.mock.calls).toEqual([['discord event handler failed: Error']])
})

test('a request goes to the recipient it names', async () => {
  const { fake, runtime } = setup()
  const pair = vi.fn(() => 'paired' as const)
  await runtime.checkCredentials()
  runtime.start(handlers({ pair }))
  await expect(
    runtime.sendRequest('r1', plain('Run it?'), ['yes'], false, undefined, undefined),
  ).rejects.toThrow('message has no recipient')
  fake.events()?.message({
    id: 'u1',
    channelId: 'dm7',
    fromId: '5',
    fromBot: false,
    isDirect: true,
    text: 'ABCDEFGH',
    replyTo: undefined,
  })
  await flush()
  expect(pair).toHaveBeenCalledWith('5', 'ABCDEFGH')
  expect(fake.created.map((entry) => entry.message.content)).toEqual([PAIRED_REPLY])
  await runtime.sendRequest('r1', plain('Run it?'), ['yes'], false, undefined, '5')
  expect(fake.openedFor).toEqual(['5'])
})
