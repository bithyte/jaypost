import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vite-plus/test'
import { runVote } from '@jaypost/core'
import type {
  ApprovalRequest,
  Provider,
  ProviderRuntime,
  QuietHours,
  QuietPatch,
} from '@jaypost/core'
import { LOCAL_PERSON } from '@jaypost/store'
import type { BotRecord } from '@jaypost/store'
import { createFakeProvider, createPairingFakeProvider } from '@jaypost/testing'
import type { FakeRuntime } from '@jaypost/testing'
import { startBot } from '../../src/daemon/index.ts'
import type { BotPeople, RunningBot } from '../../src/daemon/index.ts'

const RECORD: BotRecord = {
  id: 'b2',
  provider: 'fakepair',
  settings: { fakeKey: 'k' },
  createdAt: '2026-10-26T00:00:00.000Z',
}

const REQUEST: ApprovalRequest = {
  message: { text: 'Deploy?', spans: [] },
  question: 'Deploy?',
  options: ['Approve', 'Decline'],
  timeoutOption: 'Decline',
  allowText: false,
  timeoutSeconds: 300,
  attachment: undefined,
}

const NOTE = { message: { text: 'hi', spans: [] }, attachment: undefined }

let running: RunningBot | undefined

afterEach(async () => {
  await running?.stop()
  running = undefined
})

type Quiet = { readonly quietHours?: QuietHours; readonly mutedUntil?: Date }

/** An in-memory registry view: `claim` pairs the person, like the hub does after saving. */
function createPeople(
  options: {
    readonly persons?: readonly string[]
    readonly codes?: ReadonlyMap<string, string>
    readonly claim?: (pairingId: string, person: string) => void
    readonly quiet?: ReadonlyMap<string, Quiet>
    readonly saveQuiet?: (person: string, patch: QuietPatch) => void
  } = {},
): BotPeople {
  const persons = [...(options.persons ?? [])]
  return {
    isPaired: (person) => persons.includes(person),
    list: () => persons,
    pendingCodes: () => options.codes ?? new Map(),
    claim: (pairingId, person) => {
      persons.push(person)
      options.claim?.(pairingId, person)
    },
    quietHours: (person) => options.quiet?.get(person) ?? {},
    saveQuiet: options.saveQuiet ?? (() => undefined),
  }
}

function createDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'jaypost-bot-'))
}

async function start(
  options: {
    readonly people?: BotPeople
    readonly provider?: Provider & { readonly runtimes: FakeRuntime[] }
    readonly directory?: string
    readonly log?: (line: string) => void
  } = {},
): Promise<{ running: RunningBot; runtime: FakeRuntime }> {
  const provider = options.provider ?? createPairingFakeProvider()
  running = await startBot({
    record: RECORD,
    provider,
    directory: options.directory ?? createDirectory(),
    people: options.people ?? createPeople(),
    fatal: vi.fn(),
    log: options.log ?? vi.fn(),
  })
  const runtime = provider.runtimes.at(-1)
  if (runtime === undefined) {
    throw new Error('no runtime created')
  }
  return { running, runtime }
}

/** A provider (pairing unless `pairs` is false) that records each notification and its silence. */
function createNotifyingProvider(options: { readonly pairs?: boolean } = {}) {
  const notified: { recipient: string | undefined; silent: boolean }[] = []
  const sendNotification: ProviderRuntime['sendNotification'] = async (_id, _message, sent) => {
    notified.push({ recipient: sent.recipient, silent: sent.silent })
    return { n: notified.length }
  }
  if (options.pairs === false) {
    return { provider: createFakeProvider({ runtime: { sendNotification } }), notified }
  }
  const provider = createFakeProvider({
    name: 'fakepair',
    settings: createPairingFakeProvider().settings,
    // Wide enough that /pending lists every question in these tests.
    maxTextLength: 1000,
    runtime: {
      pairingInstructions: (code) => `Say ${code} to fake`,
      sendNotification,
      // With finalize, open requests are saved to the state file.
      finalize: async () => undefined,
    },
  })
  return { provider, notified }
}

test('a pending code pairs a new person and the hub is told which pairing', async () => {
  const claim = vi.fn()
  const log = vi.fn()
  const { runtime } = await start({
    people: createPeople({ persons: ['u1'], codes: new Map([['p2', 'K7QM4XPD']]), claim }),
    log,
  })
  expect(runtime.handlers?.isPaired('u2')).toBe(false)
  expect(runtime.handlers?.pair?.('u2', 'K7QM4XPD')).toBe('paired')
  expect(claim).toHaveBeenCalledWith('p2', 'u2')
  expect(runtime.handlers?.isPaired('u2')).toBe(true)
  expect(runtime.handlers?.listPaired()).toEqual(['u1', 'u2'])
  expect(log).toHaveBeenCalledWith('[b2] paired u2 on b2')
  expect(log.mock.calls.flat().join('\n')).not.toContain('K7QM4XPD')
  expect(runtime.handlers?.pair?.('u3', 'K7QM4XPD')).toBe('notPairing')
})

test('codes the hub adds at runtime can be redeemed', async () => {
  const claim = vi.fn()
  const { running, runtime } = await start({ people: createPeople({ claim }) })
  expect(runtime.handlers?.pair?.('u1', 'K7QM4XPD')).toBe('notPairing')
  running.codes.add('p3', 'ABCD2345')
  expect(runtime.handlers?.pair?.('u1', 'abcd-2345')).toBe('paired')
  expect(claim).toHaveBeenCalledWith('p3', 'u1')
})

test("a paired person's chat text is not counted as a wrong code", async () => {
  const claim = vi.fn()
  const { runtime } = await start({
    people: createPeople({ persons: ['u1'], codes: new Map([['p2', 'K7QM4XPD']]), claim }),
  })
  for (let index = 0; index < 5; index += 1) {
    expect(runtime.handlers?.pair?.('u1', 'hello')).toBe('notPairing')
  }
  expect(claim).not.toHaveBeenCalled()
  expect(runtime.handlers?.pair?.('u1', 'K7QM4XPD')).toBe('paired')
  expect(claim).toHaveBeenCalledWith('p2', 'u1')
})

test('an unpaired sender is still counted for wrong codes and blocked', async () => {
  const { runtime } = await start({
    people: createPeople({ codes: new Map([['p2', 'K7QM4XPD']]) }),
  })
  for (let index = 0; index < 5; index += 1) {
    expect(runtime.handlers?.pair?.('u9', 'hello')).toBe('wrong')
  }
  expect(runtime.handlers?.pair?.('u9', 'K7QM4XPD')).toBe('blocked')
})

test('/pending and /cancel from one person leave the other person alone', async () => {
  const { running, runtime } = await start({
    provider: createNotifyingProvider().provider,
    people: createPeople({ persons: ['u1', 'u2', 'u3'] }),
  })
  const asked = running.bot.service.request({ ...REQUEST, recipient: 'u1' })
  const vote = runVote(
    running.bot.service,
    {
      request: { ...REQUEST, message: { text: 'Push?', spans: [] }, question: 'Push?' },
      voters: ['u1', 'u2', 'u3'],
      rule: 'majority',
      retryCount: 0,
    },
    new AbortController().signal,
  )
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(4))
  const pendingOfU2 = runtime.handlers?.command('pending', '', 'u2')
  expect(pendingOfU2).toContain('Push?')
  expect(pendingOfU2).not.toContain('Deploy?')
  const cancelled = runtime.handlers?.command('cancel', '', 'u2')
  expect(cancelled).toMatch(/^Rejected 1\n\nPush\?/)
  expect(runtime.handlers?.command('pending', '', 'u2')).toBe('Nothing pending.')
  const pendingOfU1 = runtime.handlers?.command('pending', '', 'u1')
  expect(pendingOfU1).toContain('Deploy?')
  expect(pendingOfU1).toContain('Push?')
  expect(runtime.handlers?.command('cancel', '', 'u1')).toMatch(/^Rejected 2\n\n/)
  expect(await asked).toEqual({
    kind: 'completed',
    outcome: { answer: 'Decline', timedOut: false },
  })
  expect(await vote).toMatchObject({ kind: 'decided', approved: false })
  const historyOfU2 = runtime.handlers?.command('history', '', 'u2')
  expect(historyOfU2).toContain('Push?')
  expect(historyOfU2).not.toContain('Deploy?')
})

test('/mute is per person: notifications to A are silent, to B ping', async () => {
  const { provider, notified } = createNotifyingProvider()
  const saveQuiet = vi.fn()
  const { running, runtime } = await start({
    provider,
    people: createPeople({ persons: ['u1', 'u2'], saveQuiet }),
  })
  expect(runtime.handlers?.command('mute', '2h', 'u1')).toMatch(/^Muted until /)
  expect(saveQuiet).toHaveBeenCalledWith('u1', { mutedUntil: expect.any(String) })
  await running.bot.notifications?.notify(NOTE, 'u1')
  await running.bot.notifications?.notify(NOTE, 'u2')
  expect(notified).toEqual([
    { recipient: 'u1', silent: true },
    { recipient: 'u2', silent: false },
  ])
  expect(runtime.handlers?.command('quiet', '', 'u2')).toContain('Not muted.')
})

test("each person's saved mute is read from people", async () => {
  const { provider, notified } = createNotifyingProvider()
  const quiet = new Map([['u2', { mutedUntil: new Date(Date.now() + 3_600_000) }]])
  const { running } = await start({
    provider,
    people: createPeople({ persons: ['u1', 'u2'], quiet }),
  })
  await running.bot.notifications?.notify(NOTE, 'u1')
  await running.bot.notifications?.notify(NOTE, 'u2')
  expect(notified).toEqual([
    { recipient: 'u1', silent: false },
    { recipient: 'u2', silent: true },
  ])
})

test("a failed quiet save keeps the mute and says it won't last", async () => {
  const { provider, notified } = createNotifyingProvider()
  const saveQuiet = () => {
    throw new Error('disk full')
  }
  const log = vi.fn()
  const { running, runtime } = await start({
    provider,
    people: createPeople({ persons: ['u1'], saveQuiet }),
    log,
  })
  expect(runtime.handlers?.command('mute', '2h', 'u1')).toMatch(
    /Couldn't save this; it resets on restart\.$/,
  )
  expect(log).toHaveBeenCalledWith("[b2] couldn't save quiet settings: disk full")
  await running.bot.notifications?.notify(NOTE, 'u1')
  expect(notified).toEqual([{ recipient: 'u1', silent: true }])
})

test('without voters, a vote goes to the given person', async () => {
  const { running, runtime } = await start({ people: createPeople({ persons: ['u1', 'u2'] }) })
  expect(running.bot.resolveVoters(undefined, 'u2')).toEqual({ kind: 'voters', voters: ['u2'] })
  expect(running.bot.resolveVoters(undefined, undefined)).toEqual({ kind: 'noOwner' })
  expect(running.bot.resolveVoters(['u1', 'u1', 'u3'], 'u2')).toEqual({
    kind: 'voters',
    voters: ['u1', 'u3'],
  })
  const resolved = running.bot.resolveVoters(undefined, 'u2')
  if (resolved.kind !== 'voters') {
    throw new Error('expected voters')
  }
  const vote = runVote(
    running.bot.service,
    { request: REQUEST, voters: resolved.voters, rule: 'all', retryCount: 0 },
    new AbortController().signal,
  )
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  expect(runtime.sent[0]?.recipient).toBe('u2')
  expect(runtime.handlers?.answer(runtime.sent[0]?.id ?? '', 0)).toBe('accepted')
  expect(await vote).toMatchObject({ kind: 'decided', approved: true, answer: 'Approve' })
})

test('a terminal-like bot runs commands for the local person over all its questions', async () => {
  const { provider, notified } = createNotifyingProvider({ pairs: false })
  const saveQuiet = vi.fn()
  const { running, runtime } = await start({
    provider,
    people: createPeople({ persons: [LOCAL_PERSON], saveQuiet }),
  })
  expect(runtime.handlers?.pair).toBeUndefined()
  expect(running.bot.pairingInstructions).toBeUndefined()
  expect(running.bot.recipient()).toBeUndefined()
  const asked = running.bot.service.request(REQUEST)
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  expect(runtime.sent[0]?.recipient).toBeUndefined()
  expect(runtime.handlers?.command('pending', '', undefined)).toContain('Deploy?')
  expect(runtime.handlers?.command('pending', '', 'someone')).toContain('Deploy?')
  expect(runtime.handlers?.command('mute', '1h', undefined)).toMatch(/^Muted until /)
  expect(saveQuiet).toHaveBeenCalledWith(LOCAL_PERSON, { mutedUntil: expect.any(String) })
  expect(runtime.handlers?.command('quiet', '', 'someone')).toContain('Muted until')
  await running.bot.notifications?.notify(NOTE, undefined)
  expect(notified).toEqual([{ recipient: undefined, silent: true }])
  expect(runtime.handlers?.command('cancel', '', undefined)).toMatch(/^Rejected 1\n\nDeploy\?/)
  expect(await asked).toEqual({
    kind: 'completed',
    outcome: { answer: 'Decline', timedOut: false },
  })
})

test("a forged tap from one person can't settle another person's question", async () => {
  const { running, runtime } = await start({ people: createPeople({ persons: ['u1', 'u2'] }) })
  const asked = running.bot.service.request({ ...REQUEST, recipient: 'u1' })
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  const id = runtime.sent[0]?.id ?? ''
  expect(runtime.handlers?.answer(id, 0, 'u2')).toBe('expired')
  expect(runtime.handlers?.command('pending', '', 'u1')).toMatch(/^1 pending\n/)
  // The fake runtime tracks nothing, so this is the untracked path for the question's own person.
  expect(runtime.handlers?.answer(id, 0, 'u1')).toBe('accepted')
  expect(await asked).toEqual({
    kind: 'completed',
    outcome: { answer: 'Approve', timedOut: false },
  })
})

test('a bot that does not pair accepts taps from any sender', async () => {
  const { running, runtime } = await start({
    provider: createFakeProvider(),
    people: createPeople({ persons: [LOCAL_PERSON] }),
  })
  const first = running.bot.service.request(REQUEST)
  const second = running.bot.service.request(REQUEST)
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(2))
  expect(runtime.handlers?.answer(runtime.sent[0]?.id ?? '', 0, undefined)).toBe('accepted')
  expect(runtime.handlers?.answer(runtime.sent[1]?.id ?? '', 1, 'someone')).toBe('accepted')
  expect(await first).toMatchObject({ outcome: { answer: 'Approve' } })
  expect(await second).toMatchObject({ outcome: { answer: 'Decline' } })
})

test('rejectForKeys settles the open questions of the given keys only', async () => {
  const { running, runtime } = await start({ people: createPeople({ persons: ['u1'] }) })
  const ask = (key: string) =>
    running.bot.service.request({ ...REQUEST, recipient: 'u1', caller: { key, pairing: 'p1' } })
  const first = ask('k1')
  const second = ask('k2')
  const kept = ask('k3')
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(3))
  running.bot.rejectForKeys(['k1', 'k2'])
  const declined = { kind: 'completed', outcome: { answer: 'Decline', timedOut: false } }
  expect(await first).toEqual(declined)
  expect(await second).toEqual(declined)
  const pending = runtime.handlers?.command('pending', '', 'u1')
  expect(pending).toMatch(/^1 pending\n/)
  expect(runtime.handlers?.answer(runtime.sent[2]?.id ?? '', 0)).toBe('accepted')
  expect(await kept).toEqual({ kind: 'completed', outcome: { answer: 'Approve', timedOut: false } })
})

test('describe and pairingInstructions show the provider without pairing state', async () => {
  const provider = createPairingFakeProvider()
  const { running } = await start({
    provider,
    people: createPeople({ codes: new Map([['p1', 'K7QM4XPD']]) }),
  })
  expect(running.bot.describe()).toEqual({ provider: 'fakepair', displayName: 'fake' })
  expect(running.bot.pairingInstructions?.('ABCD2345')).toBe('Say ABCD2345 to fake')
  expect(running.bot.status()).toEqual({
    paired: false,
    provider: 'fakepair',
    displayName: 'fake',
    code: 'K7QM-4XPD',
    instructions: 'Say K7QM4XPD to fake',
  })
})

test('state and audit go to the bot directory and log lines name the bot', async () => {
  const directory = createDirectory()
  writeFileSync(join(directory, 'state.json'), '{')
  const log = vi.fn()
  const { running, runtime } = await start({
    provider: createNotifyingProvider().provider,
    directory,
    log,
    people: createPeople({ persons: ['u1'] }),
  })
  expect(log).toHaveBeenCalledWith(
    `[b2] ignoring state file ${JSON.stringify(join(directory, 'state.json'))}: invalid JSON`,
  )
  const asked = running.bot.service.request({ ...REQUEST, recipient: 'u1' })
  await vi.waitFor(() => expect(runtime.sent).toHaveLength(1))
  await vi.waitFor(() =>
    expect(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')).requests).toHaveLength(
      1,
    ),
  )
  runtime.handlers?.answer(runtime.sent[0]?.id ?? '', 0)
  await asked
  const events = readFileSync(join(directory, 'audit.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).event)
  expect(events).toEqual(['asked', 'settled'])
})

test('rejected credentials throw with the provider reason', async () => {
  const provider = createFakeProvider({
    runtime: { checkCredentials: async () => ({ ok: false, reason: 'fake said no' }) },
  })
  await expect(start({ provider })).rejects.toThrow('fake said no')
})
