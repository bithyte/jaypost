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
import type { PairResult } from '@jaypost/core'
import {
  NOT_OWNER_COMMAND_REPLY,
  formatCommandHelp,
  handleAction,
  handleCommand,
  handleMessage,
  toOutgoingMessage,
} from '../../src/slack/index.ts'
import type {
  EventContext,
  IncomingAction,
  IncomingMessage,
  SlackClient,
} from '../../src/slack/index.ts'
import { createFakeSlack } from './fake.ts'

const OWNER_ID = 'U1'
const BOT_ID = 'UBOT'

function setup(
  options: {
    readonly overrides?: Partial<SlackClient>
    readonly ownerId?: string
    readonly pair?: (senderId: string, text: string) => PairResult
    readonly command?: (name: string, argument: string) => string | undefined
    readonly answer?: (id: string, optionIndex: number) => 'accepted' | 'expired'
  } = {},
) {
  const fake = createFakeSlack(options.overrides)
  const conversation = new OwnerConversation('ownerId' in options ? options.ownerId : OWNER_ID)
  const answer = vi.fn(options.answer ?? (() => 'accepted' as const))
  const reply = vi.fn((_id: string, _text: string) => 'accepted' as const)
  const dismiss = vi.fn((_id: string) => true)
  const command = vi.fn(options.command ?? (() => undefined))
  const pair = options.pair === undefined ? undefined : vi.fn(options.pair)
  const log = vi.fn<(line: string) => void>()
  const context: EventContext = {
    client: fake.client,
    conversation,
    botId: BOT_ID,
    handlers: {
      answer,
      reply,
      dismiss,
      commands: OWNER_COMMANDS,
      command,
      fatal: vi.fn(),
      ...(pair === undefined ? {} : { pair }),
    },
    log,
  }
  return { fake, conversation, context, answer, reply, dismiss, command, pair, log }
}

function tap(overrides: Partial<IncomingAction> = {}): IncomingAction {
  return {
    userId: OWNER_ID,
    channelId: 'D1',
    messageTs: '1.0',
    isDirect: true,
    actionId: formatChoicePayload('r1', 0),
    ...overrides,
  }
}

function dm(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channelId: 'D1',
    ts: '9.0',
    fromId: OWNER_ID,
    fromBot: false,
    isDirect: true,
    text: 'hello',
    thread: undefined,
    ...overrides,
  }
}

const plainMessage = (text: string) => toOutgoingMessage({ text, spans: [] }, [])

test('the owner tapping an option answers it and posts nothing', async () => {
  const { fake, context, answer } = setup()
  await handleAction(tap(), context)
  expect(answer).toHaveBeenCalledWith('r1', 0)
  expect([fake.posted, fake.ephemeral]).toEqual([[], []])
})

test('a tap on a settled request gets an ephemeral Expired', async () => {
  const { fake, context } = setup({ answer: () => 'expired' })
  await handleAction(tap(), context)
  expect(fake.ephemeral).toEqual([{ channelId: 'D1', userId: OWNER_ID, text: EXPIRED_REPLY }])
})

test("someone else's tap and a channel tap are ignored", async () => {
  const { fake, context, answer } = setup()
  await handleAction(tap({ userId: 'U9' }), context)
  await handleAction(tap({ channelId: 'C1', isDirect: false }), context)
  expect(answer).not.toHaveBeenCalled()
  expect(fake.ephemeral).toEqual([{ channelId: 'D1', userId: 'U9', text: EXPIRED_REPLY }])
})

test('the owner dismissing deletes the notification', async () => {
  const { fake, context, dismiss } = setup()
  await handleAction(tap({ actionId: formatDismissPayload('n1'), messageTs: '4.0' }), context)
  expect(dismiss).toHaveBeenCalledWith('n1')
  expect(fake.deleted).toEqual([{ channelId: 'D1', ts: '4.0' }])
})

test('a failed delete or ephemeral is logged, not thrown', async () => {
  const failing = async (): Promise<void> => {
    throw new Error('slack failed: channel_not_found')
  }
  const { context, log } = setup({
    answer: () => 'expired',
    overrides: { deleteMessage: failing, postEphemeral: failing },
  })
  await handleAction(tap(), context)
  await handleAction(tap({ actionId: formatDismissPayload('n1') }), context)
  expect(log.mock.calls).toEqual([
    ['failed to answer a tap: slack failed: channel_not_found'],
    ['failed to delete notification: slack failed: channel_not_found'],
  ])
})

test('a thread reply to an open text question answers it', async () => {
  const { conversation, context, reply, fake } = setup()
  conversation.track('D1/1.0', 'r1', true)
  await handleMessage(dm({ text: ' fine ', thread: { ts: '1.0', parentUserId: BOT_ID } }), context)
  expect(reply).toHaveBeenCalledWith('r1', 'fine')
  expect(fake.posted).toEqual([])
})

test('a thread reply to a buttons-only question gets an answer in the thread', async () => {
  const { conversation, context, fake } = setup()
  conversation.track('D1/1.0', 'r1', false)
  await handleMessage(dm({ thread: { ts: '1.0', parentUserId: BOT_ID } }), context)
  expect(fake.posted).toEqual([
    { channelId: 'D1', message: { ...plainMessage(BUTTONS_ONLY_REPLY), threadTs: '1.0' } },
  ])
})

test('a top-level refusal is answered in a new thread under the message', async () => {
  const { conversation, context, fake } = setup()
  conversation.track('D1/1.0', 'r1', true)
  conversation.track('D1/2.0', 'r2', true)
  await handleMessage(dm(), context)
  expect(fake.posted[0]?.message.threadTs).toBe('9.0')
})

test("the bot's own messages and channel messages are ignored", async () => {
  const { conversation, context, reply, fake } = setup()
  conversation.track('D1/1.0', 'r1', true)
  await handleMessage(dm({ fromId: BOT_ID, fromBot: true }), context)
  await handleMessage(dm({ channelId: 'C1', isDirect: false }), context)
  expect(reply).not.toHaveBeenCalled()
  expect(fake.posted).toEqual([])
})

test('a dm with the code pairs the sender, a wrong one gets the wrong-code reply', async () => {
  const { context, fake, conversation } = setup({
    ownerId: undefined,
    pair: (_senderId, text) => (text === 'ABCD-EFGH' ? 'paired' : 'wrong'),
  })
  await handleMessage(dm({ fromId: 'U5', text: 'nope' }), context)
  await handleMessage(dm({ fromId: 'U5', text: 'ABCD-EFGH' }), context)
  expect(fake.posted.map((call) => call.message)).toEqual([
    plainMessage(WRONG_CODE_REPLY),
    plainMessage(PAIRED_REPLY),
  ])
  expect(conversation.ownerId).toBe('U5')
})

test('a failed reply is logged, not thrown', async () => {
  const { context, log } = setup({
    ownerId: undefined,
    pair: () => 'paired',
    overrides: {
      postMessage: async () => {
        throw new Error('slack chat.postMessage failed: not_in_channel')
      },
    },
  })
  await handleMessage(dm({ text: 'CODE' }), context)
  expect(log.mock.calls).toEqual([
    ['failed to reply: slack chat.postMessage failed: not_in_channel'],
  ])
})

test('an owner command runs with its argument and posts the reply in the dm', async () => {
  const { context, command, fake } = setup({ command: () => 'No answers yet.' })
  await handleCommand(
    { userId: OWNER_ID, channelId: 'D1', isDirect: true, text: '  History   5 ' },
    context,
  )
  expect(command).toHaveBeenCalledWith('history', '5')
  expect(fake.posted).toEqual([{ channelId: 'D1', message: plainMessage('No answers yet.') }])
})

test('an unknown or empty command gets the command list', async () => {
  const { context, command, fake } = setup()
  await handleCommand({ userId: OWNER_ID, channelId: 'D1', isDirect: true, text: '' }, context)
  await handleCommand({ userId: OWNER_ID, channelId: 'D1', isDirect: true, text: 'wat' }, context)
  expect(command).not.toHaveBeenCalled()
  const help = formatCommandHelp(context)
  expect(help.split('\n')[0]).toBe('Usage: /jaypost <command> [argument]')
  expect(help).toContain('history: ')
  expect(fake.posted.map((call) => call.message)).toEqual([plainMessage(help), plainMessage(help)])
})

test('a command from anyone but the owner in their dm gets an ephemeral not-paired note', async () => {
  const { context, command, fake } = setup()
  await handleCommand({ userId: 'U9', channelId: 'D2', isDirect: true, text: 'pending' }, context)
  await handleCommand(
    { userId: OWNER_ID, channelId: 'C1', isDirect: false, text: 'pending' },
    context,
  )
  expect(command).not.toHaveBeenCalled()
  expect(fake.ephemeral).toEqual([
    { channelId: 'D2', userId: 'U9', text: NOT_OWNER_COMMAND_REPLY },
    { channelId: 'C1', userId: OWNER_ID, text: NOT_OWNER_COMMAND_REPLY },
  ])
})
