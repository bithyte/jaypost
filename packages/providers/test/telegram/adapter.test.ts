import { expect, test, vi } from 'vite-plus/test'
import { Bot, GrammyError, InputFile } from 'grammy'
import type { UserFromGetMe } from 'grammy/types'
import type { Span } from '@jaypost/core'
import {
  ApprovalService,
  BUTTONS_ONLY_REPLY,
  NOT_OPEN_REPLY,
  NotificationService,
  OWNER_COMMANDS,
  OwnerConversation,
  PAIRED_REPLY,
  Pairing,
  QUIET_COMMANDS,
  WRONG_CODE_REPLY,
} from '@jaypost/core'
import {
  createTelegramMessenger,
  registerCommandHandler,
  registerMessageHandler,
  setCommandMenu,
  registerTapHandler,
  toEntities,
  formatPairingInstructions,
  formatLegacyInstructions,
} from '../../src/telegram/index.ts'
import { receiveReplyTo } from '@jaypost/testing'

const plain = (text: string) => ({ text, spans: [] })
const pairedAs =
  (...ids: string[]) =>
  (senderId: string): boolean =>
    ids.includes(senderId)

const attempt = (pairing: Pairing) => (senderId: string, text: string) =>
  pairing.attempt(senderId, text)

test('sendRequest sends plain text with one button per row', async () => {
  const sendMessage = vi.fn(async () => ({ message_id: 5, chat: { id: 42 } }))
  const bot = { api: { sendMessage } } as unknown as Bot
  const ref = await createTelegramMessenger(bot, new OwnerConversation()).sendRequest(
    'id1',
    plain('Deploy?'),
    ['Yes', 'No'],
    false,
    undefined,
    '42',
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
  await createTelegramMessenger(bot, new OwnerConversation()).sendRequest(
    'id1',
    plain('Branch?'),
    ['main'],
    true,
    undefined,
    '42',
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
  const ref = await createTelegramMessenger(bot, new OwnerConversation()).sendRequest(
    'id1',
    plain('Branch?'),
    [],
    true,
    undefined,
    '42',
  )
  expect(ref).toEqual({ chatId: 42, messageId: 5, hasButtons: false })
  expect(sendMessage).toHaveBeenCalledWith(
    42,
    'Branch?\n\nReply to this message with your answer.',
    {},
  )
})

test('send tracks the question and finalize forgets it', async () => {
  const conversation = new OwnerConversation()
  const bot = {
    api: {
      sendMessage: vi.fn(async () => sentMessage),
      editMessageText: vi.fn(async () => true),
    },
  } as unknown as Bot
  const messenger = createTelegramMessenger(bot, conversation)
  const ref = await messenger.sendRequest('id1', plain('Branch?'), [], true, undefined, '42')
  const tracked = receiveReplyTo(conversation, '42:5', '42')
  expect(tracked.outcome).toEqual({ kind: 'answered' })
  expect(tracked.reply).toHaveBeenCalledWith('id1', 'x')
  await messenger.finalize(ref, plain('done'), {
    kind: 'replied',
    answer: 'x',
  })
  expect(receiveReplyTo(conversation, '42:5', '42').outcome).toEqual({
    kind: 'refused',
    text: NOT_OPEN_REPLY,
  })
})

test('a failed final edit still forgets the question', async () => {
  const conversation = new OwnerConversation()
  const bot = {
    api: {
      sendMessage: vi.fn(async () => sentMessage),
      editMessageText: vi.fn(async () => {
        throw new Error('message is not modified')
      }),
    },
  } as unknown as Bot
  const messenger = createTelegramMessenger(bot, conversation)
  const ref = await messenger.sendRequest('id1', plain('Branch?'), [], true, undefined, '42')
  expect(receiveReplyTo(conversation, '42:5', '42').outcome).toEqual({ kind: 'answered' })
  await expect(messenger.finalize(ref, plain('done'), { kind: 'cancelled' })).rejects.toThrow(
    'message is not modified',
  )
  expect(receiveReplyTo(conversation, '42:5', '42').outcome).toEqual({
    kind: 'refused',
    text: NOT_OPEN_REPLY,
  })
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
  await createTelegramMessenger(bot, new OwnerConversation()).finalize(reference, plain('done'), {
    kind: 'cancelled',
  })
  expect(editMessageText).toHaveBeenCalledWith(42, 5, 'done', extra)
})

test('update keeps the keyboard', async () => {
  const editMessageText = vi.fn(
    async (_chatId: number, _messageId: number, _text: string, _other: object) => true,
  )
  const bot = { api: { editMessageText } } as unknown as Bot
  await createTelegramMessenger(bot, new OwnerConversation()).update(
    { chatId: 42, messageId: 5, hasButtons: true },
    plain('Deploy?\n\nVotes: 1 Yes, 2 …'),
    { id: 'id1', options: ['Yes', 'No'] },
  )
  expect(editMessageText).toHaveBeenCalledWith(42, 5, 'Deploy?\n\nVotes: 1 Yes, 2 …', {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Yes', callback_data: 'id1:0' }],
        [{ text: 'No', callback_data: 'id1:1' }],
      ],
    },
  })
})

test('update without buttons sends no keyboard and leaves the question open', async () => {
  const conversation = new OwnerConversation()
  const editMessageText = vi.fn(
    async (_chatId: number, _messageId: number, _text: string, _other: object) => true,
  )
  const bot = { api: { sendMessage: vi.fn(async () => sentMessage), editMessageText } }
  const messenger = createTelegramMessenger(bot as unknown as Bot, conversation)
  const ref = await messenger.sendRequest('id1', plain('Branch?'), [], true, undefined, '42')
  await messenger.update(ref, plain('Branch?\n\nVotes: 1 …'), undefined)
  expect(editMessageText).toHaveBeenCalledWith(42, 5, 'Branch?\n\nVotes: 1 …', {})
  expect(receiveReplyTo(conversation, '42:5', '42').outcome).toEqual({ kind: 'answered' })
})

test('restart expiry of a saved text-only request sends no reply_markup', async () => {
  const editMessageText = vi.fn(
    async (_chatId: number, _messageId: number, _text: string, _other: object) => true,
  )
  const bot = { api: { editMessageText } } as unknown as Bot
  const service = new ApprovalService(
    createTelegramMessenger(bot, new OwnerConversation()),
    () => at,
  )
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
    message: unknown = { message_id: 11, chat: { id: 42, type: 'private' } },
    { withoutMessage = false }: { readonly withoutMessage?: boolean } = {},
  ) => {
    const answerCallbackQuery = vi.fn(async () => true)
    const apiDeleteMessage = vi.fn(async (_chatId: number, _messageId: number) => true)
    const p = handler({
      from: { id: fromId },
      callbackQuery: { data, message: withoutMessage ? undefined : message },
      answerCallbackQuery,
      deleteMessage,
      api: { deleteMessage: apiDeleteMessage },
    })
    return { answerCallbackQuery, deleteMessage, apiDeleteMessage, p }
  }
  return { bot: { on, botInfo: { id: 99 } } as unknown as Bot, on, run }
}

function createTapHandlers(
  answer: (id: string, optionIndex: number) => 'accepted' | 'expired' = () => 'accepted',
  dismiss: (id: string) => boolean = () => true,
) {
  return {
    answer: vi.fn(answer),
    reply: vi.fn((_id: string, _text: string) => 'accepted' as const),
    dismiss: vi.fn(dismiss),
    isPaired: (senderId: string) => senderId === '42',
  }
}

test('handler: owner accepted answers silently', async () => {
  const { bot, on, run } = fakeBot()
  const handlers = createTapHandlers()
  registerTapHandler(bot, new OwnerConversation(), handlers)
  expect(on).toHaveBeenCalledWith('callback_query:data', expect.any(Function))
  const { answerCallbackQuery, p } = run(42, 'abc:0')
  await p
  expect(handlers.answer).toHaveBeenCalledWith('abc', 0)
  expect(answerCallbackQuery).toHaveBeenCalledWith()
})

test('handler: expired shows Expired', async () => {
  const { bot, run } = fakeBot()
  registerTapHandler(
    bot,
    new OwnerConversation(),
    createTapHandlers(() => 'expired'),
  )
  const { answerCallbackQuery, p } = run(42, 'abc:0')
  await p
  expect(answerCallbackQuery).toHaveBeenCalledWith({ text: 'Expired' })
})

test('handler: non-owner ignored, tap not called, no text', async () => {
  const { bot, run } = fakeBot()
  const handlers = createTapHandlers()
  const conversation = new OwnerConversation()
  conversation.track('42:5', 'abc', false, '42')
  registerTapHandler(bot, conversation, handlers)
  const { answerCallbackQuery, p } = run(7, 'abc:0')
  await p
  expect(handlers.answer).not.toHaveBeenCalled()
  expect(answerCallbackQuery).toHaveBeenCalledWith()
})

test("a voter's tap on their message answers it and the owner's is ignored", async () => {
  const sendMessage = vi.fn(async () => ({ message_id: 5, chat: { id: 222 } }))
  const conversation = new OwnerConversation()
  const messenger = createTelegramMessenger(
    { api: { sendMessage } } as unknown as Bot,
    conversation,
  )
  await messenger.sendRequest('id1', plain('Deploy?'), ['Yes', 'No'], false, undefined, '222')
  expect(sendMessage).toHaveBeenCalledWith(222, 'Deploy?', expect.any(Object))
  const { bot, run } = fakeBot()
  const handlers = createTapHandlers()
  registerTapHandler(bot, conversation, handlers)
  const message = { message_id: 5, chat: { id: 222, type: 'private' } }
  await run(42, 'id1:1', undefined, message).p
  expect(handlers.answer).not.toHaveBeenCalled()
  await run(222, 'id1:0', undefined, message).p
  expect(handlers.answer).toHaveBeenCalledWith('id1', 0)
  expect(handlers.answer).toHaveBeenCalledTimes(1)
})

test('handler: an owner tap on an inaccessible message still answers', async () => {
  const { bot, run } = fakeBot()
  const handlers = createTapHandlers()
  registerTapHandler(bot, new OwnerConversation(), handlers)
  const { answerCallbackQuery, p } = run(42, 'abc:0', undefined, {
    message_id: 11,
    chat: { id: 42, type: 'private' },
    date: 0,
  })
  await p
  expect(handlers.answer).toHaveBeenCalledWith('abc', 0)
  expect(answerCallbackQuery).toHaveBeenCalledWith()
})

test('handler: a tap without a message is ignored and still answered', async () => {
  const { bot, run } = fakeBot()
  const handlers = createTapHandlers()
  registerTapHandler(bot, new OwnerConversation(), handlers)
  const { answerCallbackQuery, p } = run(42, 'abc:0', undefined, undefined, {
    withoutMessage: true,
  })
  await p
  expect(handlers.answer).not.toHaveBeenCalled()
  expect(answerCallbackQuery).toHaveBeenCalledWith()
})

test('handler: a tap outside a private chat is ignored', async () => {
  const { bot, run } = fakeBot()
  const handlers = createTapHandlers()
  registerTapHandler(bot, new OwnerConversation(), handlers)
  const group = { message_id: 11, chat: { id: -5, type: 'group' } }
  const tap = run(42, 'abc:0', undefined, group)
  const dismiss = run(42, 'dismiss/id1', undefined, group)
  await tap.p
  await dismiss.p
  expect(handlers.answer).not.toHaveBeenCalled()
  expect(handlers.dismiss).not.toHaveBeenCalled()
  expect(dismiss.deleteMessage).not.toHaveBeenCalled()
  expect(tap.answerCallbackQuery).toHaveBeenCalledWith()
  expect(dismiss.answerCallbackQuery).toHaveBeenCalledWith()
})

test('handler: owner dismiss deletes the message and calls dismiss', async () => {
  const { bot, run } = fakeBot()
  const handlers = createTapHandlers()
  registerTapHandler(bot, new OwnerConversation(), handlers)
  const { answerCallbackQuery, deleteMessage, p } = run(42, 'dismiss/id1')
  await p
  expect(handlers.dismiss).toHaveBeenCalledWith('id1')
  expect(deleteMessage).toHaveBeenCalledTimes(1)
  expect(answerCallbackQuery).toHaveBeenCalledWith()
  expect(handlers.answer).not.toHaveBeenCalled()
})

test('handler: dismiss for unknown id still deletes the message', async () => {
  const { bot, run } = fakeBot()
  registerTapHandler(
    bot,
    new OwnerConversation(),
    createTapHandlers(undefined, () => false),
  )
  const { answerCallbackQuery, deleteMessage, p } = run(42, 'dismiss/gone')
  await p
  expect(deleteMessage).toHaveBeenCalledTimes(1)
  expect(answerCallbackQuery).toHaveBeenCalledWith()
})

test('handler: failed dismiss delete is logged and the tap answered', async () => {
  const { bot, run } = fakeBot()
  const log = vi.fn()
  registerTapHandler(bot, new OwnerConversation(), createTapHandlers(), log)
  const deleteMessage = vi.fn(async () => {
    throw new Error('message to delete not found')
  })
  const { answerCallbackQuery, p } = run(42, 'dismiss/id1', deleteMessage)
  await expect(p).resolves.toBeUndefined()
  expect(log).toHaveBeenCalledWith('failed to delete notification: message to delete not found')
  expect(answerCallbackQuery).toHaveBeenCalledWith()
})

const DISMISSED_MESSAGE = { message_id: 11, chat: { id: 42, type: 'private' } }

test("handler: dismiss also deletes the bot's document the message replies to", async () => {
  const { bot, run } = fakeBot()
  registerTapHandler(bot, new OwnerConversation(), createTapHandlers())
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
  registerTapHandler(bot, new OwnerConversation(), createTapHandlers())
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
  registerTapHandler(bot, new OwnerConversation(), createTapHandlers())
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
  registerTapHandler(bot, new OwnerConversation(), createTapHandlers(), log)
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
  const handlers = createTapHandlers()
  registerTapHandler(bot, new OwnerConversation(), handlers)
  const { answerCallbackQuery, deleteMessage, p } = run(7, 'dismiss/id1')
  await p
  expect(handlers.dismiss).not.toHaveBeenCalled()
  expect(deleteMessage).not.toHaveBeenCalled()
  expect(answerCallbackQuery).toHaveBeenCalledWith()
})

test('sendNotification sends text with one Dismiss button', async () => {
  const sendMessage = vi.fn(async () => ({ message_id: 5, chat: { id: 42 } }))
  const bot = { api: { sendMessage } } as unknown as Bot
  const ref = await createTelegramMessenger(bot, new OwnerConversation()).sendNotification(
    'id1',
    plain('hi'),
    { silent: false, dismissible: true, recipient: '42' },
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
  const ref = await createTelegramMessenger(bot, new OwnerConversation()).sendNotification(
    'id1',
    plain('hi'),
    { silent: false, dismissible: false, recipient: '42' },
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
  await createTelegramMessenger(bot, new OwnerConversation()).sendNotification(
    'id1',
    plain('hi'),
    { silent: true, dismissible: true, recipient: '42' },
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
  await createTelegramMessenger(bot, new OwnerConversation()).sendRequest(
    'id1',
    plain('hi'),
    ['Yes', 'No'],
    false,
    undefined,
    '42',
  )
  expect(Object.hasOwn(sendMessage.mock.calls[0]?.[2] ?? {}, 'disable_notification')).toBe(false)
})

test('sendNotification throws without a recipient', async () => {
  const sendMessage = vi.fn()
  const bot = { api: { sendMessage } } as unknown as Bot
  await expect(
    createTelegramMessenger(bot, new OwnerConversation()).sendNotification(
      'id1',
      plain('hi'),
      { silent: true, dismissible: true, recipient: undefined },
      undefined,
    ),
  ).rejects.toThrow('message has no recipient')
  expect(sendMessage).not.toHaveBeenCalled()
})

test('deleteMessage deletes by reference', async () => {
  const deleteMessage = vi.fn(async () => true)
  const bot = { api: { deleteMessage } } as unknown as Bot
  await createTelegramMessenger(bot, new OwnerConversation()).deleteMessage({
    chatId: 42,
    messageId: 5,
  })
  expect(deleteMessage).toHaveBeenCalledWith(42, 5)
})

test('messenger sends to the recipient it is given', async () => {
  const sendMessage = vi.fn(async () => ({ message_id: 5, chat: { id: 9 } }))
  const bot = { api: { sendMessage } } as unknown as Bot
  const m = createTelegramMessenger(bot, new OwnerConversation())
  await expect(
    m.sendRequest('id1', plain('Q'), ['Yes'], false, undefined, undefined),
  ).rejects.toThrow('message has no recipient')
  expect(sendMessage).not.toHaveBeenCalled()
  await m.sendRequest('id1', plain('Q'), ['Yes'], false, undefined, '9')
  expect(sendMessage).toHaveBeenCalledWith(9, 'Q', expect.anything())
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

test('command handler replies to the owner with the core text', async () => {
  const { bot, handlers } = createCommandBot()
  const command = vi.fn(
    (name: string, argument: string, senderId: string | undefined) =>
      `${name}:${argument}:${senderId}`,
  )
  registerCommandHandler(bot, new OwnerConversation(), OWNER_COMMANDS, {
    isPaired: pairedAs('9'),
    command,
  })
  expect([...handlers.keys()]).toEqual(['pending', 'cancel', 'history'])
  const context = createCommandContext({ match: '5' })
  await handlers.get('history')?.(
    context,
    vi.fn(async () => {}),
  )
  expect(context.reply).toHaveBeenCalledWith('history:5:9')
})

test('command handler is silent for strangers, groups and channel posts', async () => {
  const { bot, handlers } = createCommandBot()
  const command = vi.fn(() => 'text')
  registerCommandHandler(bot, new OwnerConversation(), OWNER_COMMANDS, {
    isPaired: pairedAs('9'),
    command,
  })
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

test('command handler is silent while nobody is paired', async () => {
  const { bot, handlers } = createCommandBot()
  const command = vi.fn(() => 'text')
  registerCommandHandler(bot, new OwnerConversation(), OWNER_COMMANDS, {
    isPaired: pairedAs(),
    command,
  })
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
  registerCommandHandler(bot, new OwnerConversation(), OWNER_COMMANDS, {
    isPaired: pairedAs('9'),
    command: () => undefined,
  })
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

type MessageContext = {
  readonly from: { readonly id: number; readonly is_bot: boolean }
  readonly chat: { readonly id: number; readonly type: string }
  readonly message: {
    readonly message_id: number
    readonly text?: string
    readonly reply_to_message?: { readonly message_id: number; readonly from?: { id: number } }
  }
  readonly reply: ReturnType<typeof vi.fn>
}

function setupMessageHandler(
  options: {
    readonly text?: string
    readonly from?: { readonly id: number; readonly is_bot?: boolean }
    readonly chat?: { readonly id: number; readonly type: string }
    readonly replyTo?: { readonly message_id: number; readonly from?: { id: number } }
    readonly conversation?: OwnerConversation
    readonly pair?: (
      senderId: string,
      text: string,
    ) => 'paired' | 'wrong' | 'blocked' | 'notPairing'
    readonly contextReply?: ReturnType<typeof vi.fn>
  } = {},
) {
  let handler: (context: MessageContext) => Promise<void> = async () => {}
  const on = vi.fn((_filter: string, registered: typeof handler) => {
    handler = registered
  })
  const setMyCommands = vi.fn(async (_commands: unknown, _options: unknown) => true)
  const bot = { on, botInfo: { id: 100 }, api: { setMyCommands } } as unknown as Bot
  const conversation = options.conversation ?? new OwnerConversation()
  if (options.conversation === undefined) {
    conversation.track('42:7', 'q1', true, '42')
  }
  const handlers = {
    answer: vi.fn((_id: string, _optionIndex: number) => 'accepted' as const),
    reply: vi.fn((_id: string, _text: string) => 'accepted' as const),
    dismiss: vi.fn((_id: string) => true),
    isPaired: (senderId: string) => senderId === '42',
    listPaired: () => ['42'],
    ...(options.pair !== undefined && { pair: options.pair }),
    commands: OWNER_COMMANDS,
    command: vi.fn(() => undefined),
    fatal: vi.fn(),
  }
  const log = vi.fn()
  registerMessageHandler(bot, conversation, handlers, log)
  const contextReply = options.contextReply ?? vi.fn(async () => {})
  const run = () =>
    handler({
      from: { is_bot: false, ...(options.from ?? { id: 42 }) },
      chat: options.chat ?? { id: 42, type: 'private' },
      message: {
        message_id: 50,
        ...(options.text !== undefined && { text: options.text }),
        ...(options.replyTo !== undefined && { reply_to_message: options.replyTo }),
      },
      reply: contextReply,
    })
  return { on, conversation, handlers, setMyCommands, log, contextReply, run }
}

test('message handler registers on message', () => {
  const { on } = setupMessageHandler()
  expect(on).toHaveBeenCalledWith('message', expect.any(Function))
})

test('message handler settles silently', async () => {
  const { handlers, contextReply, run } = setupMessageHandler({
    text: ' yes ',
    replyTo: { message_id: 7, from: { id: 100 } },
  })
  await run()
  expect(handlers.reply).toHaveBeenCalledWith('q1', 'yes')
  expect(contextReply).not.toHaveBeenCalled()
})

test('message handler answers a refusal as a reply to the owner message', async () => {
  const conversation = new OwnerConversation()
  conversation.track('42:7', 'q1', false, '42')
  const { contextReply, run } = setupMessageHandler({
    conversation,
    text: 'hi',
    replyTo: { message_id: 7, from: { id: 100 } },
  })
  await run()
  expect(contextReply).toHaveBeenCalledWith(BUTTONS_ONLY_REPLY, {
    reply_parameters: { message_id: 50 },
  })
})

test('a reply to an untracked bot message says not open', async () => {
  const { contextReply, run } = setupMessageHandler({
    conversation: new OwnerConversation(),
    text: 'hi',
    replyTo: { message_id: 7, from: { id: 100 } },
  })
  await run()
  expect(contextReply).toHaveBeenCalledWith(NOT_OPEN_REPLY, {
    reply_parameters: { message_id: 50 },
  })
})

test('message handler pairs and sets the command menu', async () => {
  const { contextReply, setMyCommands, run } = setupMessageHandler({
    conversation: new OwnerConversation(),
    pair: () => 'paired',
    from: { id: 9 },
    chat: { id: 9, type: 'private' },
    text: '/start K7QM4XPD',
  })
  await run()
  expect(contextReply).toHaveBeenCalledWith(PAIRED_REPLY)
  expect(contextReply.mock.calls[0]).toHaveLength(1)
  await vi.waitFor(() => expect(setMyCommands).toHaveBeenCalledTimes(1))
  expect(setMyCommands.mock.calls[0]?.[1]).toEqual({ scope: { type: 'chat', chat_id: 9 } })
})

test('message handler sends the wrong-code hint', async () => {
  const { contextReply, run } = setupMessageHandler({
    conversation: new OwnerConversation(),
    pair: () => 'wrong',
    from: { id: 9 },
    chat: { id: 9, type: 'private' },
    text: 'nope',
  })
  await run()
  expect(contextReply).toHaveBeenCalledWith(WRONG_CODE_REPLY)
  expect(contextReply.mock.calls[0]).toHaveLength(1)
})

test('message handler ignores bots and group chats', async () => {
  const fromBot = setupMessageHandler({
    text: 'hi',
    from: { id: 42, is_bot: true },
    replyTo: { message_id: 7, from: { id: 100 } },
  })
  const group = setupMessageHandler({
    text: 'hi',
    chat: { id: -5, type: 'group' },
    replyTo: { message_id: 7, from: { id: 100 } },
  })
  await fromBot.run()
  await group.run()
  expect(fromBot.handlers.reply).not.toHaveBeenCalled()
  expect(fromBot.contextReply).not.toHaveBeenCalled()
  expect(group.handlers.reply).not.toHaveBeenCalled()
  expect(group.contextReply).not.toHaveBeenCalled()
})

test('a failed bot reply is logged, not thrown', async () => {
  const { log, run } = setupMessageHandler({
    conversation: new OwnerConversation(),
    text: 'hi',
    replyTo: { message_id: 7, from: { id: 100 } },
    contextReply: vi.fn(async () => {
      throw new Error('boom')
    }),
  })
  await expect(run()).resolves.toBeUndefined()
  expect(log).toHaveBeenCalledWith('failed to reply: boom')
})

test('a failed pairing reply is logged and the menu is still set', async () => {
  const { setMyCommands, log, run } = setupMessageHandler({
    conversation: new OwnerConversation(),
    pair: () => 'paired',
    from: { id: 9 },
    chat: { id: 9, type: 'private' },
    text: '/start K7QM4XPD',
    contextReply: vi.fn(async () => {
      throw new Error('boom')
    }),
  })
  await expect(run()).resolves.toBeUndefined()
  expect(log).toHaveBeenCalledWith('failed to reply: boom')
  await vi.waitFor(() => expect(setMyCommands).toHaveBeenCalledTimes(1))
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

function createDispatchHandlers(
  command: (name: string, argument: string, senderId: string | undefined) => string | undefined,
  pair?: (senderId: string, text: string) => 'paired' | 'wrong' | 'blocked' | 'notPairing',
  isPaired: (senderId: string) => boolean = (senderId) => senderId === '9',
) {
  return {
    answer: vi.fn((_id: string, _optionIndex: number) => 'accepted' as const),
    reply: vi.fn((_id: string, _text: string) => 'accepted' as const),
    dismiss: vi.fn((_id: string) => true),
    isPaired,
    listPaired: () => [],
    ...(pair !== undefined && { pair }),
    commands: [...OWNER_COMMANDS, ...QUIET_COMMANDS],
    command,
    fatal: vi.fn(),
  }
}

function registerDispatchHandlers(
  bot: Bot,
  conversation: OwnerConversation,
  handlers: ReturnType<typeof createDispatchHandlers>,
): void {
  registerCommandHandler(bot, conversation, handlers.commands, handlers)
  registerMessageHandler(bot, conversation, handlers)
}

test('/mute@mybot reaches the core with its argument', async () => {
  const { bot, calls } = createDispatchBot()
  const command = vi.fn(() => 'ok')
  registerDispatchHandlers(bot, new OwnerConversation(), createDispatchHandlers(command))
  await bot.handleUpdate(textUpdate('/mute@mybot 2h'))
  expect(command).toHaveBeenCalledWith('mute', '2h', '9')
  expect(calls.map((call) => call.method)).toEqual(['sendMessage'])
  expect(calls[0]?.payload).toMatchObject({ text: 'ok' })
})

test('quiet commands from strangers, groups or while unpaired get nothing and never reach pairing', async () => {
  const { bot, calls } = createDispatchBot()
  const command = vi.fn(() => 'ok')
  const pair = vi.fn(() => 'wrong' as const)
  registerDispatchHandlers(bot, new OwnerConversation(), createDispatchHandlers(command, pair))
  await bot.handleUpdate(textUpdate('/mute 2h', 8))
  await bot.handleUpdate(textUpdate('/quiet off', 9, 'group'))
  const unpaired = createDispatchBot()
  registerDispatchHandlers(
    unpaired.bot,
    new OwnerConversation(),
    createDispatchHandlers(command, pair, () => false),
  )
  await unpaired.bot.handleUpdate(textUpdate('/mute'))
  expect(command).not.toHaveBeenCalled()
  expect(pair).not.toHaveBeenCalled()
  expect(calls).toEqual([])
  expect(unpaired.calls).toEqual([])
})

test('/start CODE still pairs with the command handler registered', async () => {
  const { bot, calls } = createDispatchBot()
  const pairing = new Pairing('K7QM4XPD')
  const conversation = new OwnerConversation()
  registerDispatchHandlers(bot, conversation, createDispatchHandlers(vi.fn(), attempt(pairing)))
  await bot.handleUpdate(textUpdate('/start K7QM4XPD'))
  expect(
    calls.filter((call) => call.method === 'sendMessage').map((call) => call.payload),
  ).toMatchObject([{ text: 'Paired. Approval requests will appear here.' }])
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
  const messenger = createTelegramMessenger(bot, new OwnerConversation())
  await messenger.sendRequest('id1', plain('Q'), ['Yes'], false, undefined, '42')
  await messenger.sendNotification(
    'id1',
    plain('hi'),
    { silent: false, dismissible: true, recipient: '42' },
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
  await createTelegramMessenger(bot, new OwnerConversation()).sendRequest(
    'id1',
    RUN_LS,
    ['Yes'],
    false,
    undefined,
    '42',
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
  const reference = await createTelegramMessenger(bot, new OwnerConversation(), log).sendRequest(
    'id1',
    RUN_LS,
    ['Yes'],
    false,
    undefined,
    '42',
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
    createTelegramMessenger(bot, new OwnerConversation(), log).sendRequest(
      'id1',
      plain('Q'),
      ['Yes'],
      false,
      undefined,
      '42',
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
    createTelegramMessenger(bot, new OwnerConversation(), vi.fn()).sendRequest(
      'id1',
      RUN_LS,
      ['Yes'],
      false,
      undefined,
      '42',
    ),
  ).rejects.toThrow('still bad')
  expect(sendMessage).toHaveBeenCalledTimes(2)
})

test('a non-400 failure on a formatted send does not retry', async () => {
  const log = vi.fn()
  const { bot, sendMessage } = createSendBot(createRejection(429, 'Too Many Requests'))
  await expect(
    createTelegramMessenger(bot, new OwnerConversation(), log).sendRequest(
      'id1',
      RUN_LS,
      ['Yes'],
      false,
      undefined,
      '42',
    ),
  ).rejects.toThrow('Too Many Requests')
  expect(sendMessage).toHaveBeenCalledTimes(1)
  expect(log).not.toHaveBeenCalled()
})

test('finalize carries entities and falls back the same way', async () => {
  const log = vi.fn()
  const reference = { chatId: 42, messageId: 5 }
  const ok = createSendBot()
  await createTelegramMessenger(ok.bot, new OwnerConversation(), log).finalize(reference, RUN_LS, {
    kind: 'cancelled',
  })
  expect(ok.editMessageText).toHaveBeenCalledWith(42, 5, 'Run ls', {
    entities: [{ type: 'code', offset: 4, length: 2 }],
    reply_markup: { inline_keyboard: [] },
  })
  const rejected = createSendBot(createRejection(400, REJECTED_ENTITIES))
  await createTelegramMessenger(rejected.bot, new OwnerConversation(), log).finalize(
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
  await createTelegramMessenger(bot, new OwnerConversation(), log).sendNotification(
    'id1',
    RUN_LS,
    { silent: true, dismissible: true, recipient: '42' },
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
    messenger: createTelegramMessenger(bot, new OwnerConversation(), log),
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
    '42',
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
    messenger.sendRequest('id1', plain('Push?'), ['Push'], false, ATTACHMENT, '42'),
  ).rejects.toBe(SEND_ERROR)
  expect(sendMessage).not.toHaveBeenCalled()
  expect(deleteMessage).not.toHaveBeenCalled()
})

test('a failed question send deletes the document and throws the send error', async () => {
  const { messenger, sendMessage, deleteMessage } = createAttachmentBot()
  sendMessage.mockRejectedValueOnce(SEND_ERROR)
  await expect(
    messenger.sendRequest('id1', plain('Push?'), ['Push'], false, ATTACHMENT, '42'),
  ).rejects.toBe(SEND_ERROR)
  expect(deleteMessage).toHaveBeenCalledWith(42, 10)
})

test('a failed cleanup delete is logged without the file name', async () => {
  const { messenger, sendMessage, deleteMessage, log } = createAttachmentBot()
  sendMessage.mockRejectedValueOnce(SEND_ERROR)
  deleteMessage.mockRejectedValueOnce(new Error('cannot delete'))
  await expect(
    messenger.sendRequest('id1', plain('Push?'), ['Push'], false, ATTACHMENT, '42'),
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
    { silent: false, dismissible: true, recipient: '42' },
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
    { silent: true, dismissible: true, recipient: '42' },
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
  const ref = await messenger.sendRequest('id1', plain('Push?'), ['Push'], false, undefined, '42')
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

test("sendRequest sends to the recipient's chat", async () => {
  const sendMessage = vi.fn(async () => ({ message_id: 5, chat: { id: 222 } }))
  const bot = { api: { sendMessage } } as unknown as Bot
  const ref = await createTelegramMessenger(bot, new OwnerConversation()).sendRequest(
    'id1',
    plain('Deploy?'),
    ['Yes'],
    false,
    undefined,
    '222',
  )
  expect(ref).toEqual({ chatId: 222, messageId: 5, hasButtons: true })
  expect(sendMessage).toHaveBeenCalledWith(222, 'Deploy?', expect.anything())
})
