import { expect, test, vi } from 'vite-plus/test'
import {
  BUTTONS_ONLY_REPLY,
  EXPIRED_REPLY,
  formatChoicePayload,
  formatDismissPayload,
  OWNER_COMMANDS,
  OwnerConversation,
  PAIRED_REPLY,
  WRONG_CODE_REPLY,
} from '@jaypost/core'
import {
  NOT_OWNER_COMMAND_REPLY,
  createDiscordMessenger,
  handleInteraction,
  handleMessage,
} from '../../src/discord/index.ts'
import type {
  DiscordClient,
  EventContext,
  IncomingInteraction,
  IncomingMessage,
} from '../../src/discord/index.ts'
import type { PairResult } from '@jaypost/core'
import { createFakeDiscord } from './fake.ts'

const OWNER_ID = '1'
const BOT_ID = 'bot1'

function setup(
  options: {
    readonly overrides?: Partial<DiscordClient>
    readonly ownerId?: string
    readonly pair?: (senderId: string, text: string) => PairResult
    readonly command?: (
      name: string,
      argument: string,
      senderId: string | undefined,
    ) => string | undefined
    readonly answer?: (id: string, optionIndex: number) => 'accepted' | 'expired'
  } = {},
) {
  const fake = createFakeDiscord(options.overrides)
  const conversation = new OwnerConversation()
  const pairedId = 'ownerId' in options ? options.ownerId : OWNER_ID
  const answer = vi.fn(options.answer ?? (() => 'accepted' as const))
  const reply = vi.fn((_id: string, _text: string) => 'accepted' as const)
  const dismiss = vi.fn((_id: string) => true)
  const command = vi.fn(options.command ?? (() => undefined))
  const pair = options.pair === undefined ? undefined : vi.fn(options.pair)
  const fatal = vi.fn()
  const log = vi.fn<(line: string) => void>()
  const context: EventContext = {
    client: fake.client,
    conversation,
    botId: BOT_ID,
    handlers: {
      answer,
      reply,
      dismiss,
      isPaired: (senderId) => senderId === pairedId,
      listPaired: () => (pairedId === undefined ? [] : [pairedId]),
      commands: OWNER_COMMANDS,
      command,
      fatal,
      ...(pair === undefined ? {} : { pair }),
    },
    log,
  }
  return {
    fake,
    conversation,
    answer,
    reply,
    dismiss,
    command,
    pair,
    log,
    context,
  }
}

function tap(customId: string, overrides: { userId?: string; isDirect?: boolean } = {}) {
  return {
    kind: 'button',
    id: 'i1',
    token: 'itoken',
    userId: OWNER_ID,
    isDirect: true,
    customId,
    channelId: 'dm1',
    messageId: 'm7',
    ...overrides,
  } satisfies IncomingInteraction
}

function slashCommand(
  name: string,
  argument: string,
  overrides: { userId?: string; isDirect?: boolean } = {},
) {
  return {
    kind: 'command',
    id: 'i2',
    token: 'ctoken',
    userId: OWNER_ID,
    isDirect: true,
    name,
    argument,
    ...overrides,
  } satisfies IncomingInteraction
}

function dm(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'u1',
    channelId: 'dm9',
    fromId: OWNER_ID,
    fromBot: false,
    isDirect: true,
    text: 'hello',
    replyTo: undefined,
    ...overrides,
  }
}

const ACKNOWLEDGE = { kind: 'acknowledge' } as const

test('the owner tapping an option answers and acknowledges', async () => {
  const { fake, answer, context } = setup()
  await handleInteraction(tap(formatChoicePayload('r1', 2)), context)
  expect(answer).toHaveBeenCalledWith('r1', 2)
  expect(fake.responses).toEqual([
    { interaction: { id: 'i1', token: 'itoken' }, response: ACKNOWLEDGE },
  ])
})

test('a tap on a settled request gets an ephemeral Expired', async () => {
  const { fake, answer, context } = setup({ answer: () => 'expired' })
  await handleInteraction(tap(formatChoicePayload('r1', 0)), context)
  expect(answer).toHaveBeenCalledWith('r1', 0)
  expect(fake.responses).toEqual([
    {
      interaction: { id: 'i1', token: 'itoken' },
      response: { kind: 'message', content: EXPIRED_REPLY, ephemeral: true },
    },
  ])
})

test("someone else's tap is acknowledged and ignored", async () => {
  const { fake, answer, dismiss, context } = setup()
  context.conversation.track('m1', 'r1', false, OWNER_ID)
  await handleInteraction(tap(formatChoicePayload('r1', 0), { userId: '2' }), context)
  await handleInteraction(tap(formatDismissPayload('n1'), { userId: '2' }), context)
  expect(answer).not.toHaveBeenCalled()
  expect(dismiss).not.toHaveBeenCalled()
  expect(fake.deleted).toEqual([])
  expect(fake.responses.map((entry) => entry.response)).toEqual([ACKNOWLEDGE, ACKNOWLEDGE])
})

test("a voter's tap on their message answers it and the owner's is ignored", async () => {
  const { fake, conversation, answer, log, context } = setup()
  const messenger = createDiscordMessenger(fake.client, conversation, log)
  const payload = formatChoicePayload('r1', 0)
  await messenger.sendRequest(
    'r1',
    { text: 'Deploy?', spans: [] },
    ['Yes', 'No'],
    false,
    undefined,
    '222',
  )
  expect(fake.openedFor).toEqual(['222'])
  await handleInteraction(tap(payload), context)
  expect(answer).not.toHaveBeenCalled()
  await handleInteraction(tap(payload, { userId: '222' }), context)
  expect(answer).toHaveBeenCalledWith('r1', 0)
  expect(answer).toHaveBeenCalledTimes(1)
  expect(fake.responses.map((entry) => entry.response)).toEqual([ACKNOWLEDGE, ACKNOWLEDGE])
})

test('a tap while unpaired is acknowledged and ignored', async () => {
  const { fake, answer, context } = setup({ ownerId: undefined })
  await handleInteraction(tap(formatChoicePayload('r1', 0), { userId: undefined }), context)
  expect(answer).not.toHaveBeenCalled()
  expect(fake.responses.map((entry) => entry.response)).toEqual([ACKNOWLEDGE])
})

test('the owner dismissing deletes the message and calls dismiss', async () => {
  const calls: string[] = []
  const { fake, dismiss, answer, context } = setup({
    overrides: {
      respond: async () => {
        calls.push('respond')
      },
      deleteMessage: async (channelId, messageId) => {
        calls.push(`delete ${channelId} ${messageId}`)
      },
    },
  })
  dismiss.mockImplementation(() => {
    calls.push('dismiss')
    return true
  })
  await handleInteraction(tap(formatDismissPayload('n1')), context)
  expect(dismiss).toHaveBeenCalledWith('n1')
  expect(answer).not.toHaveBeenCalled()
  expect(calls).toEqual(['dismiss', 'respond', 'delete dm1 m7'])
  expect(fake.responses).toEqual([])
})

test('a failed dismiss delete is logged', async () => {
  const { fake, dismiss, log, context } = setup({
    overrides: {
      deleteMessage: async () => {
        throw new Error('Unknown Message')
      },
    },
  })
  await expect(handleInteraction(tap(formatDismissPayload('n1')), context)).resolves.toBeUndefined()
  expect(dismiss).toHaveBeenCalledWith('n1')
  expect(fake.responses.map((entry) => entry.response)).toEqual([ACKNOWLEDGE])
  expect(log).toHaveBeenCalledWith('failed to delete notification: Unknown Message')
})

test('a failed interaction response is logged, not thrown', async () => {
  const { log, context } = setup({
    overrides: {
      respond: async () => {
        throw new Error('Unknown interaction')
      },
    },
  })
  await expect(
    handleInteraction(tap(formatChoicePayload('r1', 0)), context),
  ).resolves.toBeUndefined()
  await expect(handleInteraction(slashCommand('pending', ''), context)).resolves.toBeUndefined()
  expect(log.mock.calls).toEqual([
    ['failed to answer interaction: Unknown interaction'],
    ['failed to answer interaction: Unknown interaction'],
  ])
})

test('an owner command replies with the escaped command text', async () => {
  const { fake, command, context } = setup({ command: () => '2 pending\n- a*b' })
  await handleInteraction(slashCommand('history', '5'), context)
  expect(command).toHaveBeenCalledWith('history', '5', OWNER_ID)
  expect(fake.responses).toEqual([
    {
      interaction: { id: 'i2', token: 'ctoken' },
      response: { kind: 'message', content: '2 pending\n\\- a\\*b', ephemeral: false },
    },
  ])
})

test('an owner command with no reply text gets an ephemeral unknown command', async () => {
  const { fake, command, context } = setup()
  await handleInteraction(slashCommand('nope', ''), context)
  expect(command).toHaveBeenCalledWith('nope', '', OWNER_ID)
  expect(fake.responses.map((entry) => entry.response)).toEqual([
    { kind: 'message', content: 'Unknown command.', ephemeral: true },
  ])
})

test("a stranger's command gets the not-paired reply", async () => {
  const { fake, command, context } = setup({ command: () => 'secret' })
  await handleInteraction(slashCommand('pending', '', { userId: '2' }), context)
  expect(command).not.toHaveBeenCalled()
  expect(fake.responses.map((entry) => entry.response)).toEqual([
    { kind: 'message', content: NOT_OWNER_COMMAND_REPLY, ephemeral: true },
  ])
})

test('a command while unpaired gets the not-paired reply', async () => {
  const { fake, command, context } = setup({ ownerId: undefined, command: () => 'secret' })
  await handleInteraction(slashCommand('pending', '', { userId: undefined }), context)
  expect(command).not.toHaveBeenCalled()
  expect(fake.responses.map((entry) => entry.response)).toEqual([
    { kind: 'message', content: NOT_OWNER_COMMAND_REPLY, ephemeral: true },
  ])
})

test('other interactions are dropped', async () => {
  const { fake, log, context } = setup()
  await handleInteraction({ kind: 'other', id: 'i3', token: 'otoken' }, context)
  expect(fake.responses).toEqual([])
  expect(log).not.toHaveBeenCalled()
})

test("the bot's own messages never reach pairing or replies", async () => {
  const { fake, pair, reply, conversation, context } = setup({
    ownerId: undefined,
    pair: () => 'wrong',
  })
  conversation.track('m1', 'r1', true, OWNER_ID)
  await handleMessage(dm({ fromId: BOT_ID, fromBot: true, text: 'ABCDEFGH' }), context)
  await handleMessage(
    dm({ fromId: BOT_ID, fromBot: true, text: WRONG_CODE_REPLY, replyTo: undefined }),
    context,
  )
  expect(pair).not.toHaveBeenCalled()
  expect(reply).not.toHaveBeenCalled()
  expect(fake.created).toEqual([])
})

test("the bot's own messages never answer a question even if its id is the owner's", async () => {
  const { fake, reply, conversation, context } = setup({ ownerId: BOT_ID })
  conversation.track('m1', 'r1', true, OWNER_ID)
  await handleMessage(dm({ fromId: BOT_ID, fromBot: true, text: 'yes' }), context)
  expect(reply).not.toHaveBeenCalled()
  expect(fake.created).toEqual([])
})

test('server messages and interactions are ignored', async () => {
  const { fake, pair, reply, answer, dismiss, command, conversation, context } = setup({
    pair: () => 'paired',
    command: () => 'secret',
  })
  conversation.track('m1', 'r1', true, OWNER_ID)
  await handleMessage(dm({ isDirect: false, text: 'ABCDEFGH' }), context)
  await handleMessage(
    dm({ isDirect: false, text: 'yes', replyTo: { messageId: 'm1', fromId: BOT_ID } }),
    context,
  )
  expect(pair).not.toHaveBeenCalled()
  expect(reply).not.toHaveBeenCalled()
  expect(fake.created).toEqual([])
  await handleInteraction(tap(formatChoicePayload('r1', 0), { isDirect: false }), context)
  await handleInteraction(tap(formatDismissPayload('n1'), { isDirect: false }), context)
  await handleInteraction(slashCommand('pending', '', { isDirect: false }), context)
  expect(answer).not.toHaveBeenCalled()
  expect(dismiss).not.toHaveBeenCalled()
  expect(command).not.toHaveBeenCalled()
  expect(fake.deleted).toEqual([])
  expect(fake.responses.map((entry) => entry.response)).toEqual([
    ACKNOWLEDGE,
    ACKNOWLEDGE,
    { kind: 'message', content: NOT_OWNER_COMMAND_REPLY, ephemeral: true },
  ])
})

test('a typed reply to an open question settles it silently', async () => {
  const { fake, reply, context, conversation } = setup()
  conversation.track('m1', 'r1', true, OWNER_ID)
  await handleMessage(dm({ text: ' yes ', replyTo: { messageId: 'm1', fromId: BOT_ID } }), context)
  expect(reply).toHaveBeenCalledWith('r1', 'yes')
  expect(fake.created).toEqual([])
})

test('a reply to a buttons-only question gets the tap-a-button reply', async () => {
  const { fake, reply, context, conversation } = setup()
  conversation.track('m1', 'r1', false, OWNER_ID)
  const message = dm({ text: 'yes', replyTo: { messageId: 'm1', fromId: BOT_ID } })
  await handleMessage(message, context)
  expect(reply).not.toHaveBeenCalled()
  expect(fake.created).toEqual([
    {
      channelId: 'dm9',
      message: {
        content: BUTTONS_ONLY_REPLY,
        rows: [],
        silent: false,
        file: undefined,
        replyToMessageId: message.id,
      },
    },
  ])
})

test('a failed bot reply is logged, not thrown', async () => {
  const { log, context, conversation } = setup({
    overrides: {
      createMessage: async () => {
        throw new Error('Cannot send messages to this user')
      },
    },
  })
  conversation.track('m1', 'r1', false, OWNER_ID)
  await expect(
    handleMessage(dm({ text: 'yes', replyTo: { messageId: 'm1', fromId: BOT_ID } }), context),
  ).resolves.toBeUndefined()
  expect(log).toHaveBeenCalledWith('failed to reply: Cannot send messages to this user')
})

test('a dm with the code pairs the sender', async () => {
  const { fake, pair, context } = setup({
    ownerId: undefined,
    pair: () => 'paired',
  })
  await handleMessage(dm({ fromId: '5', text: ' ABCD-EFGH ' }), context)
  expect(pair).toHaveBeenCalledWith('5', 'ABCD-EFGH')
  expect(fake.created).toEqual([
    {
      channelId: 'dm9',
      message: { content: PAIRED_REPLY, rows: [], silent: false, file: undefined },
    },
  ])
})

test('a dm with a wrong code gets the wrong-code reply', async () => {
  const { fake, context } = setup({ ownerId: undefined, pair: () => 'wrong' })
  await handleMessage(dm({ fromId: '5', text: 'nope' }), context)
  expect(fake.created.map((entry) => entry.message.content)).toEqual([WRONG_CODE_REPLY])
})

test('a dm is not a pairing attempt when pairing is off', async () => {
  const { fake, context } = setup({ ownerId: undefined })
  await handleMessage(dm({ fromId: '5', text: 'ABCDEFGH' }), context)
  expect(fake.created).toEqual([])
})

test('a failed pairing reply is logged, not thrown', async () => {
  const { log, context } = setup({
    ownerId: undefined,
    pair: () => 'paired',
    overrides: {
      createMessage: async () => {
        throw new Error('boom')
      },
    },
  })
  await expect(handleMessage(dm({ fromId: '5', text: 'ABCDEFGH' }), context)).resolves.toBe(
    undefined,
  )
  expect(log).toHaveBeenCalledWith('failed to reply: boom')
})
