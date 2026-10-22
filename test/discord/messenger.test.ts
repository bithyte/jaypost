import { expect, test, vi } from 'vite-plus/test'
import {
  BUTTONS_ONLY_REPLY,
  NOT_OPEN_REPLY,
  OwnerConversation,
  TEXT_HINT_WITHOUT_BUTTONS,
  TEXT_HINT_WITH_BUTTONS,
} from '../../src/conversation/index.ts'
import { createDiscordMessenger, toButtonRows } from '../../src/discord/index.ts'
import type { MessageEnding } from '../../src/approval/index.ts'
import { pairOwner, receiveReplyTo } from '../conversation/helpers.ts'
import { createFakeDiscord } from './fake.ts'
import type { FakeDiscord } from './fake.ts'

const ENDING = {} as MessageEnding

function setup(fake: FakeDiscord = createFakeDiscord(), conversation = new OwnerConversation('1')) {
  const log = vi.fn<(line: string) => void>()
  const messenger = createDiscordMessenger(fake.client, conversation, log)
  return { fake, conversation, log, messenger }
}

function expectOpenText(conversation: OwnerConversation, key: string): void {
  const { outcome, reply } = receiveReplyTo(conversation, key)
  expect(outcome).toEqual({ kind: 'answered' })
  expect(reply).toHaveBeenCalledWith('r1', 'x')
}

function expectButtonsOnly(conversation: OwnerConversation, key: string): void {
  expect(receiveReplyTo(conversation, key).outcome).toEqual({
    kind: 'refused',
    text: BUTTONS_ONLY_REPLY,
  })
}

function expectNotOpen(conversation: OwnerConversation, key: string): void {
  expect(receiveReplyTo(conversation, key).outcome).toEqual({
    kind: 'refused',
    text: NOT_OPEN_REPLY,
  })
}

const plain = (text: string) => ({ text, spans: [] })

test('sendRequest sends one dm with rows of buttons and records the open question', async () => {
  const { fake, conversation, messenger } = setup()
  const reference = await messenger.sendRequest(
    'r1',
    plain('Run it?'),
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    false,
    undefined,
    undefined,
  )
  expect(reference).toEqual({ channelId: 'dm1', messageId: 'm1', hasButtons: true })
  expect(fake.created).toHaveLength(1)
  const sent = fake.created[0]
  expect(sent?.channelId).toBe('dm1')
  expect(sent?.message).toEqual({
    content: 'Run it?',
    rows: [
      [
        { label: 'a', customId: 'r1:0' },
        { label: 'b', customId: 'r1:1' },
        { label: 'c', customId: 'r1:2' },
        { label: 'd', customId: 'r1:3' },
        { label: 'e', customId: 'r1:4' },
      ],
      [
        { label: 'f', customId: 'r1:5' },
        { label: 'g', customId: 'r1:6' },
      ],
    ],
    silent: false,
    file: undefined,
  })
  expectButtonsOnly(conversation, 'm1')
})

test('allowText appends the hint, escaped like the rest', async () => {
  const { fake, conversation, messenger } = setup()
  await messenger.sendRequest('r1', plain('a_b'), ['x'], true, undefined, undefined)
  expect(fake.created[0]?.message.content).toBe(`a\\_b\n\n${TEXT_HINT_WITH_BUTTONS}`)
  expectOpenText(conversation, 'm1')
})

test('a text-only question has no buttons', async () => {
  const { fake, messenger } = setup()
  const reference = await messenger.sendRequest(
    'r1',
    plain('Name?'),
    [],
    true,
    undefined,
    undefined,
  )
  expect(reference).toEqual({ channelId: 'dm1', messageId: 'm1', hasButtons: false })
  expect(fake.created[0]?.message.rows).toEqual([])
  expect(fake.created[0]?.message.content).toBe(`Name?\n\n${TEXT_HINT_WITHOUT_BUTTONS}`)
})

test('the attachment rides on the same message', async () => {
  const { fake, messenger } = setup()
  const attachment = { name: 'diff.txt', content: new TextEncoder().encode('hello') }
  await messenger.sendRequest('r1', plain('Run it?'), ['a'], false, attachment, undefined)
  expect(fake.created).toHaveLength(1)
  expect(fake.created[0]?.message.file).toBe(attachment)
})

test('the dm channel is opened once per owner', async () => {
  const { fake, messenger } = setup()
  await messenger.sendRequest('r1', plain('one'), ['a'], false, undefined, undefined)
  await messenger.sendRequest('r2', plain('two'), ['a'], false, undefined, undefined)
  expect(fake.openedFor).toEqual(['1'])
  expect(fake.created.map((call) => call.channelId)).toEqual(['dm1', 'dm1'])
})

test('a new owner gets a new dm channel', async () => {
  const { fake, conversation, messenger } = setup()
  await messenger.sendRequest('r1', plain('one'), ['a'], false, undefined, undefined)
  pairOwner(conversation, '2')
  await messenger.sendRequest('r2', plain('two'), ['a'], false, undefined, undefined)
  expect(fake.openedFor).toEqual(['1', '2'])
})

test('sending before pairing throws', async () => {
  const { fake, messenger } = setup(createFakeDiscord(), new OwnerConversation(undefined))
  await expect(
    messenger.sendRequest('r1', plain('x'), ['a'], false, undefined, undefined),
  ).rejects.toThrow('bot is not paired yet')
  await expect(
    messenger.sendNotification('n1', plain('x'), { silent: false, dismissible: true }, undefined),
  ).rejects.toThrow('bot is not paired yet')
  expect(fake.created).toEqual([])
})

test('a failed send rejects and leaves no open question', async () => {
  const fake = createFakeDiscord({
    createMessage: async () => {
      throw new Error('Cannot send messages to this user')
    },
  })
  const { conversation, messenger } = setup(fake)
  await expect(
    messenger.sendRequest('r1', plain('x'), ['a'], false, undefined, undefined),
  ).rejects.toThrow('Cannot send messages to this user')
  expectNotOpen(conversation, 'm1')
})

test('finalize edits the text, removes the buttons and forgets the question', async () => {
  const { fake, conversation, messenger } = setup()
  const reference = await messenger.sendRequest(
    'r1',
    plain('Run it?'),
    ['a'],
    false,
    undefined,
    undefined,
  )
  await messenger.finalize(reference, plain('Run it?\n\nApproved'), ENDING)
  expect(fake.edited).toEqual([
    { channelId: 'dm1', messageId: 'm1', content: 'Run it?\n\nApproved', removeButtons: true },
  ])
  expectNotOpen(conversation, 'm1')
})

test('finalize of a text-only question leaves components alone', async () => {
  const { fake, messenger } = setup()
  const reference = await messenger.sendRequest(
    'r1',
    plain('Name?'),
    [],
    true,
    undefined,
    undefined,
  )
  await messenger.finalize(reference, plain('done'), ENDING)
  expect(fake.edited[0]?.removeButtons).toBe(false)
})

test('finalize forgets the question even when the edit fails', async () => {
  const fake = createFakeDiscord({
    editMessage: async () => {
      throw new Error('Unknown Message')
    },
  })
  const { conversation, messenger } = setup(fake)
  const reference = await messenger.sendRequest(
    'r1',
    plain('x'),
    ['a'],
    false,
    undefined,
    undefined,
  )
  expectButtonsOnly(conversation, 'm1')
  await expect(messenger.finalize(reference, plain('y'), ENDING)).rejects.toThrow('Unknown Message')
  expectNotOpen(conversation, 'm1')
})

test('the longest final text fits in 2000 characters', async () => {
  const { fake, log, messenger } = setup()
  const reference = await messenger.sendRequest(
    'r1',
    plain('x'),
    ['a'],
    false,
    undefined,
    undefined,
  )
  const text = `${'*'.repeat(1800)}\n\n💬 ${'a'.repeat(179)}…, 12:34`
  expect(text.length).toBe(1992)
  await messenger.finalize(reference, plain(text), ENDING)
  const content = fake.edited[0]?.content ?? ''
  expect(content.length).toBeLessThanOrEqual(2000)
  expect(content).toBe(text)
  expect(log).toHaveBeenCalledWith('discord message too long with formatting, sent as raw text')
})

test('a formatted message that only fits unformatted logs it', async () => {
  const { fake, log, messenger } = setup()
  const reference = await messenger.sendRequest(
    'r1',
    plain('x'),
    ['a'],
    false,
    undefined,
    undefined,
  )
  const text = 'a'.repeat(1998)
  await messenger.finalize(
    reference,
    { text, spans: [{ kind: 'bold', offset: 0, length: 1998 }] },
    ENDING,
  )
  expect(fake.edited[0]?.content).toBe(text)
  expect(log).toHaveBeenCalledWith('discord message too long with formatting, sent unformatted')
})

test('sendNotification has one Dismiss button and honours silent', async () => {
  const { fake, conversation, messenger } = setup()
  const reference = await messenger.sendNotification(
    'n1',
    plain('done'),
    { silent: true, dismissible: true },
    undefined,
  )
  expect(fake.created[0]?.message).toEqual({
    content: 'done',
    rows: [[{ label: 'Dismiss', customId: 'dismiss/n1' }]],
    silent: true,
    file: undefined,
  })
  expect(reference).toEqual({ channelId: 'dm1', messageId: 'm1', hasButtons: true })
  expectNotOpen(conversation, 'm1')
})

test('sendNotification without dismissible sends no buttons', async () => {
  const { fake, messenger } = setup()
  const reference = await messenger.sendNotification(
    'n1',
    plain('done'),
    { silent: false, dismissible: false },
    undefined,
  )
  expect(fake.created[0]?.message).toEqual({
    content: 'done',
    rows: [],
    silent: false,
    file: undefined,
  })
  expect(reference).toEqual({ channelId: 'dm1', messageId: 'm1', hasButtons: false })
})

test('deleteMessage deletes by the saved reference', async () => {
  const { fake, messenger } = setup()
  const reference = await messenger.sendNotification(
    'n1',
    plain('done'),
    { silent: false, dismissible: true },
    undefined,
  )
  await messenger.deleteMessage(reference)
  expect(fake.deleted).toEqual([{ channelId: 'dm1', messageId: 'm1' }])
})

test('seven options make rows of five and two', () => {
  const rows = toButtonRows('r', ['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  expect(rows.map((row) => row.length)).toEqual([5, 2])
  expect(rows[1]).toEqual([
    { label: 'f', customId: 'r:5' },
    { label: 'g', customId: 'r:6' },
  ])
})

test('no options make no rows', () => {
  expect(toButtonRows('r', [])).toEqual([])
})

test('sendRequest opens a dm per recipient and reuses it', async () => {
  const { fake, messenger } = setup()
  await messenger.sendRequest('r1', plain('one'), ['a'], false, undefined, '222')
  await messenger.sendRequest('r2', plain('two'), ['a'], false, undefined, '222')
  await messenger.sendRequest('r3', plain('three'), ['a'], false, undefined, undefined)
  expect(fake.openedFor).toEqual(['222', '1'])
  expect(fake.created.map((call) => call.channelId)).toEqual(['dm1', 'dm1', 'dm2'])
})
