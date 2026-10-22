import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vite-plus/test'
import type { MessageEnding } from '../../src/approval/index.ts'
import { runDirectSendNotify, runDirectSendRequest } from '../../src/commands/index.ts'
import type { DirectSendDeps, SendRequestArgs } from '../../src/commands/index.ts'
import type { Provider, ProviderRuntime } from '../../src/provider/index.ts'
import { createFakeProvider, createPairingFakeProvider } from '../provider/fake.ts'
import type { FakeRuntime } from '../provider/fake.ts'

const ENV = { JAYPOST_PROVIDER: 'fakepair', FAKE_KEY: 'k', FAKE_OWNER: 'o' }
const REQUEST: SendRequestArgs = { text: 'Publish?', options: ['Yes', 'No'], timeoutOption: 'No' }

type Recorded = {
  readonly finalized: MessageEnding[]
  readonly notified: string[]
  stopCount: number
}

type TestProvider = Provider & { readonly runtimes: FakeRuntime[] }

/** The pairing fake (owner required), recording finalize, notifications and stop. */
function createProvider(
  runtime: Partial<ProviderRuntime> = {},
  overrides: Partial<Provider> = {},
): { readonly provider: TestProvider; readonly recorded: Recorded } {
  const base = createPairingFakeProvider()
  const recorded: Recorded = { finalized: [], notified: [], stopCount: 0 }
  const provider = createFakeProvider({
    name: base.name,
    label: base.label,
    settings: base.settings,
    setup: base.setup,
    ...overrides,
    runtime: {
      finalize: async (_reference, _message, ending) => {
        recorded.finalized.push(ending)
      },
      sendNotification: async (_id, message) => {
        recorded.notified.push(message.text)
        return { n: 0 }
      },
      stop: async () => {
        recorded.stopCount += 1
      },
      ...runtime,
    },
  })
  return { provider, recorded }
}

function createDeps(
  provider: Provider,
  signal: AbortSignal = new AbortController().signal,
  env: NodeJS.ProcessEnv = ENV,
) {
  const printed: string[] = []
  const errors: string[] = []
  const deps: DirectSendDeps = {
    env,
    providers: [provider],
    signal,
    print: (text) => printed.push(text),
    printError: (text) => errors.push(text),
  }
  return { deps, printed, errors }
}

async function waitForSent(provider: TestProvider): Promise<{ runtime: FakeRuntime; id: string }> {
  let found: { runtime: FakeRuntime; id: string } | undefined
  await vi.waitFor(() => {
    const runtime = provider.runtimes[0]
    const sent = runtime?.sent[0]
    if (runtime === undefined || sent === undefined) {
      throw new Error('nothing sent yet')
    }
    found = { runtime, id: sent.id }
  })
  if (found === undefined) {
    throw new Error('nothing sent')
  }
  return found
}

async function answerWhenSent(provider: TestProvider, optionIndex: number): Promise<void> {
  const { runtime, id } = await waitForSent(provider)
  expect(runtime.handlers?.answer(id, optionIndex)).toBe('accepted')
}

test('an answer other than the default exits 0 and prints it', async () => {
  const { provider, recorded } = createProvider()
  const { deps, printed, errors } = createDeps(provider)
  const answered = answerWhenSent(provider, 0)
  expect(await runDirectSendRequest(REQUEST, deps)).toBe(0)
  await answered
  expect(printed).toEqual(['Yes'])
  expect(errors).toEqual([])
  expect(recorded.stopCount).toBe(1)
})

test('the default answer exits 3 and still prints it', async () => {
  const { provider } = createProvider()
  const { deps, printed } = createDeps(provider)
  const answered = answerWhenSent(provider, 1)
  expect(await runDirectSendRequest(REQUEST, deps)).toBe(3)
  await answered
  expect(printed).toEqual(['No'])
})

test('a typed reply equal to the default exits 3', async () => {
  const { provider } = createProvider()
  const { deps, printed } = createDeps(provider)
  const replied = waitForSent(provider).then(({ runtime, id }) => {
    expect(runtime.handlers?.reply(id, 'No')).toBe('accepted')
  })
  const args = { text: 'Which branch?', allowText: true, timeoutOption: 'No' }
  expect(await runDirectSendRequest(args, deps)).toBe(3)
  await replied
  expect(printed).toEqual(['No'])
})

test('a timeout exits 3 and prints the default', async () => {
  const { provider, recorded } = createProvider()
  const { deps, printed } = createDeps(provider)
  expect(await runDirectSendRequest({ ...REQUEST, timeout: 0.01, json: true }, deps)).toBe(3)
  expect(printed).toEqual(['{"answer":"No","timedOut":true}'])
  expect(recorded.finalized).toEqual([{ kind: 'timedOut', answer: 'No' }])
})

test('a cancelled question exits 1 and stops the runtime', async () => {
  const { provider, recorded } = createProvider()
  const controller = new AbortController()
  const { deps, printed, errors } = createDeps(provider, controller.signal)
  const cancelled = waitForSent(provider).then(() => controller.abort())
  expect(await runDirectSendRequest(REQUEST, deps)).toBe(1)
  await cancelled
  expect(printed).toEqual([])
  expect(errors).toContain('jaypost: cancelled')
  expect(recorded.finalized).toEqual([{ kind: 'cancelled' }])
  expect(recorded.stopCount).toBe(1)
})

test('a fatal provider error exits 1 with its message', async () => {
  const { provider, recorded } = createProvider()
  const { deps, printed, errors } = createDeps(provider)
  const failed = waitForSent(provider).then(({ runtime }) =>
    runtime.handlers?.fatal('bot stopped: boom'),
  )
  expect(await runDirectSendRequest(REQUEST, deps)).toBe(1)
  await failed
  expect(printed).toEqual([])
  expect(errors).toEqual(['jaypost: bot stopped: boom'])
  expect(recorded.stopCount).toBe(1)
})

test('runtime log lines go to stderr with the jaypost prefix', async () => {
  const { provider } = createProvider()
  const logging = createFakeProvider({
    ...provider,
    createRuntime: (settings, log) => {
      log('connected')
      return provider.createRuntime(settings, log)
    },
  })
  const { deps, errors } = createDeps(logging)
  const answered = answerWhenSent(provider, 0)
  expect(await runDirectSendRequest(REQUEST, deps)).toBe(0)
  await answered
  expect(errors).toEqual(['jaypost: connected'])
})

test('a missing owner exits 1 before anything is sent', async () => {
  const { provider } = createProvider()
  const { deps, errors } = createDeps(provider, undefined, {
    JAYPOST_PROVIDER: 'fakepair',
    FAKE_KEY: 'k',
  })
  expect(await runDirectSendRequest(REQUEST, deps)).toBe(1)
  expect(errors).toEqual([
    'jaypost: missing fake owner; set FAKE_OWNER (jaypost setup-ci prints it)',
  ])
  expect(provider.runtimes).toEqual([])
})

test('rejected credentials exit 1 with the reason and stop the runtime', async () => {
  const { provider, recorded } = createProvider({
    checkCredentials: async () => ({ ok: false, reason: 'Fake rejected that key' }),
  })
  const { deps, errors } = createDeps(provider)
  expect(await runDirectSendRequest(REQUEST, deps)).toBe(1)
  expect(errors).toEqual(['jaypost: Fake rejected that key'])
  expect(recorded.stopCount).toBe(1)
  expect(provider.runtimes[0]?.sent).toEqual([])
})

test('text over the provider limit exits 1 with the parser message', async () => {
  const { provider } = createProvider()
  const { deps, errors } = createDeps(provider)
  expect(await runDirectSendRequest({ ...REQUEST, text: 'x'.repeat(101) }, deps)).toBe(1)
  expect(errors).toEqual(['jaypost: text must be at most 100 characters'])
  expect(provider.runtimes).toEqual([])
})

test('a failed send exits 1 without the cause', async () => {
  const { provider, recorded } = createProvider({
    sendRequest: async () => {
      throw new Error('token leaked')
    },
  })
  const { deps, errors } = createDeps(provider)
  expect(await runDirectSendRequest(REQUEST, deps)).toBe(1)
  expect(errors).toEqual(['jaypost: failed to send message'])
  expect(recorded.stopCount).toBe(1)
})

test('an attachment file is sent with the question', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jaypost-direct-'))
  try {
    const path = join(directory, 'notes.txt')
    writeFileSync(path, 'release notes')
    const { provider } = createProvider({}, { maxAttachmentBytes: 100 })
    const { deps } = createDeps(provider)
    const answered = answerWhenSent(provider, 0)
    expect(await runDirectSendRequest({ ...REQUEST, attachment: { path } }, deps)).toBe(0)
    await answered
    const attachment = provider.runtimes[0]?.sent[0]?.attachment
    expect(attachment?.name).toBe('notes.txt')
    expect(Buffer.from(attachment?.content ?? []).toString()).toBe('release notes')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a missing attachment file exits 1 before anything is sent', async () => {
  const { provider } = createProvider({}, { maxAttachmentBytes: 100 })
  const { deps, errors } = createDeps(provider)
  const args = { ...REQUEST, attachment: { path: '/nonexistent/jaypost-notes.txt' } }
  expect(await runDirectSendRequest(args, deps)).toBe(1)
  expect(errors).toEqual(['jaypost: attachment "/nonexistent/jaypost-notes.txt" not found'])
  expect(provider.runtimes).toEqual([])
})

test('an attachment exits 1 when the provider takes none', async () => {
  const { provider } = createProvider()
  const { deps, errors } = createDeps(provider)
  const args = { ...REQUEST, attachment: { name: 'notes.txt', text: 'release notes' } }
  expect(await runDirectSendRequest(args, deps)).toBe(1)
  expect(errors).toEqual(['jaypost: attachments not supported by this provider'])
  expect(provider.runtimes).toEqual([])
})

test('notify exits 0 once sent', async () => {
  const { provider, recorded } = createProvider()
  const { deps, printed, errors } = createDeps(provider)
  expect(await runDirectSendNotify({ text: 'Shipped', project: 'site' }, deps)).toBe(0)
  expect(recorded.notified).toEqual(['[site]\n\nShipped'])
  expect(printed).toEqual([])
  expect(errors).toEqual([])
  expect(recorded.stopCount).toBe(1)
})

test('notify exits 1 when sending fails', async () => {
  const { provider, recorded } = createProvider({
    sendNotification: async () => {
      throw new Error('token leaked')
    },
  })
  const { deps, errors } = createDeps(provider)
  expect(await runDirectSendNotify({ text: 'Shipped' }, deps)).toBe(1)
  expect(errors).toEqual(['jaypost: failed to send message'])
  expect(recorded.stopCount).toBe(1)
})

test('notify exits 1 with the parser message before anything is sent', async () => {
  const { provider } = createProvider()
  const { deps, errors } = createDeps(provider)
  expect(await runDirectSendNotify({ text: 'x'.repeat(101) }, deps)).toBe(1)
  expect(errors).toEqual(['jaypost: text must be at most 100 characters'])
  expect(provider.runtimes).toEqual([])
})

async function answerVoter(
  provider: TestProvider,
  recipient: string,
  optionIndex: number,
): Promise<void> {
  let found: { runtime: FakeRuntime; id: string } | undefined
  await vi.waitFor(() => {
    const runtime = provider.runtimes[0]
    const sent = runtime?.sent.find((entry) => entry.recipient === recipient)
    if (runtime === undefined || sent === undefined) {
      throw new Error('nothing sent yet')
    }
    found = { runtime, id: sent.id }
  })
  expect(found?.runtime.handlers?.answer(found.id, optionIndex)).toBe('accepted')
}

function recipients(provider: TestProvider): (string | undefined)[] {
  return (provider.runtimes[0]?.sent ?? []).map((entry) => entry.recipient)
}

test('a vote sends one message per voter', async () => {
  const { provider } = createProvider()
  const { deps } = createDeps(provider)
  const answered = Promise.all([answerVoter(provider, 'a', 0), answerVoter(provider, 'b', 0)])
  expect(await runDirectSendRequest({ ...REQUEST, voters: ['a', 'b'], rule: 'all' }, deps)).toBe(0)
  await answered
  expect(recipients(provider)).toEqual(['a', 'b'])
})

test('an approved vote exits 0 and prints the approve answer', async () => {
  const { provider } = createProvider()
  const { deps, printed } = createDeps(provider)
  const answered = answerVoter(provider, 'a', 0)
  expect(await runDirectSendRequest({ ...REQUEST, voters: ['a'] }, deps)).toBe(0)
  await answered
  expect(printed).toEqual(['Yes'])
})

test('a rejected vote exits 3 and prints the reject answer', async () => {
  const { provider } = createProvider()
  const { deps, printed } = createDeps(provider)
  const answered = answerVoter(provider, 'a', 1)
  expect(await runDirectSendRequest({ ...REQUEST, voters: ['a'] }, deps)).toBe(3)
  await answered
  expect(printed).toEqual(['No'])
})

test('the vote tally is printed as json', async () => {
  const { provider } = createProvider()
  const { deps, printed } = createDeps(provider)
  const answered = Promise.all([answerVoter(provider, 'a', 0), answerVoter(provider, 'b', 0)])
  const args = {
    ...REQUEST,
    voters: ['a', 'b', 'c'],
    rule: 'majority',
    json: true,
  } as const
  expect(await runDirectSendRequest(args, deps)).toBe(0)
  await answered
  expect(printed).toEqual([
    '{"answer":"Yes","timedOut":false,"approved":true,"require":"majority","votes":{"a":"Yes","b":"Yes","c":null},"rounds":1}',
  ])
})

test('duplicate voter ids count once', async () => {
  const { provider } = createProvider()
  const { deps } = createDeps(provider)
  const answered = answerVoter(provider, 'a', 0)
  const args = { ...REQUEST, voters: ['a', 'a'], rule: 'majority' } as const
  expect(await runDirectSendRequest(args, deps)).toBe(0)
  await answered
  expect(recipients(provider)).toEqual(['a'])
})

test('require without voters asks the owner alone', async () => {
  const { provider } = createProvider()
  const { deps } = createDeps(provider)
  const answered = answerVoter(provider, 'o', 0)
  expect(await runDirectSendRequest({ ...REQUEST, rule: 'majority' }, deps)).toBe(0)
  await answered
  expect(recipients(provider)).toEqual(['o'])
})

test('voters without a rule require all', async () => {
  const { provider } = createProvider()
  const { deps } = createDeps(provider)
  const answered = Promise.all([answerVoter(provider, 'a', 0), answerVoter(provider, 'b', 1)])
  expect(await runDirectSendRequest({ ...REQUEST, voters: ['a', 'b'] }, deps)).toBe(3)
  await answered
})

test("a voter id the provider can't parse exits 1 before anything is sent", async () => {
  const base = createPairingFakeProvider()
  const { provider } = createProvider(
    {},
    {
      settings: base.settings.map((setting) =>
        setting.owner
          ? {
              ...setting,
              parse: (raw: unknown) => (raw === 'bad' ? undefined : setting.parse(raw)),
            }
          : setting,
      ),
    },
  )
  const { deps, errors } = createDeps(provider)
  expect(await runDirectSendRequest({ ...REQUEST, voters: ['a', 'bad'] }, deps)).toBe(1)
  expect(errors).toEqual(['jaypost: invalid user id "bad"'])
  expect(provider.runtimes).toEqual([])
})

test('voter ids are normalized to the form the provider parses them to', async () => {
  const base = createPairingFakeProvider()
  const { provider } = createProvider(
    {},
    {
      settings: base.settings.map((setting) =>
        setting.owner
          ? {
              ...setting,
              // Like Telegram: a numeric id, so "0111" and " 111" are the user 111.
              parse: (raw: unknown) =>
                typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : undefined,
            }
          : setting,
      ),
    },
  )
  const { deps, printed } = createDeps(provider, undefined, { ...ENV, FAKE_OWNER: '9' })
  const answered = answerVoter(provider, '111', 0)
  const args = { ...REQUEST, voters: ['0111', ' 111', '111'], rule: 'all', json: true } as const
  expect(await runDirectSendRequest(args, deps)).toBe(0)
  await answered
  expect(recipients(provider)).toEqual(['111'])
  expect(printed).toEqual([
    '{"answer":"Yes","timedOut":false,"approved":true,"require":"all","votes":{"111":"Yes"},"rounds":1}',
  ])
})

test('a failed send to one voter exits 1 naming them', async () => {
  const { provider } = createProvider({
    sendRequest: async (_id, _message, _options, _allowText, _attachment, recipient) => {
      if (recipient === 'b') {
        throw new Error('token leaked')
      }
      return { n: 1 }
    },
  })
  const { deps, errors } = createDeps(provider)
  expect(await runDirectSendRequest({ ...REQUEST, voters: ['a', 'b'] }, deps)).toBe(1)
  expect(errors).toEqual(['jaypost: failed to send message to b'])
})

test('a plain question with retries is re-asked after a timeout', async () => {
  let sendCount = 0
  const { provider } = createProvider({
    // Answer the second send right away; the 10 ms timeout is too short to poll for it.
    sendRequest: async (id) => {
      sendCount += 1
      if (sendCount === 2) {
        setTimeout(() => provider.runtimes[0]?.handlers?.answer(id, 0), 0)
      }
      return { n: sendCount }
    },
  })
  const { deps, printed } = createDeps(provider)
  const args = { ...REQUEST, timeout: 0.01, retryCount: 1 }
  expect(await runDirectSendRequest(args, deps)).toBe(0)
  expect(sendCount).toBe(2)
  expect(printed).toEqual(['Yes'])
})
