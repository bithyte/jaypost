import { expect, test, vi } from 'vite-plus/test'
import { OWNER_COMMANDS } from '@jaypost/core'
import type { RuntimeHandlers } from '@jaypost/core'
import { REJECTED_BOT_TOKEN_FATAL, createSlackRuntime } from '../../src/slack/index.ts'
import { createFakeSlack } from './fake.ts'
import type { FakeSlack } from './fake.ts'

const BOT_TOKEN = 'xoxb-secret'
const APP_TOKEN = 'xapp-secret'

function handlers(overrides: Pick<RuntimeHandlers, 'pair'> = {}) {
  return {
    answer: vi.fn(() => 'accepted' as const),
    reply: vi.fn(() => 'accepted' as const),
    dismiss: vi.fn(() => true),
    commands: OWNER_COMMANDS,
    command: vi.fn(() => undefined),
    fatal: vi.fn<(message: string) => void>(),
    ...overrides,
  }
}

function setup(fake: FakeSlack = createFakeSlack(), settings: Record<string, string> = {}) {
  const log = vi.fn<(line: string) => void>()
  const createClient = vi.fn((_botToken: string, _appToken: string) => fake.client)
  const runtime = createSlackRuntime(
    { botToken: BOT_TOKEN, appToken: APP_TOKEN, ...settings },
    log,
    createClient,
  )
  return { fake, log, createClient, runtime }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

test('checkCredentials reports @botName and the client gets both tokens', async () => {
  const { runtime, createClient } = setup()
  expect(await runtime.checkCredentials()).toEqual({ ok: true, displayName: '@jaypost' })
  expect(createClient).toHaveBeenCalledWith(BOT_TOKEN, APP_TOKEN)
})

test('each failed check has its own reason, without a token', async () => {
  const reasons = []
  for (const identity of [
    { kind: 'missingScopes', scopes: ['im:write', 'files:write'] },
    { kind: 'rejected', token: 'bot', error: 'invalid_auth' },
    { kind: 'rejected', token: 'app', error: 'not_allowed_token_type' },
    { kind: 'unreachable' },
  ] as const) {
    const { runtime } = setup(createFakeSlack({ getIdentity: async () => identity }))
    reasons.push(await runtime.checkCredentials())
  }
  expect(reasons).toEqual([
    {
      ok: false,
      reason:
        'the Slack bot token lacks im:write, files:write; add the scopes from the app manifest and reinstall the app',
    },
    {
      ok: false,
      reason: 'Slack rejected the bot token (invalid_auth); check it with `jaypost init`',
    },
    {
      ok: false,
      reason:
        'Slack rejected the app-level token (not_allowed_token_type); check it with `jaypost init`',
    },
    { ok: false, reason: 'could not reach Slack to verify the tokens' },
  ])
  expect(JSON.stringify(reasons)).not.toMatch(/xoxb-|xapp-/)
})

test('pairing instructions link to the app and show the dashed code', async () => {
  const { runtime } = setup()
  await runtime.checkCredentials()
  expect(runtime.pairingInstructions?.('ABCDEFGH')).toBe(
    'Open https://slack.com/app_redirect?app=A1&team=T1 (or @jaypost under Apps in Slack) and send "ABCD-EFGH" in its Messages tab',
  )
  expect(runtime.approverPairingInstructions?.('ABCDEFGH')).toBe(
    'Have them open @jaypost under Apps in your Slack workspace and send "ABCD-EFGH" in its Messages tab',
  )
})

test('start connects and logs once the socket is ready', async () => {
  const { fake, log, runtime } = setup()
  await runtime.checkCredentials()
  runtime.start(handlers())
  expect(fake.connectCalls()).toBe(1)
  fake.events()?.ready()
  expect(log.mock.calls).toEqual([['app @jaypost connected']])
})

test('start before a successful checkCredentials throws', () => {
  const { fake, runtime } = setup()
  expect(() => runtime.start(handlers())).toThrow(Error)
  expect(fake.connectCalls()).toBe(0)
})

test('socket events reach the handlers through the conversation', async () => {
  const { fake, runtime } = setup(createFakeSlack(), { ownerId: 'U1' })
  const runtimeHandlers = handlers()
  await runtime.checkCredentials()
  runtime.start(runtimeHandlers)
  await runtime.sendRequest('r1', { text: 'Q', spans: [] }, ['a'], true, undefined, undefined)
  fake.events()?.action({
    userId: 'U1',
    channelId: 'D1',
    messageTs: '1.0',
    isDirect: true,
    actionId: 'r1:0',
  })
  fake.events()?.message({
    channelId: 'D1',
    ts: '2.0',
    fromId: 'U1',
    fromBot: false,
    isDirect: true,
    text: 'typed',
    thread: { ts: '1.0', parentUserId: 'UBOT' },
  })
  fake.events()?.command({ userId: 'U1', channelId: 'D1', isDirect: true, text: 'pending' })
  await flush()
  expect(runtimeHandlers.answer).toHaveBeenCalledWith('r1', 0)
  expect(runtimeHandlers.reply).toHaveBeenCalledWith('r1', 'typed')
  expect(runtimeHandlers.command).toHaveBeenCalledWith('pending', '')
})

test('a socket fatal reaches handlers.fatal until stop', async () => {
  const { fake, runtime } = setup()
  const runtimeHandlers = handlers()
  await runtime.checkCredentials()
  runtime.start(runtimeHandlers)
  fake.events()?.fatal(REJECTED_BOT_TOKEN_FATAL)
  await runtime.stop()
  fake.events()?.fatal('later')
  expect(runtimeHandlers.fatal.mock.calls).toEqual([[REJECTED_BOT_TOKEN_FATAL]])
  expect(fake.destroyCalls()).toBe(1)
})

test('a failing destroy does not make stop reject', async () => {
  const { runtime } = setup(
    createFakeSlack({
      destroy: async () => {
        throw new Error('boom')
      },
    }),
  )
  await expect(runtime.stop()).resolves.toBeUndefined()
})
