import { expect, test, vi } from 'vite-plus/test'
import {
  BUTTONS_ONLY_REPLY,
  DISMISS_LABEL,
  formatDismissPayload,
  NOT_OPEN_REPLY,
  OwnerConversation,
  TEXT_HINT_WITHOUT_BUTTONS,
  TEXT_HINT_WITH_BUTTONS,
} from '@jaypost/core'
import type { MessageEnding } from '@jaypost/core'
import { pairOwner, receiveReplyTo } from '@jaypost/testing'
import {
  createSlackMessenger,
  toButton,
  toChoiceButtons,
  toOutgoingMessage,
} from '../../src/slack/index.ts'
import { createFakeSlack } from './fake.ts'
import type { FakeSlack } from './fake.ts'

const ENDING = {} as MessageEnding
const ATTACHMENT = { name: 'diff.txt', content: new TextEncoder().encode('hello') }

function setup(fake: FakeSlack = createFakeSlack(), conversation = new OwnerConversation('U1')) {
  const log = vi.fn<(line: string) => void>()
  const messenger = createSlackMessenger(fake.client, conversation, log)
  return { fake, conversation, log, messenger }
}

const plain = (text: string) => ({ text, spans: [] })

test('sendRequest sends one dm with buttons and records the open question', async () => {
  const { fake, conversation, messenger } = setup()
  const reference = await messenger.sendRequest(
    'r1',
    plain('Run it?'),
    ['Yes', 'No'],
    false,
    undefined,
    undefined,
  )
  expect(reference).toEqual({ channelId: 'D1', ts: '1.0' })
  expect(fake.openedFor).toEqual(['U1'])
  expect(fake.posted).toEqual([
    {
      channelId: 'D1',
      message: toOutgoingMessage(plain('Run it?'), toChoiceButtons('r1', ['Yes', 'No'])),
    },
  ])
  expect(receiveReplyTo(conversation, 'D1/1.0').outcome).toEqual({
    kind: 'refused',
    text: BUTTONS_ONLY_REPLY,
  })
})

test('allowText appends the hint and makes thread replies count', async () => {
  const { fake, conversation, messenger } = setup()
  await messenger.sendRequest('r1', plain('Why?'), ['a'], true, undefined, undefined)
  expect(fake.posted[0]?.message.text).toBe(`Why?\n\n${TEXT_HINT_WITH_BUTTONS}`)
  const { outcome, reply } = receiveReplyTo(conversation, 'D1/1.0')
  expect(outcome).toEqual({ kind: 'answered' })
  expect(reply).toHaveBeenCalledWith('r1', 'x')
})

test('a text-only question has no actions block', async () => {
  const { fake, messenger } = setup()
  await messenger.sendRequest('r1', plain('Name?'), [], true, undefined, undefined)
  expect(fake.posted[0]?.message).toEqual(
    toOutgoingMessage(plain(`Name?\n\n${TEXT_HINT_WITHOUT_BUTTONS}`), []),
  )
})

test('a request to a voter goes to their own dm', async () => {
  const { fake, messenger } = setup()
  await messenger.sendRequest('r1', plain('Vote?'), ['a'], false, undefined, 'U7')
  expect(fake.openedFor).toEqual(['U7'])
})

test('the attachment is uploaded into the message thread before the question opens', async () => {
  const { fake, messenger } = setup()
  await messenger.sendRequest('r1', plain('Run it?'), ['a'], false, ATTACHMENT, undefined)
  expect(fake.uploaded).toEqual([{ channelId: 'D1', threadTs: '1.0', file: ATTACHMENT }])
})

test('a failed upload deletes the message, rejects and leaves no open question', async () => {
  const fake = createFakeSlack({
    uploadFile: async () => {
      throw new Error('slack files.completeUploadExternal failed: not_in_channel')
    },
  })
  const { conversation, messenger } = setup(fake)
  await expect(
    messenger.sendRequest('r1', plain('Run it?'), ['a'], true, ATTACHMENT, undefined),
  ).rejects.toThrow('not_in_channel')
  expect(fake.deleted).toEqual([{ channelId: 'D1', ts: '1.0' }])
  expect(receiveReplyTo(conversation, 'D1/1.0').outcome).toEqual({
    kind: 'refused',
    text: NOT_OPEN_REPLY,
  })
})

test('the dm channel is opened once per owner, and again for a new owner', async () => {
  const { fake, conversation, messenger } = setup()
  await messenger.sendRequest('r1', plain('one'), ['a'], false, undefined, undefined)
  await messenger.sendRequest('r2', plain('two'), ['a'], false, undefined, undefined)
  pairOwner(conversation, 'U2')
  await messenger.sendRequest('r3', plain('three'), ['a'], false, undefined, undefined)
  expect(fake.openedFor).toEqual(['U1', 'U2'])
})

test('sending before pairing throws', async () => {
  const { fake, messenger } = setup(createFakeSlack(), new OwnerConversation(undefined))
  await expect(
    messenger.sendRequest('r1', plain('x'), ['a'], false, undefined, undefined),
  ).rejects.toThrow('bot is not paired yet')
  await expect(
    messenger.sendNotification('n1', plain('x'), { silent: false, dismissible: true }, undefined),
  ).rejects.toThrow('bot is not paired yet')
  expect(fake.posted).toEqual([])
})

test('finalize replaces the blocks without buttons and forgets the question', async () => {
  const { fake, conversation, messenger } = setup()
  const reference = await messenger.sendRequest('r1', plain('Q'), ['a'], true, undefined, undefined)
  await messenger.finalize(reference, plain('Q\n\nAnswered: a'), ENDING)
  expect(fake.updated).toEqual([
    { channelId: 'D1', ts: '1.0', message: toOutgoingMessage(plain('Q\n\nAnswered: a'), []) },
  ])
  expect(receiveReplyTo(conversation, 'D1/1.0').outcome).toEqual({
    kind: 'refused',
    text: NOT_OPEN_REPLY,
  })
})

test('finalize forgets the question even when the edit fails', async () => {
  const fake = createFakeSlack({
    updateMessage: async () => {
      throw new Error('slack chat.update failed: message_not_found')
    },
  })
  const { conversation, messenger } = setup(fake)
  const reference = await messenger.sendRequest('r1', plain('Q'), [], true, undefined, undefined)
  await expect(messenger.finalize(reference, plain('done'), ENDING)).rejects.toThrow(
    'message_not_found',
  )
  expect(receiveReplyTo(conversation, 'D1/1.0').outcome).toEqual({
    kind: 'refused',
    text: NOT_OPEN_REPLY,
  })
})

test('update sends the buttons again when they stay, and drops them otherwise', async () => {
  const { fake, messenger } = setup()
  const reference = { channelId: 'D1', ts: '1.0' }
  await messenger.update(reference, plain('1 of 2 voted'), { id: 'r1', options: ['Yes', 'No'] })
  await messenger.update(reference, plain('done'), undefined)
  expect(fake.updated.map((call) => call.message)).toEqual([
    toOutgoingMessage(plain('1 of 2 voted'), toChoiceButtons('r1', ['Yes', 'No'])),
    toOutgoingMessage(plain('done'), []),
  ])
})

test('sendNotification has one Dismiss button only when dismissible', async () => {
  const { fake, messenger } = setup()
  const first = await messenger.sendNotification(
    'n1',
    plain('Built'),
    { silent: true, dismissible: true },
    undefined,
  )
  await messenger.sendNotification(
    'n2',
    plain('Built'),
    { silent: false, dismissible: false },
    ATTACHMENT,
  )
  expect(first).toEqual({ channelId: 'D1', ts: '1.0' })
  expect(fake.posted.map((call) => call.message)).toEqual([
    toOutgoingMessage(plain('Built'), [toButton(DISMISS_LABEL, formatDismissPayload('n1'))]),
    toOutgoingMessage(plain('Built'), []),
  ])
  expect(fake.uploaded).toEqual([{ channelId: 'D1', threadTs: '2.0', file: ATTACHMENT }])
})

test('deleteMessage deletes by the saved reference', async () => {
  const { fake, messenger } = setup()
  await messenger.deleteMessage({ channelId: 'D1', ts: '4.0' })
  expect(fake.deleted).toEqual([{ channelId: 'D1', ts: '4.0' }])
})
