import { expect, test, vi } from 'vite-plus/test'
import { Bot, GrammyError, InputFile } from 'grammy'
import type { UserFromGetMe } from 'grammy/types'
import type { Span } from '../../src/format/index.ts'
import { ApprovalService, OWNER_COMMANDS } from '../../src/approval/index.ts'
import {
  formatCallbackData,
  formatDismissData,
  parseDismissData,
  createTelegramMessenger,
  handlePairingMessage,
  isOwnerCommand,
  registerCommandHandler,
  setCommandMenu,
  registerPairingHandler,
  registerReplyHandler,
  registerTapHandler,
  routeReply,
  routeTap,
  toEntities,
  formatPairingInstructions,
  formatLegacyInstructions,
} from '../../src/telegram/index.ts'
import type { IncomingMessage, OpenQuestions, Owner, Reply } from '../../src/telegram/index.ts'
import { NotificationService } from '../../src/notify/index.ts'
import { Pairing } from '../../src/pairing/index.ts'
import { QUIET_COMMANDS } from '../../src/quiet/index.ts'

const plain = (text: string) => ({ text, spans: [] })

const attempt = (pairing: Pairing) => (senderId: string, text: string) =>
  pairing.attempt(senderId, text)

test('formatCallbackData format', () => expect(formatCallbackData('abc', 1)).toBe('abc:1'))

test('formatCallbackData fits 64 bytes with a UUID', () => {
  const data = formatCallbackData(crypto.randomUUID(), 9)
  expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
})

test('non-owner tap ignored, tap not called', () => {
  const tap = vi.fn()
  expect(routeTap(7, 'abc:0', 42, tap)).toBe('ignored')
  expect(tap).not.toHaveBeenCalled()
})

test('owner tap routed', () => {
  const tap = vi.fn(() => 'accepted' as const)
  expect(routeTap(42, 'abc:1', 42, tap)).toBe('accepted')
  expect(tap).toHaveBeenCalledWith('abc', 1)
})

test('owner tap on expired request', () => {
  expect(routeTap(42, 'abc:1', 42, () => 'expired')).toBe('expired')
})

test.each([undefined, '', 'abc', 'abc:', 'abc:x', ':1', 'abc:1:2', 'abc:-1'])(
  'malformed data %s is expired',
  (d) => {
    const tap = vi.fn()
    expect(routeTap(42, d, 42, tap)).toBe('expired')
    expect(tap).not.toHaveBeenCalled()
  },
)

test('sendRequest sends plain text with one button per row', async () => {
  const sendMessage = vi.fn(async () => ({ message_id: 5, chat: { id: 42 } }))
  const bot = { api: { sendMessage } } as unknown as Bot
  const ref = await createTelegramMessenger(bot, { id: 42 }).sendRequest(
    'id1',
    plain('Deploy?'),
    ['Yes', 'No'],
    false,
    undefined,
  )
  expect(ref).toEqual({ chatId: 42, messageId: 5, hasButtons: true })
  expect(sendMessage).toHaveBeenCalledWith(42, 'Deploy?', {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Yes', callback_data: 'id1:0' }],
        [{ text: 'No', callback_data: 'id1:1' }],
      ],
    },
  })
})

const sentMessage = { message_id: 5, chat: { id: 42 } }
const at = new Date(2026, 0, 1, 9, 5)

test('allowText with buttons appends the tap-or-reply hint', async () => {
  const sendMessage = vi.fn(async () => sentMessage)
  const bot = { api: { sendMessage } } as unknown as Bot
  await createTelegramMessenger(bot, { id: 42 }).sendRequest(
    'id1',
    plain('Branch?'),
    ['main'],
    true,
    undefined,
  )
  expect(sendMessage).toHaveBeenCalledWith(
    42,
    'Branch?\n\nTap a button or reply to this message to type an answer.',
    {
      reply_markup: {
        inline_keyboard: [[{ text: 'main', callback_data: 'id1:0' }]],
      },
    },
  )
})

test('text-only question has the reply hint and no reply_markup', async () => {
  const sendMessage = vi.fn(async () => sentMessage)
  const bot = { api: { sendMessage } } as unknown as Bot
  const ref = await createTelegramMessenger(bot, { id: 42 }).sendRequest(
    'id1',
    plain('Branch?'),
    [],
    true,
    undefined,
  )
  expect(ref).toEqual({ chatId: 42, messageId: 5, hasButtons: false })
  expect(sendMessage).toHaveBeenCalledWith(
    42,
    'Branch?\n\nReply to this message with your answer.',
    {},
  )
})

test('send tracks the question and finalize forgets it', async () => {
  const openQuestions: OpenQuestions = new Map()
  const bot = {
    api: {
      sendMessage: vi.fn(async () => sentMessage),
      editMessageText: vi.fn(async () => true),
    },
  } as unknown as Bot
  const messenger = createTelegramMessenger(bot, { id: 42 }, openQuestions)
  const ref = await messenger.sendRequest('id1', plain('Branch?'), [], true, undefined)
  expect([...openQuestions]).toEqual([['42:5', { id: 'id1', allowText: true }]])
  await messenger.finalize(ref, plain('done'), {
    kind: 'replied',
    answer: 'x',
  })
  expect(openQuestions.size).toBe(0)
})

test('a failed final edit still forgets the question', async () => {
  const openQuestions: OpenQuestions = new Map()
  const bot = {
    api: {
      sendMessage: vi.fn(async () => sentMessage),
      editMessageText: vi.fn(async () => {
        throw new Error('message is not modified')
      }),
    },
  } as unknown as Bot
  const messenger = createTelegramMessenger(bot, { id: 42 }, openQuestions)
  const ref = await messenger.sendRequest('id1', plain('Branch?'), [], true, undefined)
  expect(openQuestions.size).toBe(1)
  await expect(messenger.finalize(ref, plain('done'), { kind: 'cancelled' })).rejects.toThrow(
    'message is not modified',
  )
  expect(openQuestions.size).toBe(0)
})

test.each([
  [{ chatId: 42, messageId: 5, hasButtons: true }, { reply_markup: { inline_keyboard: [] } }],
  [{ chatId: 42, messageId: 5 }, { reply_markup: { inline_keyboard: [] } }],
  [{ chatId: 42, messageId: 5, hasButtons: false }, {}],
])('finalize of %o clears the keyboard only if it had one', async (reference, extra) => {
  const editMessageText = vi.fn(
    async (_chatId: number, _messageId: number, _text: string, _other: object) => true,
  )
  const bot = { api: { editMessageText } } as unknown as Bot
  await createTelegramMessenger(bot, { id: 42 }).finalize(reference, plain('done'), {
    kind: 'cancelled',
  })
  expect(editMessageText).toHaveBeenCalledWith(42, 5, 'done', extra)
})

test('restart expiry of a saved text-only request sends no reply_markup', async () => {
  const editMessageText = vi.fn(
    async (_chatId: number, _messageId: number, _text: string, _other: object) => true,
  )
  const bot = { api: { editMessageText } } as unknown as Bot
  const service = new ApprovalService(createTelegramMessenger(bot, { id: 42 }), () => at)
  await service.expireOrphans([
    {
      id: 'old',
      reference: { chatId: 42, messageId: 5, hasButtons: false },
      text: 'Branch?',
    },
  ])
  expect(editMessageText).toHaveBeenCalledWith(
    42,
    5,
    'Branch?\n\n⌛ Expired (service restarted), 09:05',
    {},
  )
})

function fakeBot() {
  let handler: (ctx: unknown) => Promise<void> = async () => {}
  const on = vi.fn((_filter: string, h: typeof handler) => {
    handler = h
  })
  const run = (
    fromId: number,
    data: string | undefined,
    deleteMessage = vi.fn(async () => true),
    message: unknown = undefined,
  ) => {
    const answerCallbackQuery = vi.fn(async () => true)
    const apiDeleteMessage = vi.fn(async (_chatId: number, _messageId: number) => true)
    const p = handler({
      from: { id: fromId },
      callbackQuery: { data, message },
      answerCallbackQuery,
      deleteMessage,
      api: { deleteMessage: apiDeleteMessage },
    })
    return { answerCallbackQuery, deleteMessage, apiDeleteMessage, p }
  }
  return { bot: { on, botInfo: { id: 99 } } as unknown as Bot, on, run }
}

test('handler: owner accepted answers silently', async () => {
  const { bot, on, run } = fakeBot()
  registerTapHandler(bot, { id: 42 }, () => 'accepted', vi.fn())
  expect(on).toHaveBeenCalledWith('callback_query:data', expect.any(Function))
  const { answerCallbackQuery, p } = run(42, 'abc:0')
  await p
  expect(answerCallbackQuery).toHaveBeenCalledWith()
})

test('handler: expired shows Expired', async () => {
  const { bot, run } = fakeBot()
  registerTapHandler(bot, { id: 42 }, () => 'expired', vi.fn())
  const { answerCallbackQuery, p } = run(42, 'abc:0')
  await p
  expect(answerCallbackQuery).toHaveBeenCalledWith({ text: 'Expired' })
})

test('handler: non-owner ignored, tap not called, no text', async () => {
  const { bot, run } = fakeBot()
  const tap = vi.fn()
  registerTapHandler(bot, { id: 42 }, tap, vi.fn())
  const { answerCallbackQuery, p } = run(7, 'abc:0')
  await p
  expect(tap).not.toHaveBeenCalled()
  expect(answerCallbackQuery).toHaveBeenCalledWith()
})

test('handler: owner dismiss deletes the message and calls dismiss', async () => {
  const { bot, run } = fakeBot()
  const tap = vi.fn()
  const dismiss = vi.fn(() => true)
  registerTapHandler(bot, { id: 42 }, tap, dismiss)
  const { answerCallbackQuery, deleteMessage, p } = run(42, 'dismiss/id1')
  await p
  expect(dismiss).toHaveBeenCalledWith('id1')
  expect(deleteMessage).toHaveBeenCalledTimes(1)
  expect(answerCallbackQuery).toHaveBeenCalledWith()
  expect(tap).not.toHaveBeenCalled()
})

test('handler: dismiss for unknown id still deletes the message', async () => {
  const { bot, run } = fakeBot()
  registerTapHandler(bot, { id: 42 }, vi.fn(), () => false)
  const { answerCallbackQuery, deleteMessage, p } = run(42, 'dismiss/gone')
  await p
  expect(deleteMessage).toHaveBeenCalledTimes(1)
  expect(answerCallbackQuery).toHaveBeenCalledWith()
})

test('handler: failed dismiss delete is logged and the tap answered', async () => {
  const { bot, run } = fakeBot()
  const log = vi.fn()
  registerTapHandler(bot, { id: 42 }, vi.fn(), () => true, log)
  const deleteMessage = vi.fn(async () => {
    throw new Error('message to delete not found')
  })
  const { answerCallbackQuery, p } = run(42, 'dismiss/id1', deleteMessage)
  await expect(p).resolves.toBeUndefined()
  expect(log).toHaveBeenCalledWith('failed to delete notification: message to delete not found')
  expect(answerCallbackQuery).toHaveBeenCalledWith()
})

const DISMISSED_MESSAGE = { message_id: 11, chat: { id: 42 } }

test("handler: dismiss also deletes the bot's document the message replies to", async () => {
  const { bot, run } = fakeBot()
  registerTapHandler(bot, { id: 42 }, vi.fn(), () => true)
  const message = {
    ...DISMISSED_MESSAGE,
    reply_to_message: {
      message_id: 10,
      from: { id: 99 },
      document: { file_id: 'f' },
    },
  }
  const { deleteMessage, apiDeleteMessage, answerCallbackQuery, p } = run(
    42,
    'dismiss/id1',
    undefined,
    message,
  )
  await p
  expect(deleteMessage).toHaveBeenCalledTimes(1)
  expect(apiDeleteMessage).toHaveBeenCalledTimes(1)
  expect(apiDeleteMessage).toHaveBeenCalledWith(42, 10)
  expect(answerCallbackQuery).toHaveBeenCalledWith()
})

test("handler: dismiss leaves a replied-to message that isn't the bot's document", async () => {
  const { bot, run } = fakeBot()
  registerTapHandler(bot, { id: 42 }, vi.fn(), () => true)
  const owners = {
    ...DISMISSED_MESSAGE,
    reply_to_message: {
      message_id: 10,
      from: { id: 42 },
      document: { file_id: 'f' },
    },
  }
  const botText = {
    ...DISMISSED_MESSAGE,
    reply_to_message: { message_id: 10, from: { id: 99 } },
  }
  const first = run(42, 'dismiss/id1', undefined, owners)
  const second = run(42, 'dismiss/id1', undefined, botText)
  await first.p
  await second.p
  expect(first.apiDeleteMessage).not.toHaveBeenCalled()
  expect(second.apiDeleteMessage).not.toHaveBeenCalled()
})

test('handler: dismiss without a replied-to message deletes only itself', async () => {
  const { bot, run } = fakeBot()
  registerTapHandler(bot, { id: 42 }, vi.fn(), () => true)
  const { deleteMessage, apiDeleteMessage, p } = run(
    42,
    'dismiss/id1',
    undefined,
    DISMISSED_MESSAGE,
  )
  await p
  expect(deleteMessage).toHaveBeenCalledTimes(1)
  expect(apiDeleteMessage).not.toHaveBeenCalled()
})

test('handler: a failed document delete on dismiss is logged and the tap answered', async () => {
  const { bot, run } = fakeBot()
  const log = vi.fn()
  registerTapHandler(bot, { id: 42 }, vi.fn(), () => true, log)
  const message = {
    ...DISMISSED_MESSAGE,
    reply_to_message: {
      message_id: 10,
      from: { id: 99 },
      document: { file_id: 'f' },
    },
  }
  const { apiDeleteMessage, answerCallbackQuery, p } = run(42, 'dismiss/id1', undefined, message)
  apiDeleteMessage.mockRejectedValueOnce(new Error('message to delete not found'))
  await expect(p).resolves.toBeUndefined()
  expect(log).toHaveBeenCalledWith('failed to delete notification: message to delete not found')
  expect(answerCallbackQuery).toHaveBeenCalledWith()
})

test('handler: non-owner dismiss is ignored', async () => {
  const { bot, run } = fakeBot()
  const dismiss = vi.fn()
  registerTapHandler(bot, { id: 42 }, vi.fn(), dismiss)
  const { answerCallbackQuery, deleteMessage, p } = run(7, 'dismiss/id1')
  await p
  expect(dismiss).not.toHaveBeenCalled()
  expect(deleteMessage).not.toHaveBeenCalled()
  expect(answerCallbackQuery).toHaveBeenCalledWith()
})

test('formatDismissData format', () => expect(formatDismissData('abc')).toBe('dismiss/abc'))

test('formatDismissData fits 64 bytes with a UUID', () => {
  expect(Buffer.byteLength(formatDismissData(crypto.randomUUID()))).toBeLessThanOrEqual(64)
})

test("dismiss and approval payloads don't overlap", () => {
  expect(parseDismissData(formatDismissData('abc'))).toBe('abc')
  expect(parseDismissData('abc:0')).toBeUndefined()
  expect(parseDismissData('dismiss/abc:0')).toBeUndefined()
  const tap = vi.fn()
  expect(routeTap(42, formatDismissData('abc'), 42, tap)).toBe('expired')
  expect(tap).not.toHaveBeenCalled()
})

test('sendNotification sends text with one Dismiss button', async () => {
  const sendMessage = vi.fn(async () => ({ message_id: 5, chat: { id: 42 } }))
  const bot = { api: { sendMessage } } as unknown as Bot
  const ref = await createTelegramMessenger(bot, { id: 42 }).sendNotification(
    'id1',
    plain('hi'),
    { silent: false, dismissible: true },
    undefined,
  )
  expect(ref).toEqual({ chatId: 42, messageId: 5 })
  expect(sendMessage).toHaveBeenCalledWith(42, 'hi', {
    disable_notification: false,
    reply_markup: {
      inline_keyboard: [[{ text: 'Dismiss', callback_data: 'dismiss/id1' }]],
    },
  })
})

test('sendNotification without dismissible sends no keyboard', async () => {
  const sendMessage = vi.fn(async (_chatId: number, _text: string, _other: object) => ({
    message_id: 5,
    chat: { id: 42 },
  }))
  const bot = { api: { sendMessage } } as unknown as Bot
  const ref = await createTelegramMessenger(bot, { id: 42 }).sendNotification(
    'id1',
    plain('hi'),
    { silent: false, dismissible: false },
    undefined,
  )
  expect(ref).toEqual({ chatId: 42, messageId: 5 })
  expect(sendMessage).toHaveBeenCalledWith(42, 'hi', { disable_notification: false })
})

test('sendNotification sets disable_notification when silent', async () => {
  const sendMessage = vi.fn(async (_chatId: number, _text: string, _other: object) => ({
    message_id: 5,
    chat: { id: 42 },
  }))
  const bot = { api: { sendMessage } } as unknown as Bot
  await createTelegramMessenger(bot, { id: 42 }).sendNotification(
    'id1',
    plain('hi'),
    { silent: true, dismissible: true },
    undefined,
  )
  expect(sendMessage.mock.calls[0]?.[2]).toMatchObject({
    disable_notification: true,
  })
})

test('sendRequest never sets disable_notification', async () => {
  const sendMessage = vi.fn(async (_chatId: number, _text: string, _other: object) => ({
    message_id: 5,
    chat: { id: 42 },
  }))
  const bot = { api: { sendMessage } } as unknown as Bot
  await createTelegramMessenger(bot, { id: 42 }).sendRequest(
    'id1',
    plain('hi'),
    ['Yes', 'No'],
    false,
    undefined,
  )
  expect(Object.hasOwn(sendMessage.mock.calls[0]?.[2] ?? {}, 'disable_notification')).toBe(false)
})

test('sendNotification throws when unpaired', async () => {
  const sendMessage = vi.fn()
  const bot = { api: { sendMessage } } as unknown as Bot
  await expect(
    createTelegramMessenger(bot, { id: undefined }).sendNotification(
      'id1',
      plain('hi'),
      { silent: true, dismissible: true },
      undefined,
    ),
  ).rejects.toThrow()
  expect(sendMessage).not.toHaveBeenCalled()
})

test('deleteMessage deletes by reference', async () => {
  const deleteMessage = vi.fn(async () => true)
  const bot = { api: { deleteMessage } } as unknown as Bot
  await createTelegramMessenger(bot, { id: 42 }).deleteMessage({
    chatId: 42,
    messageId: 5,
  })
  expect(deleteMessage).toHaveBeenCalledWith(42, 5)
})

test('tap with no owner is ignored', () => {
  const tap = vi.fn()
  expect(routeTap(1, 'abc:0', undefined, tap)).toBe('ignored')
  expect(tap).not.toHaveBeenCalled()
})

test('messenger sends to the owner id at call time', async () => {
  const sendMessage = vi.fn(async () => ({ message_id: 5, chat: { id: 9 } }))
  const bot = { api: { sendMessage } } as unknown as Bot
  const owner: Owner = { id: undefined }
  const m = createTelegramMessenger(bot, owner)
  await expect(m.sendRequest('id1', plain('Q'), ['Yes'], false, undefined)).rejects.toThrow()
  expect(sendMessage).not.toHaveBeenCalled()
  owner.id = 9
  await m.sendRequest('id1', plain('Q'), ['Yes'], false, undefined)
  expect(sendMessage).toHaveBeenCalledWith(9, 'Q', expect.anything())
})

test('pairing: right code replies and calls onPaired', () => {
  const onPaired = vi.fn()
  const reply = handlePairingMessage(
    { fromId: 9, chatType: 'private', text: '/start K7QM-4XPD' },
    attempt(new Pairing('K7QM4XPD')),
    onPaired,
  )
  expect(reply).toBe('Paired. Approval requests will appear here.')
  expect(onPaired).toHaveBeenCalledWith(9)
})

test.each(['/start K7QM-4XPD', '/start@my_bot k7qm4xpd'])(
  'handlePairingMessage strips /start and /start@bot: %s',
  (text) => {
    const onPaired = vi.fn()
    const reply = handlePairingMessage(
      { fromId: 42, chatType: 'private', text },
      attempt(new Pairing('K7QM4XPD')),
      onPaired,
    )
    expect(reply).toBe('Paired. Approval requests will appear here.')
    expect(onPaired).toHaveBeenCalledWith(42)
  },
)

test('pairing: wrong code gets the hint, onPaired not called', () => {
  const onPaired = vi.fn()
  const reply = handlePairingMessage(
    { fromId: 9, chatType: 'private', text: 'nope' },
    attempt(new Pairing('K7QM4XPD')),
    onPaired,
  )
  expect(reply).toBe("This bot isn't paired. Check the service logs for the pairing code.")
  expect(onPaired).not.toHaveBeenCalled()
})

test('pairing: group chat ignored', () => {
  const p = new Pairing('K7QM4XPD')
  expect(
    handlePairingMessage({ fromId: 9, chatType: 'group', text: 'K7QM4XPD' }, attempt(p), vi.fn()),
  ).toBeUndefined()
  expect(p.paired).toBe(false)
})

test('pairing: blocked sender gets no reply', () => {
  const p = new Pairing('K7QM4XPD', 1)
  const msg = { fromId: 9, chatType: 'private', text: 'bad' }
  handlePairingMessage(msg, attempt(p), vi.fn())
  expect(handlePairingMessage(msg, attempt(p), vi.fn())).toBeUndefined()
})

test('after pairing, strangers and old codes get no reply', () => {
  const p = new Pairing('K7QM4XPD')
  p.attempt('1', 'K7QM4XPD')
  const onPaired = vi.fn()
  expect(
    handlePairingMessage({ fromId: 2, chatType: 'private', text: '/start' }, attempt(p), onPaired),
  ).toBeUndefined()
  expect(
    handlePairingMessage(
      { fromId: 2, chatType: 'private', text: 'K7QM4XPD' },
      attempt(p),
      onPaired,
    ),
  ).toBeUndefined()
  expect(onPaired).not.toHaveBeenCalled()
})

test('pairing handler replies via ctx.reply and stays silent when ignored', async () => {
  let handler: (ctx: unknown) => Promise<void> = async () => {}
  const on = vi.fn((_f: string, h: typeof handler) => {
    handler = h
  })
  registerPairingHandler({ on } as unknown as Bot, attempt(new Pairing('K7QM4XPD')), vi.fn())
  expect(on).toHaveBeenCalledWith('message:text', expect.any(Function))
  const reply = vi.fn(async () => {})
  await handler({
    from: { id: 9 },
    chat: { type: 'private' },
    message: { text: 'K7QM4XPD' },
    reply,
  })
  expect(reply).toHaveBeenCalledWith('Paired. Approval requests will appear here.')
  reply.mockClear()
  await handler({
    from: { id: 2 },
    chat: { type: 'private' },
    message: { text: 'x' },
    reply,
  })
  expect(reply).not.toHaveBeenCalled()
})

test('formatPairingInstructions text', () => {
  expect(formatPairingInstructions('K7QM4XPD', 'mybot')).toBe(
    'Send "/start K7QM-4XPD" to @mybot, or open https://t.me/mybot?start=K7QM4XPD',
  )
})

test('formatLegacyInstructions takes the dashed code', () => {
  expect(formatLegacyInstructions('K7QM-4XPD', 'mybot')).toBe(
    'Send "/start K7QM-4XPD" to @mybot, or open https://t.me/mybot?start=K7QM4XPD',
  )
})

const TOKEN = '123:secret-token'

type CommandContext = {
  from?: { id: number }
  chat: { type: string }
  match: string
  reply: ReturnType<typeof vi.fn>
}

function createCommandBot() {
  const handlers = new Map<
    string,
    (context: CommandContext, next: () => Promise<void>) => unknown
  >()
  const command = vi.fn((name: string, handler: (context: CommandContext) => unknown) => {
    handlers.set(name, handler)
  })
  return { bot: { command } as unknown as Bot, handlers }
}

function createCommandContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    from: { id: 9 },
    chat: { type: 'private' },
    match: '',
    reply: vi.fn(async () => {}),
    ...overrides,
  }
}

test('isOwnerCommand: owner in private chat only', () => {
  expect(isOwnerCommand({ fromId: 9, chatType: 'private' }, 9)).toBe(true)
  expect(isOwnerCommand({ fromId: 8, chatType: 'private' }, 9)).toBe(false)
  expect(isOwnerCommand({ fromId: 9, chatType: 'group' }, 9)).toBe(false)
  expect(isOwnerCommand({ fromId: 9, chatType: 'private' }, undefined)).toBe(false)
  expect(isOwnerCommand({ fromId: undefined, chatType: 'channel' }, 9)).toBe(false)
})

test('command handler replies to the owner with the core text', async () => {
  const { bot, handlers } = createCommandBot()
  const command = vi.fn((name: string, argument: string) => `${name}:${argument}`)
  registerCommandHandler(bot, { id: 9 }, OWNER_COMMANDS, command)
  expect([...handlers.keys()]).toEqual(['pending', 'cancel', 'history'])
  const context = createCommandContext({ match: '5' })
  await handlers.get('history')?.(
    context,
    vi.fn(async () => {}),
  )
  expect(context.reply).toHaveBeenCalledWith('history:5')
})

test('command handler is silent for strangers, groups and channel posts', async () => {
  const { bot, handlers } = createCommandBot()
  const command = vi.fn(() => 'text')
  registerCommandHandler(bot, { id: 9 }, OWNER_COMMANDS, command)
  const next = vi.fn(async () => {})
  const contexts = [
    createCommandContext({ from: { id: 8 } }),
    createCommandContext({ chat: { type: 'group' } }),
    createCommandContext({ from: undefined, chat: { type: 'channel' } }),
  ]
  for (const context of contexts) {
    await handlers.get('pending')?.(context, next)
    expect(context.reply).not.toHaveBeenCalled()
  }
  expect(command).not.toHaveBeenCalled()
  expect(next).not.toHaveBeenCalled()
})

test('command handler is silent while no owner is paired', async () => {
  const { bot, handlers } = createCommandBot()
  const command = vi.fn(() => 'text')
  registerCommandHandler(bot, { id: undefined }, OWNER_COMMANDS, command)
  const context = createCommandContext()
  await handlers.get('pending')?.(
    context,
    vi.fn(async () => {}),
  )
  expect(command).not.toHaveBeenCalled()
  expect(context.reply).not.toHaveBeenCalled()
})

test('command handler sends nothing when the core returns undefined', async () => {
  const { bot, handlers } = createCommandBot()
  registerCommandHandler(bot, { id: 9 }, OWNER_COMMANDS, () => undefined)
  const context = createCommandContext()
  await handlers.get('pending')?.(
    context,
    vi.fn(async () => {}),
  )
  expect(context.reply).not.toHaveBeenCalled()
})

function createMenuBot(setMyCommands: ReturnType<typeof vi.fn>): Bot {
  return { api: { setMyCommands } } as unknown as Bot
}

test('setCommandMenu sets the owner chat scope', async () => {
  const setMyCommands = vi.fn(async () => true)
  setCommandMenu(createMenuBot(setMyCommands), 9, OWNER_COMMANDS, vi.fn())
  await vi.waitFor(() => expect(setMyCommands).toHaveBeenCalledTimes(1))
  expect(setMyCommands).toHaveBeenCalledWith(
    [
      { command: 'pending', description: 'List open requests' },
      {
        command: 'cancel',
        description: 'Reject all open requests with their timeout answers',
      },
      { command: 'history', description: 'Show recent answers' },
    ],
    { scope: { type: 'chat', chat_id: 9 } },
  )
})

test('setCommandMenu logs the code and never the error text', async () => {
  const log = vi.fn()
  const grammyError = new GrammyError(
    `Call to setMyCommands failed for ${TOKEN}`,
    { ok: false, error_code: 400, description: TOKEN },
    'setMyCommands',
    {},
  )
  setCommandMenu(
    createMenuBot(vi.fn(async () => Promise.reject(grammyError))),
    9,
    OWNER_COMMANDS,
    log,
  )
  await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1))
  setCommandMenu(
    createMenuBot(vi.fn(async () => Promise.reject(new Error(TOKEN)))),
    9,
    OWNER_COMMANDS,
    log,
  )
  await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2))
  expect(log.mock.calls.map((call) => call[0])).toEqual([
    'failed to set bot commands (400)',
    'failed to set bot commands',
  ])
})

test('setCommandMenu survives a synchronous throw', async () => {
  const log = vi.fn()
  const setMyCommands = vi.fn(() => {
    throw new Error(TOKEN)
  })
  expect(() => setCommandMenu(createMenuBot(setMyCommands), 9, OWNER_COMMANDS, log)).not.toThrow()
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith('failed to set bot commands'))
})

const BOT_ID = 100
const QUESTION = { messageId: 5, fromId: BOT_ID }
const OTHER_BOT_MESSAGE = { messageId: 7, fromId: BOT_ID }
const messageOf = (overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
  fromId: 9,
  chatType: 'private',
  chatId: 9,
  text: 'feature/x',
  replyTo: undefined,
  ...overrides,
})
const questionsOf = (...entries: [number, boolean][]) =>
  new Map(
    entries.map(([messageId, allowText]) => [`9:${messageId}`, { id: `q${messageId}`, allowText }]),
  )
const accepting = () => vi.fn((_id: string, _text: string) => 'accepted' as const)
const expiring = () => vi.fn((_id: string, _text: string) => 'expired' as const)

test('routeReply ignores a stranger', () => {
  const reply = accepting()
  const route = routeReply(messageOf({ fromId: 8 }), 9, BOT_ID, questionsOf([5, true]), reply)
  expect(route).toBe('ignored')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply ignores a group chat', () => {
  const reply = accepting()
  const route = routeReply(
    messageOf({ chatType: 'group' }),
    9,
    BOT_ID,
    questionsOf([5, true]),
    reply,
  )
  expect(route).toBe('ignored')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply ignores a channel post', () => {
  const reply = accepting()
  const route = routeReply(
    messageOf({ fromId: undefined }),
    9,
    BOT_ID,
    questionsOf([5, true]),
    reply,
  )
  expect(route).toBe('ignored')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply ignores everyone when nobody is paired', () => {
  const reply = accepting()
  const route = routeReply(messageOf(), undefined, BOT_ID, questionsOf([5, true]), reply)
  expect(route).toBe('ignored')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply settles an open text question with the trimmed reply', () => {
  const reply = accepting()
  const message = messageOf({ text: '  feature/x \n', replyTo: QUESTION })
  expect(routeReply(message, 9, BOT_ID, questionsOf([5, true]), reply)).toBe('accepted')
  expect(reply).toHaveBeenCalledExactlyOnceWith('q5', 'feature/x')
})

test('routeReply keeps inner newlines', () => {
  const reply = accepting()
  const message = messageOf({ text: 'line 1\nline 2', replyTo: QUESTION })
  expect(routeReply(message, 9, BOT_ID, questionsOf([5, true]), reply)).toBe('accepted')
  expect(reply).toHaveBeenCalledExactlyOnceWith('q5', 'line 1\nline 2')
})

test('routeReply counts a reply starting with a slash', () => {
  const reply = accepting()
  const message = messageOf({ text: '/var/www', replyTo: QUESTION })
  expect(routeReply(message, 9, BOT_ID, questionsOf([5, true]), reply)).toBe('accepted')
  expect(reply).toHaveBeenCalledExactlyOnceWith('q5', '/var/www')
})

test('routeReply refuses a reply to a buttons-only question', () => {
  const reply = accepting()
  const message = messageOf({ replyTo: QUESTION })
  expect(routeReply(message, 9, BOT_ID, questionsOf([5, false]), reply)).toBe('buttonsOnly')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply reports expired when the question is settled but not finalized', () => {
  const reply = expiring()
  const message = messageOf({ replyTo: QUESTION })
  expect(routeReply(message, 9, BOT_ID, questionsOf([5, true]), reply)).toBe('expired')
  expect(reply).toHaveBeenCalledTimes(1)
})

test('routeReply says not open for a reply to another bot message', () => {
  const reply = accepting()
  const message = messageOf({ replyTo: OTHER_BOT_MESSAGE })
  expect(routeReply(message, 9, BOT_ID, questionsOf([5, true]), reply)).toBe('notOpen')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply treats a reply to the owner own message as a non-reply', () => {
  const reply = accepting()
  const message = messageOf({ replyTo: { messageId: 7, fromId: 9 } })
  expect(routeReply(message, 9, BOT_ID, questionsOf([5, true]), reply)).toBe('accepted')
  expect(reply).toHaveBeenCalledExactlyOnceWith('q5', 'feature/x')
})

test('routeReply settles the one text question among buttons-only ones', () => {
  const reply = accepting()
  const questions = questionsOf([5, false], [6, true])
  expect(routeReply(messageOf(), 9, BOT_ID, questions, reply)).toBe('accepted')
  expect(reply).toHaveBeenCalledExactlyOnceWith('q6', 'feature/x')
})

test('routeReply is ambiguous with several text questions', () => {
  const reply = accepting()
  const questions = questionsOf([5, true], [6, true])
  expect(routeReply(messageOf(), 9, BOT_ID, questions, reply)).toBe('ambiguous')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply ignores a non-reply when no text question is open', () => {
  const reply = accepting()
  expect(routeReply(messageOf(), 9, BOT_ID, questionsOf([5, false]), reply)).toBe('ignored')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply ignores a non-reply starting with a slash', () => {
  const reply = accepting()
  const message = messageOf({ text: '/start' })
  expect(routeReply(message, 9, BOT_ID, questionsOf([5, true]), reply)).toBe('ignored')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply ignores a non-reply when the only text question is settled', () => {
  const reply = expiring()
  expect(routeReply(messageOf(), 9, BOT_ID, questionsOf([5, true]), reply)).toBe('ignored')
  expect(reply).toHaveBeenCalledTimes(1)
})

test('routeReply says not text for a non-text reply to an open text question', () => {
  const reply = accepting()
  const message = messageOf({ text: undefined, replyTo: QUESTION })
  expect(routeReply(message, 9, BOT_ID, questionsOf([5, true]), reply)).toBe('notText')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply ignores a non-text reply to a buttons-only question', () => {
  const reply = accepting()
  const message = messageOf({ text: undefined, replyTo: QUESTION })
  expect(routeReply(message, 9, BOT_ID, questionsOf([5, false]), reply)).toBe('ignored')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply ignores a non-text reply to another bot message', () => {
  const reply = accepting()
  const message = messageOf({ text: undefined, replyTo: OTHER_BOT_MESSAGE })
  expect(routeReply(message, 9, BOT_ID, questionsOf([5, false]), reply)).toBe('ignored')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply ignores a non-text non-reply', () => {
  const reply = accepting()
  const message = messageOf({ text: undefined })
  expect(routeReply(message, 9, BOT_ID, questionsOf([5, true]), reply)).toBe('ignored')
  expect(reply).not.toHaveBeenCalled()
})

const REPLY_BOT_ID = 100

function setupReplyHandler(
  options: {
    text?: string
    from?: { id: number }
    replyTo?: { message_id: number; from?: { id: number } }
    reply?: Reply
    questions?: OpenQuestions
    contextReply?: ReturnType<typeof vi.fn>
  } = {},
) {
  let handler: (context: unknown, next: () => Promise<void>) => Promise<void> = async () => {}
  const on = vi.fn((_filter: string, registered: typeof handler) => {
    handler = registered
  })
  const bot = { on, botInfo: { id: REPLY_BOT_ID } } as unknown as Bot
  const reply = options.reply ?? vi.fn(() => 'accepted' as const)
  const log = vi.fn()
  registerReplyHandler(
    bot,
    { id: 42 },
    options.questions ?? new Map([['42:7', { id: 'q1', allowText: true }]]),
    reply,
    log,
  )
  const contextReply = options.contextReply ?? vi.fn(async () => {})
  const next = vi.fn(async () => {})
  const run = () =>
    handler(
      {
        from: options.from ?? { id: 42 },
        chat: { id: 42, type: 'private' },
        message: {
          message_id: 50,
          ...(options.text !== undefined && { text: options.text }),
          ...(options.replyTo !== undefined && {
            reply_to_message: options.replyTo,
          }),
        },
        reply: contextReply,
      },
      next,
    )
  return { on, reply, log, contextReply, next, run }
}

test('reply handler registers on message', () => {
  const { on } = setupReplyHandler()
  expect(on).toHaveBeenCalledWith('message', expect.any(Function))
})

test('reply handler settles silently', async () => {
  const { reply, contextReply, next, run } = setupReplyHandler({
    text: ' yes ',
    replyTo: { message_id: 7, from: { id: REPLY_BOT_ID } },
  })
  await run()
  expect(reply).toHaveBeenCalledWith('q1', 'yes')
  expect(contextReply).not.toHaveBeenCalled()
  expect(next).not.toHaveBeenCalled()
})

test.each([
  [
    'buttonsOnly',
    new Map([['42:7', { id: 'q1', allowText: false }]]),
    { message_id: 7, from: { id: REPLY_BOT_ID } },
    'hi',
    'Tap one of the buttons to answer this question.',
  ],
  [
    'notOpen',
    new Map(),
    { message_id: 7, from: { id: REPLY_BOT_ID } },
    'hi',
    "That message isn't waiting for an answer.",
  ],
  [
    'expired',
    new Map([['42:7', { id: 'q1', allowText: true }]]),
    { message_id: 7, from: { id: REPLY_BOT_ID } },
    'hi',
    "That message isn't waiting for an answer.",
  ],
  [
    'ambiguous',
    new Map([
      ['42:7', { id: 'q1', allowText: true }],
      ['42:8', { id: 'q2', allowText: true }],
    ]),
    undefined,
    'hi',
    "Several questions are open; reply to the one you're answering.",
  ],
  [
    'notText',
    new Map([['42:7', { id: 'q1', allowText: true }]]),
    { message_id: 7, from: { id: REPLY_BOT_ID } },
    undefined,
    'Only text replies count as an answer.',
  ],
])(
  'reply handler answers as a reply to the owner message: %s',
  async (kind, questions, replyTo, text, copy) => {
    const { contextReply, next, run } = setupReplyHandler({
      questions: questions as OpenQuestions,
      ...(replyTo !== undefined && { replyTo }),
      ...(text !== undefined && { text }),
      reply:
        kind === 'expired' ? vi.fn(() => 'expired' as const) : vi.fn(() => 'accepted' as const),
    })
    await run()
    expect(contextReply).toHaveBeenCalledWith(copy, {
      reply_parameters: { message_id: 50 },
    })
    expect(next).not.toHaveBeenCalled()
  },
)

test('reply handler passes ignored messages on', async () => {
  const stranger = setupReplyHandler({ text: 'hi', from: { id: 7 } })
  await stranger.run()
  expect(stranger.next).toHaveBeenCalledTimes(1)
  expect(stranger.contextReply).not.toHaveBeenCalled()
  const plain = setupReplyHandler({ text: 'hi', questions: new Map() })
  await plain.run()
  expect(plain.next).toHaveBeenCalledTimes(1)
  expect(plain.contextReply).not.toHaveBeenCalled()
})

test('a failed bot reply is logged, not thrown', async () => {
  const { log, run } = setupReplyHandler({
    text: 'hi',
    replyTo: { message_id: 7, from: { id: REPLY_BOT_ID } },
    questions: new Map(),
    contextReply: vi.fn(async () => {
      throw new Error('boom')
    }),
  })
  await expect(run()).resolves.toBeUndefined()
  expect(log).toHaveBeenCalledWith('failed to reply: boom')
})

const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: 'My Bot',
  username: 'mybot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe

function createDispatchBot() {
  const calls: { method: string; payload: unknown }[] = []
  const bot = new Bot(TOKEN, { botInfo: BOT_INFO })
  bot.api.config.use((_previous, method, payload) => {
    calls.push({ method, payload })
    return Promise.resolve({
      ok: true,
      result:
        method === 'sendMessage'
          ? {
              message_id: 1,
              date: 0,
              chat: { id: 9, type: 'private', first_name: 'O' },
            }
          : true,
    }) as never
  })
  return { bot, calls }
}

function textUpdate(text: string, fromId = 9, chatType = 'private') {
  const commandLength = text.split(' ')[0]?.length ?? 0
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: fromId, type: chatType, first_name: 'O' },
      from: { id: fromId, is_bot: false, first_name: 'O' },
      text,
      entities: text.startsWith('/')
        ? [{ type: 'bot_command', offset: 0, length: commandLength }]
        : [],
    },
  } as never
}

function registerDispatchHandlers(
  bot: Bot,
  owner: Owner,
  command: (name: string, argument: string) => string | undefined,
  pair: (senderId: string, text: string) => 'paired' | 'wrong' | 'blocked' | 'notPairing',
  onPaired: (id: number) => void,
): void {
  registerCommandHandler(bot, owner, [...OWNER_COMMANDS, ...QUIET_COMMANDS], command)
  registerPairingHandler(bot, pair, onPaired)
}

test('/mute@mybot reaches the core with its argument', async () => {
  const { bot, calls } = createDispatchBot()
  const command = vi.fn(() => 'ok')
  registerDispatchHandlers(bot, { id: 9 }, command, vi.fn(), vi.fn())
  await bot.handleUpdate(textUpdate('/mute@mybot 2h'))
  expect(command).toHaveBeenCalledWith('mute', '2h')
  expect(calls.map((call) => call.method)).toEqual(['sendMessage'])
  expect(calls[0]?.payload).toMatchObject({ text: 'ok' })
})

test('quiet commands from strangers, groups or while unpaired get nothing and never reach pairing', async () => {
  const { bot, calls } = createDispatchBot()
  const command = vi.fn(() => 'ok')
  const pair = vi.fn(() => 'wrong' as const)
  registerDispatchHandlers(bot, { id: 9 }, command, pair, vi.fn())
  await bot.handleUpdate(textUpdate('/mute 2h', 8))
  await bot.handleUpdate(textUpdate('/quiet off', 9, 'group'))
  const unpaired = createDispatchBot()
  registerDispatchHandlers(unpaired.bot, { id: undefined }, command, pair, vi.fn())
  await unpaired.bot.handleUpdate(textUpdate('/mute'))
  expect(command).not.toHaveBeenCalled()
  expect(pair).not.toHaveBeenCalled()
  expect(calls).toEqual([])
  expect(unpaired.calls).toEqual([])
})

test('/start CODE still pairs with the command handler registered', async () => {
  const { bot, calls } = createDispatchBot()
  const pairing = new Pairing('K7QM4XPD')
  const onPaired = vi.fn()
  registerDispatchHandlers(bot, { id: undefined }, vi.fn(), attempt(pairing), onPaired)
  await bot.handleUpdate(textUpdate('/start K7QM4XPD'))
  expect(onPaired).toHaveBeenCalledWith(9)
  expect(calls.map((call) => call.payload)).toMatchObject([
    { text: 'Paired. Approval requests will appear here.' },
  ])
})

const CODE_4_2 = { kind: 'code', offset: 4, length: 2 } as const
const RUN_LS = { text: 'Run ls', spans: [CODE_4_2] }
const REJECTED_ENTITIES = "Bad Request: can't parse entities"

function createRejection(errorCode: number, description: string): GrammyError {
  return new GrammyError(
    'Call failed',
    { ok: false, error_code: errorCode, description },
    'sendMessage',
    {},
  )
}

function createSendBot(first?: Error, second?: Error) {
  const results = [first, second]
  const reply = { message_id: 5, chat: { id: 42 } }
  const sendMessage = vi.fn(async (_chatId: number, _text: string, _other: object) => {
    const failure = results.shift()
    if (failure !== undefined) {
      throw failure
    }
    return reply
  })
  const editMessageText = vi.fn(
    async (_chatId: number, _messageId: number, _text: string, _other: object) => {
      const failure = results.shift()
      if (failure !== undefined) {
        throw failure
      }
      return true
    },
  )
  return {
    bot: { api: { sendMessage, editMessageText } } as unknown as Bot,
    sendMessage,
    editMessageText,
  }
}

test('toEntities maps each kind', () => {
  const spans: Span[] = [
    { kind: 'bold', offset: 0, length: 1 },
    { kind: 'italic', offset: 2, length: 1 },
    { kind: 'strikethrough', offset: 4, length: 1 },
    { kind: 'code', offset: 6, length: 1 },
    { kind: 'blockquote', offset: 8, length: 1 },
    { kind: 'pre', offset: 10, length: 1, language: 'diff' },
    { kind: 'pre', offset: 12, length: 1 },
  ]
  expect(toEntities(spans)).toEqual([
    { type: 'bold', offset: 0, length: 1 },
    { type: 'italic', offset: 2, length: 1 },
    { type: 'strikethrough', offset: 4, length: 1 },
    { type: 'code', offset: 6, length: 1 },
    { type: 'blockquote', offset: 8, length: 1 },
    { type: 'pre', offset: 10, length: 1, language: 'diff' },
    { type: 'pre', offset: 12, length: 1 },
  ])
  expect(Object.hasOwn(toEntities(spans)[6] ?? {}, 'language')).toBe(false)
})

test('toEntities splits styles around code', () => {
  expect(
    toEntities([
      { kind: 'bold', offset: 0, length: 10 },
      { kind: 'code', offset: 4, length: 2 },
    ]),
  ).toEqual([
    { type: 'bold', offset: 0, length: 4 },
    { type: 'code', offset: 4, length: 2 },
    { type: 'bold', offset: 6, length: 4 },
  ])
})

test('toEntities drops a blockquote holding code', () => {
  expect(
    toEntities([
      { kind: 'blockquote', offset: 0, length: 6 },
      { kind: 'code', offset: 4, length: 2 },
    ]),
  ).toEqual([{ type: 'code', offset: 4, length: 2 }])
  const kept: Span[] = [
    { kind: 'blockquote', offset: 0, length: 6 },
    { kind: 'bold', offset: 0, length: 3 },
  ]
  expect(toEntities(kept)).toEqual([
    { type: 'blockquote', offset: 0, length: 6 },
    { type: 'bold', offset: 0, length: 3 },
  ])
})

test('plain sends have no entities key', async () => {
  const { bot, sendMessage, editMessageText } = createSendBot()
  const messenger = createTelegramMessenger(bot, { id: 42 })
  await messenger.sendRequest('id1', plain('Q'), ['Yes'], false, undefined)
  await messenger.sendNotification(
    'id1',
    plain('hi'),
    { silent: false, dismissible: true },
    undefined,
  )
  await messenger.finalize({ chatId: 42, messageId: 5 }, plain('done'), {
    kind: 'cancelled',
  })
  for (const call of [
    ...sendMessage.mock.calls.map((c) => c[2]),
    editMessageText.mock.calls[0]?.[3],
  ]) {
    expect(call).not.toHaveProperty('entities')
  }
  expect(editMessageText).toHaveBeenCalledWith(42, 5, 'done', {
    reply_markup: { inline_keyboard: [] },
  })
})

test('markdown sends carry entities', async () => {
  const { bot, sendMessage } = createSendBot()
  await createTelegramMessenger(bot, { id: 42 }).sendRequest(
    'id1',
    RUN_LS,
    ['Yes'],
    false,
    undefined,
  )
  expect(sendMessage).toHaveBeenCalledWith(42, 'Run ls', {
    entities: [{ type: 'code', offset: 4, length: 2 }],
    reply_markup: {
      inline_keyboard: [[{ text: 'Yes', callback_data: 'id1:0' }]],
    },
  })
  expect(sendMessage.mock.calls[0]?.[2]).not.toHaveProperty('parse_mode')
})

test('a 400 on a formatted send retries once as plain', async () => {
  const log = vi.fn()
  const { bot, sendMessage } = createSendBot(createRejection(400, REJECTED_ENTITIES))
  const reference = await createTelegramMessenger(bot, { id: 42 }, new Map(), log).sendRequest(
    'id1',
    RUN_LS,
    ['Yes'],
    false,
    undefined,
  )
  expect(reference).toEqual({ chatId: 42, messageId: 5, hasButtons: true })
  expect(sendMessage).toHaveBeenCalledTimes(2)
  expect(sendMessage.mock.calls[0]?.[2]).toHaveProperty('entities')
  expect(sendMessage.mock.calls[1]?.[1]).toBe('Run ls')
  expect(sendMessage.mock.calls[1]?.[2]).not.toHaveProperty('entities')
  expect(log).toHaveBeenCalledTimes(1)
  expect(log).toHaveBeenCalledWith(
    "telegram rejected formatting, sent as plain text: Bad Request: can't parse entities",
  )
})

test('a 400 on a plain send does not retry', async () => {
  const log = vi.fn()
  const { bot, sendMessage } = createSendBot(createRejection(400, 'Bad Request: chat not found'))
  await expect(
    createTelegramMessenger(bot, { id: 42 }, new Map(), log).sendRequest(
      'id1',
      plain('Q'),
      ['Yes'],
      false,
      undefined,
    ),
  ).rejects.toThrow('chat not found')
  expect(sendMessage).toHaveBeenCalledTimes(1)
  expect(log).not.toHaveBeenCalled()
})

test('a failed retry throws', async () => {
  const { bot, sendMessage } = createSendBot(
    createRejection(400, REJECTED_ENTITIES),
    createRejection(400, 'Bad Request: still bad'),
  )
  await expect(
    createTelegramMessenger(bot, { id: 42 }, new Map(), vi.fn()).sendRequest(
      'id1',
      RUN_LS,
      ['Yes'],
      false,
      undefined,
    ),
  ).rejects.toThrow('still bad')
  expect(sendMessage).toHaveBeenCalledTimes(2)
})

test('a non-400 failure on a formatted send does not retry', async () => {
  const log = vi.fn()
  const { bot, sendMessage } = createSendBot(createRejection(429, 'Too Many Requests'))
  await expect(
    createTelegramMessenger(bot, { id: 42 }, new Map(), log).sendRequest(
      'id1',
      RUN_LS,
      ['Yes'],
      false,
      undefined,
    ),
  ).rejects.toThrow('Too Many Requests')
  expect(sendMessage).toHaveBeenCalledTimes(1)
  expect(log).not.toHaveBeenCalled()
})

test('finalize carries entities and falls back the same way', async () => {
  const log = vi.fn()
  const reference = { chatId: 42, messageId: 5 }
  const ok = createSendBot()
  await createTelegramMessenger(ok.bot, { id: 42 }, new Map(), log).finalize(reference, RUN_LS, {
    kind: 'cancelled',
  })
  expect(ok.editMessageText).toHaveBeenCalledWith(42, 5, 'Run ls', {
    entities: [{ type: 'code', offset: 4, length: 2 }],
    reply_markup: { inline_keyboard: [] },
  })
  const rejected = createSendBot(createRejection(400, REJECTED_ENTITIES))
  await createTelegramMessenger(rejected.bot, { id: 42 }, new Map(), log).finalize(
    reference,
    RUN_LS,
    {
      kind: 'cancelled',
    },
  )
  expect(rejected.editMessageText).toHaveBeenCalledTimes(2)
  expect(rejected.editMessageText.mock.calls[1]?.[3]).toEqual({
    reply_markup: { inline_keyboard: [] },
  })
  expect(log).toHaveBeenCalledTimes(1)
})

test('notification falls back the same way', async () => {
  const log = vi.fn()
  const { bot, sendMessage } = createSendBot(createRejection(400, REJECTED_ENTITIES))
  await createTelegramMessenger(bot, { id: 42 }, new Map(), log).sendNotification(
    'id1',
    RUN_LS,
    { silent: true, dismissible: true },
    undefined,
  )
  expect(sendMessage).toHaveBeenCalledTimes(2)
  expect(sendMessage.mock.calls[1]?.[2]).toEqual({
    disable_notification: true,
    reply_markup: {
      inline_keyboard: [[{ text: 'Dismiss', callback_data: 'dismiss/id1' }]],
    },
  })
  expect(log).toHaveBeenCalledTimes(1)
})

const ATTACHMENT = { name: 'changes.diff', content: new Uint8Array([1, 2]) }
const SEND_ERROR = new Error('boom')

function createAttachmentBot() {
  const sendDocument = vi.fn(async (_chatId: number, _file: InputFile, _other: object) => ({
    chat: { id: 42 },
    message_id: 10,
  }))
  const sendMessage = vi.fn(async (_chatId: number, _text: string, _other: object) => ({
    chat: { id: 42 },
    message_id: 11,
  }))
  const deleteMessage = vi.fn(async (_chatId: number, _messageId: number) => true)
  const deleteMessages = vi.fn(async (_chatId: number, _messageIds: number[]) => true)
  const editMessageText = vi.fn(
    async (_chatId: number, _messageId: number, _text: string, _other: object) => true,
  )
  const log = vi.fn()
  const bot = {
    api: {
      sendDocument,
      sendMessage,
      deleteMessage,
      deleteMessages,
      editMessageText,
    },
  } as unknown as Bot
  return {
    sendDocument,
    sendMessage,
    deleteMessage,
    deleteMessages,
    editMessageText,
    log,
    messenger: createTelegramMessenger(bot, { id: 42 }, new Map(), log),
  }
}

test('a request with an attachment sends the document first, silently, then the question as a reply', async () => {
  const { messenger, sendDocument, sendMessage } = createAttachmentBot()
  const ref = await messenger.sendRequest(
    'id1',
    plain('Push?'),
    ['Push', 'Stop'],
    false,
    ATTACHMENT,
  )
  expect(sendDocument).toHaveBeenCalledWith(42, expect.any(InputFile), {
    disable_notification: true,
  })
  expect(sendDocument.mock.calls[0]?.[1].filename).toBe('changes.diff')
  expect(sendMessage).toHaveBeenCalledWith(42, 'Push?', {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Push', callback_data: 'id1:0' }],
        [{ text: 'Stop', callback_data: 'id1:1' }],
      ],
    },
    reply_parameters: { message_id: 10 },
  })
  expect(sendDocument.mock.invocationCallOrder[0]).toBeLessThan(
    sendMessage.mock.invocationCallOrder[0] ?? 0,
  )
  expect(ref).toEqual({
    chatId: 42,
    messageId: 11,
    hasButtons: true,
    documentMessageId: 10,
  })
})

test('a failed document send sends nothing else and throws', async () => {
  const { messenger, sendDocument, sendMessage, deleteMessage } = createAttachmentBot()
  sendDocument.mockRejectedValueOnce(SEND_ERROR)
  await expect(
    messenger.sendRequest('id1', plain('Push?'), ['Push'], false, ATTACHMENT),
  ).rejects.toBe(SEND_ERROR)
  expect(sendMessage).not.toHaveBeenCalled()
  expect(deleteMessage).not.toHaveBeenCalled()
})

test('a failed question send deletes the document and throws the send error', async () => {
  const { messenger, sendMessage, deleteMessage } = createAttachmentBot()
  sendMessage.mockRejectedValueOnce(SEND_ERROR)
  await expect(
    messenger.sendRequest('id1', plain('Push?'), ['Push'], false, ATTACHMENT),
  ).rejects.toBe(SEND_ERROR)
  expect(deleteMessage).toHaveBeenCalledWith(42, 10)
})

test('a failed cleanup delete is logged without the file name', async () => {
  const { messenger, sendMessage, deleteMessage, log } = createAttachmentBot()
  sendMessage.mockRejectedValueOnce(SEND_ERROR)
  deleteMessage.mockRejectedValueOnce(new Error('cannot delete'))
  await expect(
    messenger.sendRequest('id1', plain('Push?'), ['Push'], false, ATTACHMENT),
  ).rejects.toBe(SEND_ERROR)
  expect(log).toHaveBeenCalledTimes(1)
  expect(log).toHaveBeenCalledWith('failed to delete attachment: cannot delete')
  expect(JSON.stringify(log.mock.calls)).not.toContain('changes.diff')
})

test('a notification with an attachment replies to its document', async () => {
  const { messenger, sendDocument, sendMessage } = createAttachmentBot()
  const ref = await messenger.sendNotification(
    'id1',
    plain('done'),
    { silent: false, dismissible: true },
    ATTACHMENT,
  )
  expect(sendDocument).toHaveBeenCalledWith(42, expect.any(InputFile), {
    disable_notification: true,
  })
  expect(sendMessage).toHaveBeenCalledWith(42, 'done', {
    disable_notification: false,
    reply_markup: {
      inline_keyboard: [[{ text: 'Dismiss', callback_data: 'dismiss/id1' }]],
    },
    reply_parameters: { message_id: 10 },
  })
  expect(ref).toEqual({ chatId: 42, messageId: 11, documentMessageId: 10 })
})

test('a quiet notification with an attachment does not ping', async () => {
  const { messenger, sendDocument, sendMessage } = createAttachmentBot()
  await messenger.sendNotification(
    'id1',
    plain('done'),
    { silent: true, dismissible: true },
    ATTACHMENT,
  )
  expect(sendDocument.mock.calls[0]?.[2]).toEqual({
    disable_notification: true,
  })
  expect(sendMessage.mock.calls[0]?.[2]).toMatchObject({
    disable_notification: true,
  })
})

test('without an attachment nothing changes', async () => {
  const { messenger, sendDocument, sendMessage } = createAttachmentBot()
  const ref = await messenger.sendRequest('id1', plain('Push?'), ['Push'], false, undefined)
  expect(sendDocument).not.toHaveBeenCalled()
  expect(sendMessage).toHaveBeenCalledWith(42, 'Push?', {
    reply_markup: {
      inline_keyboard: [[{ text: 'Push', callback_data: 'id1:0' }]],
    },
  })
  expect(ref).toEqual({ chatId: 42, messageId: 11, hasButtons: true })
})

test('deleteMessage deletes the document too when the reference has one', async () => {
  const { messenger, deleteMessage, deleteMessages } = createAttachmentBot()
  await messenger.deleteMessage({
    chatId: 42,
    messageId: 11,
    documentMessageId: 10,
  })
  expect(deleteMessages).toHaveBeenCalledTimes(1)
  expect(deleteMessages).toHaveBeenCalledWith(42, [10, 11])
  expect(deleteMessage).not.toHaveBeenCalled()
})

test('deleteMessage of a reference without a document deletes only the message', async () => {
  const { messenger, deleteMessage, deleteMessages } = createAttachmentBot()
  await messenger.deleteMessage({ chatId: 42, messageId: 11 })
  expect(deleteMessage).toHaveBeenCalledWith(42, 11)
  expect(deleteMessages).not.toHaveBeenCalled()
})

test('finalize edits only the question', async () => {
  const { messenger, editMessageText, deleteMessage, deleteMessages } = createAttachmentBot()
  await messenger.finalize(
    { chatId: 42, messageId: 11, hasButtons: true, documentMessageId: 10 },
    plain('done'),
    { kind: 'cancelled' },
  )
  expect(editMessageText).toHaveBeenCalledTimes(1)
  expect(editMessageText).toHaveBeenCalledWith(42, 11, 'done', expect.any(Object))
  expect(deleteMessage).not.toHaveBeenCalled()
  expect(deleteMessages).not.toHaveBeenCalled()
})

test('a restored overdue notification with a document deletes both messages', async () => {
  const { messenger, deleteMessage, deleteMessages } = createAttachmentBot()
  const service = new NotificationService(messenger)
  service.restore([
    {
      id: 'id1',
      reference: { chatId: 42, messageId: 11, documentMessageId: 10 },
      expiresAtMs: 0,
    },
  ])
  await service.deleteOverdue()
  expect(deleteMessages).toHaveBeenCalledWith(42, [10, 11])
  expect(deleteMessage).not.toHaveBeenCalled()
})

test('a restored overdue notification saved before attachments deletes one message', async () => {
  const { messenger, deleteMessage, deleteMessages } = createAttachmentBot()
  const service = new NotificationService(messenger)
  service.restore([{ id: 'id1', reference: { chatId: 42, messageId: 11 }, expiresAtMs: 0 }])
  await service.deleteOverdue()
  expect(deleteMessage).toHaveBeenCalledWith(42, 11)
  expect(deleteMessages).not.toHaveBeenCalled()
})
