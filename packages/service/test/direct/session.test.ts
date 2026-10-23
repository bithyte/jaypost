import { expect, test, vi } from 'vite-plus/test'
import { parseApprovalRequest, SendError } from '@jaypost/core'
import type {
  ApprovalRequest,
  MessageEnding,
  MessageReference,
  ProviderRuntime,
  SendNotificationOptions,
} from '@jaypost/core'
import { openDirectSession } from '../../src/direct/index.ts'
import { createFakeProvider } from '@jaypost/testing'
import type { FakeRuntime } from '@jaypost/testing'

type Recorded = {
  readonly finalized: { reference: MessageReference; ending: MessageEnding }[]
  readonly notified: { id: string; text: string; options: SendNotificationOptions }[]
  stopCount: number
}

function createSession(runtime: Partial<ProviderRuntime> = {}) {
  const recorded: Recorded = { finalized: [], notified: [], stopCount: 0 }
  const provider = createFakeProvider({
    runtime: {
      finalize: async (reference, _message, ending) => {
        recorded.finalized.push({ reference, ending })
      },
      sendNotification: async (id, message, options) => {
        recorded.notified.push({ id, text: message.text, options })
        return { n: 0 }
      },
      stop: async () => {
        recorded.stopCount += 1
      },
      ...runtime,
    },
  })
  const opened = openDirectSession({ provider, settings: { fakeKey: 'k' } }, () => {})
  return { provider, recorded, opened }
}

function requireRuntime(runtimes: readonly FakeRuntime[]): FakeRuntime {
  const runtime = runtimes[0]
  if (runtime === undefined) {
    throw new Error('no runtime created')
  }
  return runtime
}

function createRequest(timeout = 100): ApprovalRequest {
  const parsed = parseApprovalRequest(
    { text: 'Publish?', options: ['Yes', 'No'], timeoutOption: 'No', timeout },
    100,
    0,
  )
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  return parsed.value
}

async function waitForSent(runtime: FakeRuntime): Promise<string> {
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  const sent = runtime.sent[0]
  if (sent === undefined) {
    throw new Error('nothing sent')
  }
  return sent.id
}

test('request resolves with the tapped option', async () => {
  const { provider, opened } = createSession()
  const session = await opened
  const pending = session.request(createRequest(), new AbortController().signal)
  const runtime = requireRuntime(provider.runtimes)
  const id = await waitForSent(runtime)
  expect(runtime.handlers?.answer(id, 0)).toBe('accepted')
  expect(await pending).toEqual({
    kind: 'completed',
    outcome: { answer: 'Yes', timedOut: false },
    roundCount: 1,
  })
  await session.stop()
})

test('request times out with the default and finalizes as timed out', async () => {
  const { recorded, opened } = createSession()
  const session = await opened
  const result = await session.request(createRequest(0.01), new AbortController().signal)
  expect(result).toEqual({
    kind: 'completed',
    outcome: { answer: 'No', timedOut: true },
    roundCount: 1,
  })
  expect(recorded.finalized).toEqual([
    { reference: { n: 1 }, ending: { kind: 'timedOut', answer: 'No' } },
  ])
  await session.stop()
})

test('aborting finalizes the message as cancelled', async () => {
  const { provider, recorded, opened } = createSession()
  const session = await opened
  const controller = new AbortController()
  const pending = session.request(createRequest(), controller.signal)
  await waitForSent(requireRuntime(provider.runtimes))
  controller.abort()
  expect(await pending).toEqual({ kind: 'cancelled' })
  expect(recorded.finalized).toEqual([{ reference: { n: 1 }, ending: { kind: 'cancelled' } }])
  await session.stop()
})

test('a fatal provider error rejects the pending request with its message', async () => {
  const { provider, opened } = createSession()
  const session = await opened
  const pending = session.request(createRequest(), new AbortController().signal)
  const runtime = requireRuntime(provider.runtimes)
  await waitForSent(runtime)
  runtime.handlers?.fatal('bot stopped: boom')
  await expect(pending).rejects.toThrow('bot stopped: boom')
  await expect(session.request(createRequest(), new AbortController().signal)).rejects.toThrow(
    'bot stopped: boom',
  )
  await session.stop()
})

test('a failed send propagates as SendError', async () => {
  const { opened } = createSession({
    sendRequest: async () => {
      throw new Error('network down')
    },
  })
  const session = await opened
  await expect(
    session.request(createRequest(), new AbortController().signal),
  ).rejects.toBeInstanceOf(SendError)
  await session.stop()
})

test('the owner gets no commands', async () => {
  const { provider, opened } = createSession()
  const session = await opened
  const controller = new AbortController()
  const pending = session.request(createRequest(), controller.signal)
  const runtime = requireRuntime(provider.runtimes)
  await waitForSent(runtime)
  expect(runtime.handlers?.commands).toEqual([])
  expect(runtime.handlers?.command('pending', '')).toBeUndefined()
  expect(runtime.handlers?.dismiss('x')).toBe(false)
  expect(runtime.handlers?.pair).toBeUndefined()
  controller.abort()
  await pending
  await session.stop()
})

test('notify sends without dismiss and never starts the runtime', async () => {
  const { provider, recorded, opened } = createSession()
  const session = await opened
  await session.notify({ message: { text: 'Shipped', spans: [] }, attachment: undefined })
  expect(recorded.notified).toEqual([
    { id: expect.any(String), text: 'Shipped', options: { silent: false, dismissible: false } },
  ])
  expect(requireRuntime(provider.runtimes).handlers).toBeUndefined()
  await session.stop()
})

test('a failed notification is a SendError carrying the cause', async () => {
  const cause = new Error('network down')
  const { opened } = createSession({
    sendNotification: async () => {
      throw cause
    },
  })
  const session = await opened
  const sent = session.notify({ message: { text: 'Shipped', spans: [] }, attachment: undefined })
  await expect(sent).rejects.toBeInstanceOf(SendError)
  await expect(sent).rejects.toThrow('failed to send notification')
  await expect(sent).rejects.toMatchObject({ cause })
})

test('notify throws when the provider has no notifications', async () => {
  const { opened } = createSession({ sendNotification: undefined })
  const session = await opened
  await expect(
    session.notify({ message: { text: 'Shipped', spans: [] }, attachment: undefined }),
  ).rejects.toThrow("Fake can't send notifications")
})

test('rejected credentials throw the reason and stop the runtime', async () => {
  const { recorded, opened } = createSession({
    checkCredentials: async () => ({ ok: false, reason: 'Fake rejected that key' }),
  })
  await expect(opened).rejects.toThrow('Fake rejected that key')
  expect(recorded.stopCount).toBe(1)
})

test('stop works when the runtime never started', async () => {
  const { provider, recorded, opened } = createSession()
  const session = await opened
  await session.stop()
  expect(recorded.stopCount).toBe(1)
  expect(requireRuntime(provider.runtimes).handlers).toBeUndefined()
})

test('stop never rejects', async () => {
  const { opened } = createSession({
    stop: async () => {
      throw new Error('already gone')
    },
  })
  const session = await opened
  await expect(session.stop()).resolves.toBeUndefined()
})

test('vote resolves with the decision', async () => {
  const { provider, opened } = createSession()
  const session = await opened
  const vote = {
    request: createRequest(),
    voters: ['a'],
    rule: 'all',
    retryCount: 0,
  } as const
  const pending = session.vote(vote, new AbortController().signal)
  const runtime = requireRuntime(provider.runtimes)
  const id = await waitForSent(runtime)
  expect(runtime.handlers?.answer(id, 0)).toBe('accepted')
  expect(await pending).toEqual({
    kind: 'decided',
    approved: true,
    answer: 'Yes',
    votes: [{ voter: 'a', answer: 'Yes' }],
    roundCount: 1,
    timedOut: false,
  })
  await session.stop()
})

test('a fatal provider error rejects a vote with its message', async () => {
  const { provider, opened } = createSession()
  const session = await opened
  const vote = {
    request: createRequest(),
    voters: ['a'],
    rule: 'all',
    retryCount: 0,
  } as const
  const pending = session.vote(vote, new AbortController().signal)
  const runtime = requireRuntime(provider.runtimes)
  await waitForSent(runtime)
  runtime.handlers?.fatal('bot stopped: boom')
  await expect(pending).rejects.toThrow('bot stopped: boom')
  await session.stop()
})
