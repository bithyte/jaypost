import { expect, test, vi } from 'vite-plus/test'
import { NOT_OPEN_REPLY, OWNER_COMMANDS } from '@jaypost/core'
import type { MessageEnding, RuntimeHandlers } from '@jaypost/core'
import {
  AMBIGUOUS_TEXT_REPLY,
  checkNtfyAccess,
  createNtfyRuntime,
  formatTextHint,
  NO_TEXT_QUESTION_REPLY,
  TAP_TITLE,
} from '../../src/ntfy/index.ts'
import type { NtfyAccess, NtfyClient, NtfyMessage, NtfyStreamEvents } from '../../src/ntfy/index.ts'

const TOPIC = 'jaypost-0123456789abcdef'
const SETTINGS = { ntfyServer: 'https://ntfy.example.com', ntfyTopic: TOPIC }
const ENDING = { kind: 'answered', answer: 'Yes' } satisfies MessageEnding
const plain = (text: string) => ({ text, spans: [] })

function createFakeClient(access: (topic: string) => NtfyAccess = () => ({ kind: 'ok' })) {
  const calls: string[] = []
  const published: NtfyMessage[] = []
  let events: NtfyStreamEvents | undefined
  const unsubscribe = vi.fn()
  const client: NtfyClient = {
    publish: async (message) => {
      published.push(message)
    },
    clear: async (topic, sequenceId) => {
      calls.push(`clear ${topic} ${sequenceId}`)
    },
    remove: async (topic, sequenceId) => {
      calls.push(`remove ${topic} ${sequenceId}`)
    },
    checkAccess: async (topic) => {
      calls.push(`access ${topic}`)
      return access(topic)
    },
    subscribe: (topic, streamEvents) => {
      calls.push(`subscribe ${topic}`)
      events = streamEvents
      return unsubscribe
    },
  }
  const deliver = (message: string, title?: string): void => {
    events?.message({ id: `m${published.length}`, message, title })
  }
  const fail = (message: string): void => events?.fatal(message)
  return { client, calls, published, deliver, fail, unsubscribe }
}

function createHandlers(overrides: Partial<RuntimeHandlers> = {}) {
  return {
    answer: vi.fn<RuntimeHandlers['answer']>(() => 'accepted'),
    reply: vi.fn<RuntimeHandlers['reply']>(() => 'accepted'),
    dismiss: vi.fn<RuntimeHandlers['dismiss']>(() => true),
    commands: OWNER_COMMANDS,
    command: vi.fn<RuntimeHandlers['command']>(() => 'nothing pending'),
    fatal: vi.fn<RuntimeHandlers['fatal']>(),
    ...overrides,
  }
}

function setup(settings: Record<string, string> = SETTINGS) {
  const fake = createFakeClient()
  const log = vi.fn<(line: string) => void>()
  const runtime = createNtfyRuntime(settings, log, fake.client)
  const handlers = createHandlers()
  runtime.start(handlers)
  return { ...fake, log, runtime, handlers }
}

test('sendRequest publishes one notification with a button per option', async () => {
  const { runtime, published } = setup()
  const reference = await runtime.sendRequest(
    'r1',
    plain('Deploy?'),
    ['Yes', 'No'],
    false,
    undefined,
    undefined,
  )
  expect(reference).toEqual({ sequenceId: 'r1' })
  const tap = (label: string, body: string) => ({
    action: 'http',
    label,
    url: `https://ntfy.example.com/${TOPIC}-replies`,
    method: 'POST',
    headers: { 'x-title': TAP_TITLE, 'x-firebase': 'no' },
    body,
    clear: true,
  })
  expect(published).toEqual([
    {
      topic: TOPIC,
      sequenceId: 'r1',
      message: 'Deploy?',
      priority: 4,
      actions: [tap('Yes', 'r1:0'), tap('No', 'r1:1')],
    },
  ])
})

test('buttons carry the access token so the phone can publish the tap', async () => {
  const { runtime, published } = setup({ ...SETTINGS, ntfyToken: 'tk_secret' })
  await runtime.sendRequest('r1', plain('Deploy?'), ['Yes'], false, undefined, undefined)
  expect(published[0]?.actions[0]?.headers).toEqual({
    'x-title': TAP_TITLE,
    'x-firebase': 'no',
    authorization: 'Bearer tk_secret',
  })
})

test('a question that takes text says where to publish the answer', async () => {
  const { runtime, published } = setup()
  await runtime.sendRequest('r1', plain('Next?'), ['Done'], true, undefined, undefined)
  await runtime.sendRequest('r2', plain('Name?'), [], true, undefined, undefined)
  expect(published.map((message) => message.message)).toEqual([
    `Next?\n\n${formatTextHint(`${TOPIC}-replies`, true)}`,
    `Name?\n\n${formatTextHint(`${TOPIC}-replies`, false)}`,
  ])
  expect(published[1]?.actions).toEqual([])
})

test('sendRequest refuses another recipient', async () => {
  const { runtime, published } = setup()
  await expect(
    runtime.sendRequest('r1', plain('Vote?'), ['Yes', 'No'], false, undefined, '42'),
  ).rejects.toThrow('ntfy only sends to its own topic')
  expect(published).toEqual([])
})

test('a tap answers the question', async () => {
  const { runtime, handlers, deliver, published } = setup()
  await runtime.sendRequest('r1', plain('Deploy?'), ['Yes', 'No'], false, undefined, undefined)
  deliver('r1:1', TAP_TITLE)
  expect(handlers.answer).toHaveBeenCalledWith('r1', 1)
  expect(published).toHaveLength(1)
})

test('a tap on a settled question says it is not open', async () => {
  const { handlers, deliver, published } = setup()
  handlers.answer.mockReturnValue('expired')
  deliver('r9:0', TAP_TITLE)
  expect(published).toEqual([{ topic: TOPIC, message: NOT_OPEN_REPLY, priority: 2, actions: [] }])
})

test('a dismiss tap dismisses the notification', () => {
  const { handlers, deliver } = setup()
  deliver('dismiss/n1', TAP_TITLE)
  expect(handlers.dismiss).toHaveBeenCalledWith('n1')
})

test('a typed message answers the one question that takes text', async () => {
  const { runtime, handlers, deliver } = setup()
  await runtime.sendRequest('r1', plain('Next?'), ['Done'], true, undefined, undefined)
  deliver('  ship it  ')
  expect(handlers.reply).toHaveBeenCalledWith('r1', 'ship it')
})

test('a typed message that looks like a tap payload is still text', async () => {
  const { runtime, handlers, deliver } = setup()
  await runtime.sendRequest('r1', plain('Next?'), [], true, undefined, undefined)
  deliver('r1:0')
  expect(handlers.answer).not.toHaveBeenCalled()
  expect(handlers.reply).toHaveBeenCalledWith('r1', 'r1:0')
})

test('a typed message with no text question open says so', () => {
  const { deliver, published } = setup()
  deliver('hello')
  expect(published.map((message) => message.message)).toEqual([NO_TEXT_QUESTION_REPLY])
})

test('a typed message with several text questions open asks which', async () => {
  const { runtime, handlers, deliver, published } = setup()
  await runtime.sendRequest('r1', plain('A?'), [], true, undefined, undefined)
  await runtime.sendRequest('r2', plain('B?'), [], true, undefined, undefined)
  deliver('x')
  expect(handlers.reply).not.toHaveBeenCalled()
  expect(published[2]?.message).toBe(AMBIGUOUS_TEXT_REPLY)
})

test('a slash command runs and its reply is published', () => {
  const { handlers, deliver, published } = setup()
  deliver('/history 5')
  expect(handlers.command).toHaveBeenCalledWith('history', '5')
  expect(published).toEqual([
    { topic: TOPIC, message: 'nothing pending', priority: 2, actions: [] },
  ])
})

test('an unknown command lists the known ones', () => {
  const { handlers, deliver, published } = setup()
  deliver('/nope')
  expect(handlers.command).not.toHaveBeenCalled()
  expect(published[0]?.message).toBe('Unknown command; try /pending /cancel /history')
})

test('finalize replaces the question with its final text, then clears it', async () => {
  const { runtime, handlers, deliver, published, calls } = setup()
  const reference = await runtime.sendRequest(
    'r1',
    plain('Next?'),
    ['Done'],
    true,
    undefined,
    undefined,
  )
  await runtime.finalize?.(reference, plain('Next?\n\nAnswered: Done'), ENDING)
  expect(published[1]).toEqual({
    topic: TOPIC,
    sequenceId: 'r1',
    message: 'Next?\n\nAnswered: Done',
    priority: 1,
    actions: [],
  })
  expect(calls.at(-1)).toBe(`clear ${TOPIC} r1`)
  deliver('late')
  expect(handlers.reply).not.toHaveBeenCalled()
})

test('notifications map quiet hours onto priority and carry a dismiss button', async () => {
  const { runtime, published } = setup()
  const reference = await runtime.sendNotification?.(
    'n1',
    plain('Build done'),
    { silent: false, dismissible: true },
    undefined,
  )
  await runtime.sendNotification?.(
    'n2',
    plain('Quiet'),
    { silent: true, dismissible: false },
    undefined,
  )
  expect(reference).toEqual({ sequenceId: 'n1' })
  expect(
    published.map(({ sequenceId, priority, actions }) => ({ sequenceId, priority, actions })),
  ).toEqual([
    {
      sequenceId: 'n1',
      priority: 3,
      actions: [
        {
          action: 'http',
          label: 'Dismiss',
          url: `https://ntfy.example.com/${TOPIC}-replies`,
          method: 'POST',
          headers: { 'x-title': TAP_TITLE, 'x-firebase': 'no' },
          body: 'dismiss/n1',
          clear: true,
        },
      ],
    },
    { sequenceId: 'n2', priority: 2, actions: [] },
  ])
})

test('deleteMessage deletes the sequence', async () => {
  const { runtime, calls } = setup()
  await runtime.deleteMessage?.({ sequenceId: 'n1' })
  expect(calls.at(-1)).toBe(`remove ${TOPIC} n1`)
})

test('start subscribes to the reply topic on the default server; stop ends it', async () => {
  const fake = createFakeClient()
  const log = vi.fn<(line: string) => void>()
  const runtime = createNtfyRuntime({ ntfyTopic: TOPIC }, log, fake.client)
  const handlers = createHandlers()
  runtime.start(handlers)
  expect(fake.calls).toEqual([`subscribe ${TOPIC}-replies`])
  expect(log).toHaveBeenCalledWith('listening for answers on ntfy.sh')
  expect(log.mock.calls.flat().join('')).not.toContain(TOPIC)
  fake.fail('refused')
  expect(handlers.fatal).toHaveBeenCalledWith('refused')
  await runtime.stop()
  expect(fake.unsubscribe).toHaveBeenCalled()
  fake.fail('again')
  expect(handlers.fatal).toHaveBeenCalledTimes(1)
})

test('a throwing handler is logged without its message', () => {
  const fake = createFakeClient()
  const log = vi.fn<(line: string) => void>()
  const runtime = createNtfyRuntime(SETTINGS, log, fake.client)
  runtime.start(
    createHandlers({
      dismiss: () => {
        throw new TypeError('secret detail')
      },
    }),
  )
  fake.deliver('dismiss/n1', TAP_TITLE)
  expect(log).toHaveBeenLastCalledWith('ntfy reply handler failed: TypeError')
})

test('checkNtfyAccess checks the topic and the reply topic', async () => {
  const fake = createFakeClient()
  expect(await checkNtfyAccess(SETTINGS, fake.client)).toEqual({
    ok: true,
    displayName: 'ntfy.example.com',
  })
  expect(fake.calls).toEqual([`access ${TOPIC}`, `access ${TOPIC}-replies`])
})

test('checkNtfyAccess reports a refused or unreachable server without the topic', async () => {
  const refused = await checkNtfyAccess(
    SETTINGS,
    createFakeClient((topic) =>
      topic.endsWith('-replies') ? { kind: 'rejected', status: 403 } : { kind: 'ok' },
    ).client,
  )
  const unreachable = await checkNtfyAccess(
    SETTINGS,
    createFakeClient(() => ({ kind: 'unreachable' })).client,
  )
  expect(refused).toEqual({
    ok: false,
    reason: 'ntfy refused access to the topic (403); check it with `jaypost init`',
  })
  expect(unreachable).toEqual({ ok: false, reason: 'could not reach the ntfy server' })
})

test('checkNtfyAccess refuses a short topic without a token, before asking the server', async () => {
  const fake = createFakeClient()
  const short = await checkNtfyAccess({ ntfyTopic: 'alerts' }, fake.client)
  expect(short.ok).toBe(false)
  expect(fake.calls).toEqual([])
  expect(await checkNtfyAccess({ ntfyTopic: 'alerts', ntfyToken: 'tk_x' }, fake.client)).toEqual({
    ok: true,
    displayName: 'ntfy.sh',
  })
})

test('checkNtfyAccess refuses an unparsed server or topic typed at init', async () => {
  const fake = createFakeClient()
  const badServer = await checkNtfyAccess(
    { ...SETTINGS, ntfyServer: 'ntfy.example.com' },
    fake.client,
  )
  const badTopic = await checkNtfyAccess(
    { ...SETTINGS, ntfyTopic: 'has spaces in it ok' },
    fake.client,
  )
  expect(badServer).toEqual({ ok: false, reason: 'the ntfy server must be an http or https URL' })
  expect(badTopic.ok).toBe(false)
  expect(fake.calls).toEqual([])
})
