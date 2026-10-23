import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import type { FormattedText } from '../../src/format/index.ts'
import {
  ApprovalService,
  askWithRetries,
  runVote,
  VoterSendError,
} from '../../src/approval/index.ts'
import type {
  ApprovalRequest,
  Attachment,
  MessageButtons,
  MessageEnding,
  MessageReference,
  Messenger,
  Vote,
  VoteRule,
} from '../../src/approval/index.ts'

const REQUEST: ApprovalRequest = {
  message: { text: 'Deploy?', spans: [] },
  question: 'Deploy?',
  options: ['Yes', 'No'],
  timeoutOption: 'No',
  allowText: false,
  timeoutSeconds: 30,
  attachment: undefined,
}

const VOTERS = ['1', '2', '3']

const CANCELLED = { kind: 'cancelled' }

const BUTTONS_OF = (id: string): MessageButtons => ({ id, options: ['Yes', 'No'] })

class FakeMessenger implements Messenger {
  sent: { id: string; recipient: string | undefined }[] = []
  endings = new Map<string, MessageEnding>()
  failingRecipient: string | undefined
  updates: { reference: string; text: string; buttons: MessageButtons | undefined }[] = []
  /** Every edit in the order it landed, as `<update|finalize> <reference>`. */
  edits: string[] = []
  gate: Promise<void> | undefined
  closedGate: Promise<void> | undefined
  /** Holds updates of one message until `promise` resolves. */
  updateGate: { reference: string; promise: Promise<void> } | undefined
  isUpdateFailing = false

  async sendRequest(
    id: string,
    _message: FormattedText,
    _options: readonly string[],
    _allowText: boolean,
    _attachment: Attachment | undefined,
    recipient: string | undefined,
  ): Promise<MessageReference> {
    await this.gate
    if (recipient !== undefined && recipient === this.failingRecipient) {
      throw new Error('bot token 123:secret was rejected')
    }
    this.sent.push({ id, recipient })
    return id
  }

  async finalize(
    reference: MessageReference,
    _message: FormattedText,
    ending: MessageEnding,
  ): Promise<void> {
    if (ending.kind === 'closed') {
      await this.closedGate
    }
    this.endings.set(String(reference), ending)
    this.edits.push(`finalize ${String(reference)}`)
  }

  async update(
    reference: MessageReference,
    message: FormattedText,
    buttons: MessageButtons | undefined,
  ): Promise<void> {
    const gate = this.updateGate
    if (gate !== undefined && gate.reference === reference) {
      await gate.promise
    }
    if (this.isUpdateFailing) {
      throw new Error('message is not modified')
    }
    this.updates.push({ reference: String(reference), text: message.text, buttons })
    this.edits.push(`update ${String(reference)}`)
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

function setup() {
  const messenger = new FakeMessenger()
  let idCount = 0
  const service = new ApprovalService(
    messenger,
    () => new Date(2026, 0, 1, 9, 5),
    () => {
      idCount += 1
      return `id${idCount}`
    },
  )
  /** The id of the latest message sent to `voter`. */
  const idOf = (voter: string) =>
    messenger.sent.findLast((sent) => sent.recipient === voter)?.id ?? 'none'
  /** The ending of every message sent to `voter`, oldest first; undefined while still open. */
  const endingsOf = (voter: string) =>
    messenger.sent
      .filter((sent) => sent.recipient === voter)
      .map((sent) => messenger.endings.get(sent.id))
  const recipients = () => messenger.sent.map((sent) => sent.recipient)
  return { messenger, service, idOf, endingsOf, recipients }
}

function createVote(rule: VoteRule, retryCount = 0): Vote {
  return { request: REQUEST, voters: VOTERS, rule, retryCount }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

test('all approves once every voter says yes', async () => {
  const { service, idOf } = setup()
  const result = runVote(service, createVote('all'), new AbortController().signal)
  await flush()
  for (const voter of VOTERS) {
    expect(service.tap(idOf(voter), 0)).toBe('accepted')
  }
  expect(await result).toEqual({
    kind: 'decided',
    approved: true,
    answer: 'Yes',
    votes: [
      { voter: '1', answer: 'Yes' },
      { voter: '2', answer: 'Yes' },
      { voter: '3', answer: 'Yes' },
    ],
    roundCount: 1,
    timedOut: false,
  })
})

test('each voter gets their own message', async () => {
  const { service, messenger, recipients } = setup()
  const controller = new AbortController()
  const result = runVote(service, createVote('all'), controller.signal)
  await flush()
  expect(recipients()).toEqual(VOTERS)
  expect(new Set(messenger.sent.map((sent) => sent.id)).size).toBe(3)
  controller.abort()
  await result
})

test('all rejects on the first no and closes the others', async () => {
  const { service, idOf, endingsOf } = setup()
  const result = runVote(service, createVote('all'), new AbortController().signal)
  await flush()
  service.tap(idOf('2'), 1)
  expect(await result).toEqual({
    kind: 'decided',
    approved: false,
    answer: 'No',
    votes: [
      { voter: '1', answer: undefined },
      { voter: '2', answer: 'No' },
      { voter: '3', answer: undefined },
    ],
    roundCount: 1,
    timedOut: false,
  })
  expect(endingsOf('1')).toEqual([{ kind: 'closed', answer: 'No' }])
  expect(endingsOf('2')).toEqual([{ kind: 'answered', answer: 'No' }])
  expect(endingsOf('3')).toEqual([{ kind: 'closed', answer: 'No' }])
})

test('majority approves at two of three and closes the third', async () => {
  const { service, idOf, endingsOf } = setup()
  const result = runVote(service, createVote('majority'), new AbortController().signal)
  await flush()
  service.tap(idOf('1'), 0)
  await flush()
  service.tap(idOf('3'), 0)
  expect(await result).toEqual({
    kind: 'decided',
    approved: true,
    answer: 'Yes',
    votes: [
      { voter: '1', answer: 'Yes' },
      { voter: '2', answer: undefined },
      { voter: '3', answer: 'Yes' },
    ],
    roundCount: 1,
    timedOut: false,
  })
  expect(endingsOf('2')).toEqual([{ kind: 'closed', answer: 'Yes' }])
})

test("a timed-out round re-asks only voters who haven't voted", async () => {
  const { service, idOf, endingsOf, recipients } = setup()
  const result = runVote(service, createVote('all', 1), new AbortController().signal)
  await flush()
  service.tap(idOf('1'), 0)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(recipients()).toEqual(['1', '2', '3', '2', '3'])
  expect(endingsOf('1')).toEqual([{ kind: 'answered', answer: 'Yes' }])
  expect(endingsOf('2')).toEqual([{ kind: 'reasked' }, undefined])
  expect(endingsOf('3')).toEqual([{ kind: 'reasked' }, undefined])
  service.tap(idOf('2'), 0)
  service.tap(idOf('3'), 0)
  expect(await result).toMatchObject({ kind: 'decided', approved: true, roundCount: 2 })
})

test('votes carry over across rounds', async () => {
  const { service, idOf, endingsOf } = setup()
  const result = runVote(service, createVote('majority', 1), new AbortController().signal)
  await flush()
  service.tap(idOf('1'), 0)
  await vi.advanceTimersByTimeAsync(30_000)
  service.tap(idOf('2'), 0)
  expect(await result).toEqual({
    kind: 'decided',
    approved: true,
    answer: 'Yes',
    votes: [
      { voter: '1', answer: 'Yes' },
      { voter: '2', answer: 'Yes' },
      { voter: '3', answer: undefined },
    ],
    roundCount: 2,
    timedOut: false,
  })
  expect(endingsOf('3')).toEqual([{ kind: 'reasked' }, { kind: 'closed', answer: 'Yes' }])
})

test('the last round finalizes as timed out and the vote rejects', async () => {
  const { service, endingsOf, recipients } = setup()
  const result = runVote(service, createVote('all', 1), new AbortController().signal)
  await flush()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await result).toEqual({
    kind: 'decided',
    approved: false,
    answer: 'No',
    votes: [
      { voter: '1', answer: undefined },
      { voter: '2', answer: undefined },
      { voter: '3', answer: undefined },
    ],
    roundCount: 2,
    timedOut: true,
  })
  expect(recipients()).toEqual(['1', '2', '3', '1', '2', '3'])
  for (const voter of VOTERS) {
    expect(endingsOf(voter)).toEqual([{ kind: 'reasked' }, { kind: 'timedOut', answer: 'No' }])
  }
})

test('a majority with one yes still rejects when the rounds run out', async () => {
  const { service, idOf } = setup()
  const result = runVote(service, createVote('majority'), new AbortController().signal)
  await flush()
  service.tap(idOf('1'), 0)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await result).toEqual({
    kind: 'decided',
    approved: false,
    answer: 'No',
    votes: [
      { voter: '1', answer: 'Yes' },
      { voter: '2', answer: undefined },
      { voter: '3', answer: undefined },
    ],
    roundCount: 1,
    timedOut: true,
  })
})

test('an abort cancels every open message and starts no new round', async () => {
  const { service, idOf, endingsOf, recipients } = setup()
  const controller = new AbortController()
  const result = runVote(service, createVote('majority', 2), controller.signal)
  await flush()
  service.tap(idOf('1'), 0)
  await flush()
  controller.abort()
  expect(await result).toEqual({ kind: 'cancelled' })
  expect(endingsOf('2')).toEqual([CANCELLED])
  expect(endingsOf('3')).toEqual([CANCELLED])
  await vi.advanceTimersByTimeAsync(60_000)
  expect(recipients()).toEqual(VOTERS)
  expect(vi.getTimerCount()).toBe(0)
})

test('an abort in the last round is cancelled, not rejected', async () => {
  const { service, endingsOf } = setup()
  const controller = new AbortController()
  const result = runVote(service, createVote('all'), controller.signal)
  await flush()
  controller.abort()
  expect(await result).toEqual({ kind: 'cancelled' })
  for (const voter of VOTERS) {
    expect(endingsOf(voter)).toEqual([CANCELLED])
  }
})

test('an abort during the sends cancels each message once sent', async () => {
  const { service, messenger, endingsOf, recipients } = setup()
  const gate = Promise.withResolvers<void>()
  messenger.gate = gate.promise
  const controller = new AbortController()
  const result = runVote(service, createVote('all', 2), controller.signal)
  await flush()
  controller.abort()
  gate.resolve()
  expect(await result).toEqual({ kind: 'cancelled' })
  for (const voter of VOTERS) {
    expect(endingsOf(voter)).toEqual([CANCELLED])
  }
  await vi.advanceTimersByTimeAsync(90_000)
  expect(recipients()).toEqual(VOTERS)
  expect(vi.getTimerCount()).toBe(0)
})

test('an aborted signal sends nothing', async () => {
  const { service, recipients } = setup()
  const controller = new AbortController()
  controller.abort()
  expect(await runVote(service, createVote('all'), controller.signal)).toEqual({
    kind: 'cancelled',
  })
  expect(recipients()).toEqual([])
})

test('a failed send cancels the messages already sent and names the voter', async () => {
  const { service, messenger, endingsOf } = setup()
  messenger.failingRecipient = '2'
  const error = await runVote(service, createVote('all'), new AbortController().signal).catch(
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(VoterSendError)
  expect(error instanceof VoterSendError && error.voter).toBe('2')
  expect(error instanceof Error && error.message).toBe('failed to send message to 2')
  expect(endingsOf('1')).toEqual([CANCELLED])
  expect(endingsOf('3')).toEqual([CANCELLED])
  expect(vi.getTimerCount()).toBe(0)
})

test('a tap after the vote is decided is expired and not counted', async () => {
  const { service, idOf, endingsOf } = setup()
  const result = runVote(service, createVote('all'), new AbortController().signal)
  await flush()
  service.tap(idOf('2'), 1)
  const decided = await result
  expect(service.tap(idOf('3'), 0)).toBe('expired')
  expect(decided).toMatchObject({ kind: 'decided', approved: false, answer: 'No' })
  expect(endingsOf('3')).toEqual([{ kind: 'closed', answer: 'No' }])
})

test('a decided vote resolves only once the closed messages are finalized', async () => {
  const { service, messenger, idOf, endingsOf } = setup()
  const closedGate = Promise.withResolvers<void>()
  messenger.closedGate = closedGate.promise
  let isResolved = false
  const result = runVote(service, createVote('all'), new AbortController().signal)
  void result.then(() => {
    isResolved = true
  })
  await flush()
  service.tap(idOf('2'), 1)
  await flush()
  expect(isResolved).toBe(false)
  closedGate.resolve()
  await result
  expect(endingsOf('1')).toEqual([{ kind: 'closed', answer: 'No' }])
})

test('a voter closed by the decision has no answer in the votes', async () => {
  const { service, idOf } = setup()
  const result = runVote(service, createVote('majority'), new AbortController().signal)
  await flush()
  service.tap(idOf('1'), 0)
  await flush()
  service.tap(idOf('2'), 0)
  expect(await result).toMatchObject({
    votes: [
      { voter: '1', answer: 'Yes' },
      { voter: '2', answer: 'Yes' },
      { voter: '3', answer: undefined },
    ],
  })
})

test("each vote updates every voter's message with the tally", async () => {
  const { service, messenger, idOf } = setup()
  const controller = new AbortController()
  const result = runVote(service, createVote('majority'), controller.signal)
  await flush()
  service.tap(idOf('1'), 0)
  await flush()
  expect(messenger.updates).toEqual([
    {
      reference: 'id1',
      text: 'Deploy?\n\n✅ Yes, 09:05\n\nVotes: 1 Yes, 2 …, 3 …',
      buttons: undefined,
    },
    { reference: 'id2', text: 'Deploy?\n\nVotes: 1 Yes, 2 …, 3 …', buttons: BUTTONS_OF('id2') },
    { reference: 'id3', text: 'Deploy?\n\nVotes: 1 Yes, 2 …, 3 …', buttons: BUTTONS_OF('id3') },
  ])
  controller.abort()
  await result
})

test("once decided, every answered voter's message shows the final tally", async () => {
  const { service, messenger, idOf } = setup()
  const result = runVote(service, createVote('majority'), new AbortController().signal)
  await flush()
  service.tap(idOf('1'), 0)
  await flush()
  messenger.updates = []
  messenger.edits = []
  service.tap(idOf('3'), 0)
  await result
  expect(messenger.updates).toEqual([
    {
      reference: 'id1',
      text: 'Deploy?\n\n✅ Yes, 09:05\n\nVotes: 1 Yes, 2 …, 3 Yes',
      buttons: undefined,
    },
    {
      reference: 'id3',
      text: 'Deploy?\n\n✅ Yes, 09:05\n\nVotes: 1 Yes, 2 …, 3 Yes',
      buttons: undefined,
    },
  ])
  expect(messenger.edits.filter((edit) => edit.endsWith('id2'))).toEqual(['finalize id2'])
})

test('a deciding vote on the first tap shows the tally on that voter alone', async () => {
  const { service, messenger, idOf } = setup()
  const result = runVote(service, createVote('all'), new AbortController().signal)
  await flush()
  service.tap(idOf('2'), 1)
  await result
  expect(messenger.updates).toEqual([
    {
      reference: 'id2',
      text: 'Deploy?\n\n✅ No, 09:05\n\nVotes: 1 …, 2 No, 3 …',
      buttons: undefined,
    },
  ])
})

test("an update in flight lands before the message's close", async () => {
  const { service, messenger, idOf } = setup()
  const updateGate = Promise.withResolvers<void>()
  messenger.updateGate = { reference: 'id2', promise: updateGate.promise }
  let isResolved = false
  const result = runVote(service, createVote('majority'), new AbortController().signal)
  void result.then(() => {
    isResolved = true
  })
  await flush()
  service.tap(idOf('1'), 0)
  await flush()
  service.tap(idOf('3'), 0)
  await flush()
  expect(isResolved).toBe(false)
  expect(messenger.edits.filter((edit) => edit.endsWith('id2'))).toEqual([])
  updateGate.resolve()
  await result
  expect(messenger.edits.filter((edit) => edit.endsWith('id2'))).toEqual([
    'update id2',
    'finalize id2',
  ])
})

test('a decided vote resolves only once the updates in flight landed', async () => {
  const { service, messenger, idOf } = setup()
  const updateGate = Promise.withResolvers<void>()
  messenger.updateGate = { reference: 'id1', promise: updateGate.promise }
  let isResolved = false
  const result = runVote(service, createVote('majority'), new AbortController().signal)
  void result.then(() => {
    isResolved = true
  })
  await flush()
  service.tap(idOf('1'), 0)
  await flush()
  service.tap(idOf('3'), 0)
  await flush()
  expect(isResolved).toBe(false)
  updateGate.resolve()
  await result
  expect(messenger.edits.filter((edit) => edit.endsWith('id1'))).toEqual([
    'finalize id1',
    'update id1',
    'update id1',
  ])
  expect(messenger.updates.findLast((update) => update.reference === 'id1')?.text).toBe(
    'Deploy?\n\n✅ Yes, 09:05\n\nVotes: 1 Yes, 2 …, 3 Yes',
  )
})

test('a queued update for a message that settled is dropped', async () => {
  const { service, messenger, idOf, endingsOf } = setup()
  const updateGate = Promise.withResolvers<void>()
  messenger.updateGate = { reference: 'id3', promise: updateGate.promise }
  const controller = new AbortController()
  const result = runVote(service, createVote('all'), controller.signal)
  await flush()
  service.tap(idOf('1'), 0)
  await flush()
  service.tap(idOf('2'), 0)
  await flush()
  controller.abort()
  await flush()
  updateGate.resolve()
  expect(await result).toEqual({ kind: 'cancelled' })
  expect(messenger.edits.filter((edit) => edit.endsWith('id3'))).toEqual([
    'update id3',
    'finalize id3',
  ])
  expect(endingsOf('3')).toEqual([CANCELLED])
})

test("a re-asked voter's old message is not updated", async () => {
  const { service, messenger, idOf } = setup()
  const controller = new AbortController()
  const result = runVote(service, createVote('all', 1), controller.signal)
  await flush()
  service.tap(idOf('1'), 0)
  await vi.advanceTimersByTimeAsync(30_000)
  messenger.updates = []
  service.tap(idOf('2'), 0)
  await flush()
  expect(messenger.updates.map((update) => update.reference)).toEqual(['id1', 'id4', 'id5'])
  expect(messenger.updates.at(-1)).toEqual({
    reference: 'id5',
    text: 'Deploy?\n\nVotes: 1 Yes, 2 Yes, 3 …',
    buttons: BUTTONS_OF('id5'),
  })
  controller.abort()
  await result
})

test('a failed update is logged and the vote goes on', async () => {
  const { service, messenger, idOf } = setup()
  messenger.isUpdateFailing = true
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const result = runVote(service, createVote('all'), new AbortController().signal)
  await flush()
  for (const voter of VOTERS) {
    service.tap(idOf(voter), 0)
    await flush()
  }
  expect(await result).toMatchObject({ kind: 'decided', approved: true })
  expect(errorSpy).toHaveBeenCalledWith('failed to update approval message', expect.any(Error))
  errorSpy.mockRestore()
})

test('askWithRetries re-asks until answered', async () => {
  const { service, messenger, idOf, endingsOf } = setup()
  const result = askWithRetries(
    service,
    { ...REQUEST, recipient: '1' },
    2,
    new AbortController().signal,
  )
  await flush()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(messenger.sent.length).toBe(2)
  service.tap(idOf('1'), 0)
  expect(await result).toEqual({
    kind: 'completed',
    outcome: { answer: 'Yes', timedOut: false },
    roundCount: 2,
  })
  expect(endingsOf('1')).toEqual([{ kind: 'reasked' }, { kind: 'answered', answer: 'Yes' }])
})

test('askWithRetries reports a timeout once the last round runs out', async () => {
  const { service, endingsOf } = setup()
  const result = askWithRetries(
    service,
    { ...REQUEST, recipient: '1' },
    1,
    new AbortController().signal,
  )
  await flush()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await result).toEqual({
    kind: 'completed',
    outcome: { answer: 'No', timedOut: true },
    roundCount: 2,
  })
  expect(endingsOf('1')).toEqual([{ kind: 'reasked' }, { kind: 'timedOut', answer: 'No' }])
})

test('askWithRetries with no retries behaves like request', async () => {
  const { service, endingsOf } = setup()
  const result = askWithRetries(
    service,
    { ...REQUEST, recipient: '1' },
    0,
    new AbortController().signal,
  )
  await flush()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await result).toEqual({
    kind: 'completed',
    outcome: { answer: 'No', timedOut: true },
    roundCount: 1,
  })
  expect(endingsOf('1')).toEqual([{ kind: 'timedOut', answer: 'No' }])
})

test('askWithRetries stops re-asking once aborted', async () => {
  const { service, messenger, endingsOf } = setup()
  const controller = new AbortController()
  const result = askWithRetries(service, { ...REQUEST, recipient: '1' }, 2, controller.signal)
  await flush()
  controller.abort()
  expect(await result).toEqual({ kind: 'cancelled' })
  await vi.advanceTimersByTimeAsync(90_000)
  expect(messenger.sent.length).toBe(1)
  expect(endingsOf('1')).toEqual([CANCELLED])
})
