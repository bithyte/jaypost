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

class FakeMessenger implements Messenger {
  sent: { id: string; recipient: string | undefined }[] = []
  endings = new Map<string, MessageEnding>()
  failingRecipient: string | undefined
  gate: Promise<void> | undefined
  closedGate: Promise<void> | undefined

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
