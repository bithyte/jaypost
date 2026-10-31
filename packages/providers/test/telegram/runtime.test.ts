import { Bot, GrammyError } from 'grammy'
import type { Update, UserFromGetMe } from 'grammy/types'
import { expect, test, vi } from 'vite-plus/test'
import { OWNER_COMMANDS } from '@jaypost/core'
import { createTelegramRuntime } from '../../src/telegram/index.ts'

const TOKEN = '123:secret-token'

function fakeBot(init: () => Promise<void> = async () => {}) {
  let rejectPolling: (error: unknown) => void = () => {}
  const polling = new Promise<void>((_resolve, reject) => {
    rejectPolling = reject
  })
  const registrations: string[] = []
  const on = vi.fn((filter: string) => {
    registrations.push(`on:${filter}`)
  })
  const command = vi.fn((name: string) => {
    registrations.push(`command:${name}`)
  })
  const setMyCommands = vi.fn(async () => true)
  const start = vi.fn((options: { onStart: (botUser: { username: string }) => void }) => {
    options.onStart({ username: 'mybot' })
    return polling
  })
  const stop = vi.fn(async () => {})
  const bot = {
    botInfo: { username: 'mybot' },
    init,
    on,
    catch: vi.fn(),
    command,
    start,
    stop,
    api: { setMyCommands },
  }
  return {
    bot: bot as unknown as Bot,
    on,
    registrations,
    setMyCommands,
    start,
    stop,
    rejectPolling,
  }
}

function handlers(fatal = vi.fn(), pairedIds: readonly string[] = []) {
  return {
    answer: () => 'accepted' as const,
    reply: () => 'accepted' as const,
    dismiss: () => true,
    isPaired: (senderId: string) => pairedIds.includes(senderId),
    listPaired: () => pairedIds,
    commands: OWNER_COMMANDS,
    command: () => undefined,
    fatal,
  }
}

test('checkCredentials reports @username', async () => {
  const { bot } = fakeBot()
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  expect(await runtime.checkCredentials()).toEqual({ ok: true, displayName: '@mybot' })
})

test('rejected token reason has the code and no token', async () => {
  const { bot } = fakeBot(async () => {
    throw new GrammyError(
      `Call to 'getMe' failed! https://api.telegram.org/bot${TOKEN}/getMe`,
      { ok: false, error_code: 401, description: 'Unauthorized' },
      'getMe',
      {},
    )
  })
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  const check = await runtime.checkCredentials()
  expect(check).toEqual({
    ok: false,
    reason: 'Telegram rejected the bot token (401); check it with `jaypost service install`',
  })
  expect(JSON.stringify(check)).not.toContain(TOKEN)
})

test('unreachable reason', async () => {
  const { bot } = fakeBot(async () => {
    throw new Error(`fetch failed for https://api.telegram.org/bot${TOKEN}/getMe`)
  })
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  expect(await runtime.checkCredentials()).toEqual({
    ok: false,
    reason: 'could not reach Telegram to verify the bot token',
  })
})

test('pairingInstructions text is unchanged', async () => {
  const { bot } = fakeBot()
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  await runtime.checkCredentials()
  expect(runtime.pairingInstructions?.('K7QM4XPD')).toBe(
    'Send "/start K7QM-4XPD" to @mybot, or open https://t.me/mybot?start=K7QM4XPD',
  )
  expect(runtime.statusFields?.()).toEqual({ bot: 'mybot' })
})

test('start registers taps, then commands, then messages', () => {
  const { bot, registrations } = fakeBot()
  const log = vi.fn()
  const runtime = createTelegramRuntime({ botToken: TOKEN }, log, () => bot)
  runtime.start({ ...handlers(), pair: () => 'wrong' })
  expect(log).toHaveBeenCalledWith('bot @mybot polling')
  expect(registrations).toEqual([
    'on:callback_query:data',
    'command:pending',
    'command:cancel',
    'command:history',
    'on:message',
  ])
})

test('409 calls fatal with the old message', async () => {
  const { bot, rejectPolling } = fakeBot()
  const fatal = vi.fn()
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  runtime.start(handlers(fatal))
  rejectPolling(
    new GrammyError(
      'conflict',
      { ok: false, error_code: 409, description: 'Conflict' },
      'getUpdates',
      {},
    ),
  )
  await vi.waitFor(() =>
    expect(fatal).toHaveBeenCalledWith('another instance is already polling with this bot token'),
  )
})

test('other polling errors call fatal with bot stopped', async () => {
  const { bot, rejectPolling } = fakeBot()
  const fatal = vi.fn()
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  runtime.start(handlers(fatal))
  rejectPolling(new Error('boom'))
  await vi.waitFor(() => expect(fatal).toHaveBeenCalledWith('bot stopped: boom'))
})

test('polling ending after stop is not fatal', async () => {
  const { bot, stop, rejectPolling } = fakeBot()
  const fatal = vi.fn()
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  runtime.start(handlers(fatal))
  await runtime.stop()
  expect(stop).toHaveBeenCalledTimes(1)
  rejectPolling(new Error('aborted'))
  await new Promise((resolve) => setImmediate(resolve))
  expect(fatal).not.toHaveBeenCalled()
})

test('stop never rejects', async () => {
  const { bot, stop } = fakeBot()
  stop.mockRejectedValueOnce(new Error('not running'))
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  await expect(runtime.stop()).resolves.toBeUndefined()
})

test('requests go to the recipient they name', async () => {
  const { bot } = fakeBot()
  const sendMessage = vi.fn(async () => ({ message_id: 5, chat: { id: 9 } }))
  ;(bot as unknown as { api: object }).api = { sendMessage, setMyCommands: vi.fn(async () => true) }
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  runtime.start(handlers())
  await expect(
    runtime.sendRequest('id1', { text: 'Q', spans: [] }, ['Yes'], false, undefined, undefined),
  ).rejects.toThrow('message has no recipient')
  expect(
    await runtime.sendRequest('id1', { text: 'Q', spans: [] }, ['Yes'], false, undefined, '9'),
  ).toEqual({
    chatId: 9,
    messageId: 5,
    hasButtons: true,
  })
  expect(sendMessage).toHaveBeenCalledTimes(1)
})

test('setMyCommands sets the chat scope of everyone already paired', () => {
  const { bot, setMyCommands } = fakeBot()
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  runtime.start(handlers(vi.fn(), ['9', '12']))
  expect(setMyCommands).toHaveBeenCalledTimes(2)
  expect(setMyCommands.mock.calls.map((call) => call[1])).toEqual([
    { scope: { type: 'chat', chat_id: 9 } },
    { scope: { type: 'chat', chat_id: 12 } },
  ])
})

test('setMyCommands is not called while unpaired', () => {
  const { bot, setMyCommands } = fakeBot()
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  runtime.start(handlers())
  expect(setMyCommands).not.toHaveBeenCalled()
})

async function runPairing(setMyCommands: ReturnType<typeof vi.fn>, log = vi.fn()) {
  const { bot, on } = fakeBot()
  ;(bot as unknown as { api: object }).api = { setMyCommands }
  const runtime = createTelegramRuntime({ botToken: TOKEN }, log, () => bot)
  runtime.start({ ...handlers(), pair: () => 'paired' })
  const pairingHandler = on.mock.calls.find((call) => call[0] === 'message')?.[1] as (
    context: unknown,
  ) => Promise<void>
  const reply = vi.fn(async () => {})
  await pairingHandler({
    from: { id: 9, is_bot: false },
    chat: { id: 9, type: 'private' },
    message: { message_id: 60, text: 'K7QM4XPD' },
    reply,
  })
  return { reply, log }
}

test('pairing sets the command menu for the new owner', async () => {
  const setMyCommands = vi.fn(async () => true)
  await runPairing(setMyCommands)
  expect(setMyCommands).toHaveBeenCalledTimes(1)
  expect(setMyCommands.mock.calls[0]?.[1]).toEqual({ scope: { type: 'chat', chat_id: 9 } })
})

test('pairing still replies when setMyCommands rejects or throws', async () => {
  const rejecting = await runPairing(vi.fn(async () => Promise.reject(new Error(TOKEN))))
  expect(rejecting.reply).toHaveBeenCalledWith('Paired. Approval requests will appear here.')
  await vi.waitFor(() => expect(rejecting.log).toHaveBeenCalledWith('failed to set bot commands'))
  const throwing = await runPairing(
    vi.fn(() => {
      throw new Error(TOKEN)
    }),
  )
  expect(throwing.reply).toHaveBeenCalledWith('Paired. Approval requests will appear here.')
  expect(throwing.log.mock.calls.flat().join('')).not.toContain(TOKEN)
})

const BOT_INFO = {
  id: 100,
  is_bot: true,
  first_name: 'b',
  username: 'mybot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe

const CHAT = { id: 9, type: 'private', first_name: 'o' } as const

function createDispatchBot(calls: { method: string; payload: unknown }[]): Bot {
  const bot = new Bot(TOKEN, { botInfo: BOT_INFO })
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload })
    const result = method === 'sendMessage' ? { message_id: 5, date: 0, chat: CHAT } : true
    return { ok: true, result } as never
  })
  bot.start = vi.fn(() => new Promise<void>(() => {}))
  return bot
}

function commandUpdate(fromId: number, text: string, extra: object = {}): Update {
  const length = text.indexOf(' ') === -1 ? text.length : text.indexOf(' ')
  return {
    update_id: 1,
    message: {
      message_id: 60,
      date: 0,
      chat: CHAT,
      from: { id: fromId, is_bot: false, first_name: 'o' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length }],
      ...extra,
    },
  } as Update
}

test('pairing still works with the reply handler', async () => {
  const calls: { method: string; payload: unknown }[] = []
  const bot = createDispatchBot(calls)
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  runtime.start({ ...handlers(), pair: vi.fn(() => 'paired' as const) })
  await bot.handleUpdate(commandUpdate(9, '/start K7QM4XPD'))
  const sent = calls.find((call) => call.method === 'sendMessage')
  expect(sent?.payload).toMatchObject({ text: 'Paired. Approval requests will appear here.' })
})

test('a stranger start message reaches pair and gets no reply', async () => {
  const calls: { method: string; payload: unknown }[] = []
  const bot = createDispatchBot(calls)
  const pair = vi.fn(() => 'notPairing' as const)
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  runtime.start({ ...handlers(vi.fn(), ['9']), pair })
  await bot.handleUpdate(commandUpdate(8, '/start K7QM4XPD'))
  expect(pair).toHaveBeenCalledWith('8', ' K7QM4XPD')
  expect(calls.filter((call) => call.method === 'sendMessage')).toEqual([])
})

test('/pending sent as a reply to an open text question runs the command', async () => {
  const calls: { method: string; payload: unknown }[] = []
  const bot = createDispatchBot(calls)
  const command = vi.fn(() => 'Nothing pending.')
  const reply = vi.fn(() => 'accepted' as const)
  const runtime = createTelegramRuntime({ botToken: TOKEN }, vi.fn(), () => bot)
  runtime.start({ ...handlers(vi.fn(), ['9']), command, reply })
  await runtime.sendRequest('q1', { text: 'Which branch?', spans: [] }, [], true, undefined, '9')
  await bot.handleUpdate(
    commandUpdate(9, '/pending', {
      reply_to_message: {
        message_id: 5,
        date: 0,
        chat: CHAT,
        from: { id: 100, is_bot: true, first_name: 'b' },
      },
    }),
  )
  expect(command).toHaveBeenCalledWith('pending', '', '9')
  expect(reply).not.toHaveBeenCalled()
})
