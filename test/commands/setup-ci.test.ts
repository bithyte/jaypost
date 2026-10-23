import { expect, test, vi } from 'vite-plus/test'
import { PromptAborted, runSetupCi } from '../../src/commands/index.ts'
import type { Prompts, SetupCiDeps } from '../../src/commands/index.ts'
import type { PairResult } from '../../src/pairing/index.ts'
import type { CredentialCheck, ProviderRuntime, SettingValues } from '../../src/provider/index.ts'
import { createFakeProvider, createPairingFakeProvider } from '../provider/fake.ts'
import type { FakeRuntime } from '../provider/fake.ts'
import { createRecordingProgress } from '../progress/recording.ts'

const CODE = 'ABCDEFGH'
const ACCEPTED: CredentialCheck = { ok: true, displayName: 'fake' }

function createPrompts(): Prompts {
  return {
    confirm: vi.fn(async (_message: string, initialValue: boolean) => initialValue),
    password: vi.fn(async () => 'k'),
    text: vi.fn(async () => 'k'),
    select: vi.fn(async (_message, _options, initialValue) => initialValue),
  }
}

/** The pairing fake, with a spied `stop` and optional overrides. */
function createProvider(
  options: {
    readonly runtime?: Partial<ProviderRuntime>
    readonly checkCredentials?: (settings: SettingValues) => Promise<CredentialCheck>
  } = {},
) {
  const pairing = createPairingFakeProvider()
  const stop = vi.fn(async () => {})
  const provider = createFakeProvider({
    name: pairing.name,
    label: pairing.label,
    settings: pairing.settings,
    setup: {
      ...pairing.setup,
      ...(options.checkCredentials === undefined
        ? {}
        : { checkCredentials: options.checkCredentials }),
    },
    runtime: { pairingInstructions: (code) => `Say ${code} to fake`, stop, ...options.runtime },
  })
  return { provider, stop }
}

/** The recording behind the deps `createDeps` built last; reset by each call. */
let recording = createRecordingProgress()

function createDeps(
  provider: SetupCiDeps['providers'][number],
  printed: string[],
  over: Partial<SetupCiDeps> = {},
): SetupCiDeps {
  recording = createRecordingProgress()
  return {
    progress: recording.progress,
    prompt: createPrompts(),
    providers: [provider],
    print: (text) => printed.push(text),
    log: () => {},
    generateCode: () => CODE,
    ...over,
  }
}

async function waitForStart(runtimes: readonly FakeRuntime[]): Promise<FakeRuntime> {
  await vi.waitFor(() => expect(runtimes[0]?.handlers).toBeDefined())
  const runtime = runtimes[0]
  if (runtime === undefined) {
    throw new Error('no runtime created')
  }
  return runtime
}

async function pairWhenStarted(
  runtimes: readonly FakeRuntime[],
  senderId: string,
  text: string,
): Promise<PairResult | undefined> {
  const runtime = await waitForStart(runtimes)
  return runtime.handlers?.pair?.(senderId, text)
}

test('pairs and prints the env vars last', async () => {
  const { provider, stop } = createProvider()
  const printed: string[] = []
  const running = runSetupCi({}, createDeps(provider, printed))
  expect(await pairWhenStarted(provider.runtimes, 'owner-1', 'abcd-efgh')).toBe('paired')
  expect(await running).toBe(0)
  expect(printed.slice(-4)).toEqual([
    'JAYPOST_MODE=direct',
    'JAYPOST_PROVIDER=fakepair',
    'FAKE_KEY=k',
    'FAKE_OWNER=owner-1',
  ])
  expect(stop).toHaveBeenCalled()
})

test("shows the pairing code and the provider's instructions", async () => {
  const { provider } = createProvider()
  const printed: string[] = []
  const running = runSetupCi({}, createDeps(provider, printed))
  await pairWhenStarted(provider.runtimes, 'owner-1', CODE)
  expect(await running).toBe(0)
  expect(recording.events).toContain('note:Pairing code: ABCD-EFGH')
  expect(recording.events).toContain('note:Say ABCDEFGH to fake')
  expect(printed).not.toContain('Pairing code: ABCD-EFGH')
})

test('setup-ci shows the owner pairing as a step and prints the env block on stdout', async () => {
  const { provider } = createProvider()
  const printed: string[] = []
  const running = runSetupCi({}, createDeps(provider, printed))
  await pairWhenStarted(provider.runtimes, 'owner-1', CODE)
  expect(await running).toBe(0)
  expect(recording.events).toEqual([
    'done:Bot token checked (fake)',
    'start:Waiting for the owner to pair',
    'note:Pairing code: ABCD-EFGH',
    `note:Say ${CODE} to fake`,
    'succeed:Owner paired',
  ])
  expect(printed).toEqual([
    '',
    expect.stringContaining('GitHub secrets'),
    'JAYPOST_MODE=direct',
    'JAYPOST_PROVIDER=fakepair',
    'FAKE_KEY=k',
    'FAKE_OWNER=owner-1',
  ])
})

test('setup-ci cancels the owner step on interrupt and fails it when blocked or fatal', async () => {
  const { provider } = createProvider()
  const controller = new AbortController()
  const running = runSetupCi({}, createDeps(provider, [], { signal: controller.signal }))
  await waitForStart(provider.runtimes)
  controller.abort()
  expect(await running).toBe(130)
  expect(recording.events).toContain('cancel:Waiting for the owner to pair')
  const blocked = createProvider()
  const blockedRunning = runSetupCi({}, createDeps(blocked.provider, []))
  const runtime = await waitForStart(blocked.provider.runtimes)
  while (runtime.handlers?.pair?.('stranger', 'WRONG') !== 'blocked') {
    // keep guessing
  }
  expect(await blockedRunning).toBe(1)
  expect(recording.events).toContain('fail:Waiting for the owner to pair')
  const fatal = createProvider({
    runtime: { start: (handlers) => handlers.fatal('Fake went away') },
  })
  expect(await runSetupCi({}, createDeps(fatal.provider, []))).toBe(1)
  expect(recording.events).toContain('fail:Waiting for the owner to pair')
})

test('setup-ci adds an approver step for each yes', async () => {
  const { provider } = createProvider()
  const printed: string[] = []
  const running = runSetupCi(
    { approversOnly: true },
    createDeps(provider, printed, {
      prompt: createConfirms(true, true, false),
      generateCode: createCodes(),
    }),
  )
  await pairWhenShown(provider.runtimes, 'ABCDEFGH', 'a')
  await pairWhenShown(provider.runtimes, 'JKLMNPQR', 'b')
  expect(await running).toBe(0)
  expect(recording.events.filter((event) => /^(start|succeed):/.test(event))).toEqual([
    'start:Waiting for an approver to pair',
    'succeed:Approver paired',
    'start:Waiting for an approver to pair',
    'succeed:Approver paired',
  ])
  expect(printed).toEqual([APPROVERS_HEADING, '-u a -u b'])
})

test('pairing handlers answer nothing else', async () => {
  const { provider } = createProvider()
  const running = runSetupCi({}, createDeps(provider, []))
  const runtime = await waitForStart(provider.runtimes)
  const handlers = runtime.handlers
  expect(handlers?.answer('id', 0)).toBe('expired')
  expect(handlers?.reply('id', 'text')).toBe('expired')
  expect(handlers?.dismiss('id')).toBe(false)
  expect(handlers?.commands).toEqual([])
  expect(handlers?.command('help', '')).toBeUndefined()
  handlers?.pair?.('owner-1', CODE)
  expect(await running).toBe(0)
})

test("a wrong code doesn't pair", async () => {
  const { provider } = createProvider()
  const printed: string[] = []
  const running = runSetupCi({}, createDeps(provider, printed))
  expect(await pairWhenStarted(provider.runtimes, 'owner-1', 'WRONG')).toBe('wrong')
  expect(await pairWhenStarted(provider.runtimes, 'owner-1', CODE)).toBe('paired')
  expect(await running).toBe(0)
  expect(printed.at(-1)).toBe('FAKE_OWNER=owner-1')
})

test('asks again after a rejected token', async () => {
  const checkCredentials = vi
    .fn<(settings: SettingValues) => Promise<CredentialCheck>>()
    .mockResolvedValueOnce({ ok: false, reason: 'no' })
    .mockResolvedValue(ACCEPTED)
  const { provider } = createProvider({ checkCredentials })
  const printed: string[] = []
  const deps = createDeps(provider, printed)
  const running = runSetupCi({}, deps)
  await pairWhenStarted(provider.runtimes, 'owner-1', CODE)
  expect(await running).toBe(0)
  expect(recording.notes()).toContain('Fake rejected that key. Try again.')
  expect(deps.prompt.password).toHaveBeenCalledTimes(2)
})

test('picks the provider named by --provider', async () => {
  const { provider } = createProvider()
  const printed: string[] = []
  const deps = createDeps(provider, printed, { providers: [createFakeProvider(), provider] })
  const running = runSetupCi({ provider: 'fakepair' }, deps)
  await pairWhenStarted(provider.runtimes, 'owner-1', CODE)
  expect(await running).toBe(0)
  expect(deps.prompt.select).not.toHaveBeenCalled()
  expect(printed).toContain('JAYPOST_PROVIDER=fakepair')
})

test('asks which provider when several are registered, defaulting to the first', async () => {
  const other = createFakeProvider()
  const printed: string[] = []
  const deps = createDeps(other, printed, { providers: [other, createProvider().provider] })
  expect(await runSetupCi({}, deps)).toBe(0)
  expect(deps.prompt.select).toHaveBeenCalledWith(
    'Which chat app should the bot use?',
    [
      { value: 'fake', label: 'Fake' },
      { value: 'fakepair', label: 'Fake pair' },
    ],
    'fake',
  )
  expect(printed.slice(-3)).toEqual(['JAYPOST_MODE=direct', 'JAYPOST_PROVIDER=fake', 'FAKE_KEY=k'])
})

test('interrupting while waiting exits 130 without printing env vars', async () => {
  const { provider, stop } = createProvider()
  const printed: string[] = []
  const controller = new AbortController()
  const running = runSetupCi({}, createDeps(provider, printed, { signal: controller.signal }))
  await waitForStart(provider.runtimes)
  controller.abort()
  expect(await running).toBe(130)
  expect(printed.filter((line) => line.startsWith('JAYPOST_'))).toEqual([])
  expect(stop).toHaveBeenCalled()
})

test('interrupting a prompt exits 130', async () => {
  const { provider } = createProvider()
  const printed: string[] = []
  const prompt = createPrompts()
  vi.mocked(prompt.password).mockRejectedValue(new PromptAborted())
  expect(await runSetupCi({}, createDeps(provider, printed, { prompt }))).toBe(130)
  expect(printed.filter((line) => line.startsWith('JAYPOST_'))).toEqual([])
  expect(provider.runtimes).toEqual([])
})

test('a fatal provider error exits 1 with its message, secrets masked', async () => {
  const { provider, stop } = createProvider({
    runtime: { start: (handlers) => handlers.fatal('Fake went away, key secret-key') },
  })
  const printed: string[] = []
  const prompt = createPrompts()
  vi.mocked(prompt.password).mockResolvedValue('secret-key')
  expect(await runSetupCi({}, createDeps(provider, printed, { prompt }))).toBe(1)
  expect(recording.notes()).toContain('Setup failed: Fake went away, key ***')
  expect(printed.filter((line) => line.startsWith('JAYPOST_'))).toEqual([])
  expect(stop).toHaveBeenCalled()
})

test('too many wrong codes exit 1', async () => {
  const { provider, stop } = createProvider()
  const printed: string[] = []
  const running = runSetupCi({}, createDeps(provider, printed))
  const runtime = await waitForStart(provider.runtimes)
  let result: PairResult | undefined
  while (result !== 'blocked') {
    result = runtime.handlers?.pair?.('stranger', 'WRONG')
  }
  expect(await running).toBe(1)
  expect(printed.filter((line) => line.startsWith('JAYPOST_'))).toEqual([])
  expect(stop).toHaveBeenCalled()
})

test('rejected runtime credentials exit 1 with the reason', async () => {
  const { provider, stop } = createProvider({
    runtime: { checkCredentials: async () => ({ ok: false, reason: 'Fake said no' }) },
  })
  const printed: string[] = []
  expect(await runSetupCi({}, createDeps(provider, printed))).toBe(1)
  expect(recording.notes().join('\n')).toContain('Fake said no')
  expect(provider.runtimes[0]?.handlers).toBeUndefined()
  expect(stop).toHaveBeenCalled()
})

test('an unknown --provider exits 1', async () => {
  const { provider } = createProvider()
  const printed: string[] = []
  expect(await runSetupCi({ provider: 'nope' }, createDeps(provider, printed))).toBe(1)
  expect(recording.notes()).toEqual(['Unknown provider "nope".'])
  expect(printed).toEqual([])
})

const APPROVER_CODES = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ']

/** Codes handed out in order, then the last one again. */
function createCodes(): () => string {
  let next = 0
  return () => APPROVER_CODES[Math.min(next++, APPROVER_CODES.length - 1)] ?? CODE
}

/** Confirm answers in order; later calls answer no. */
function createConfirms(...answers: readonly boolean[]): Prompts {
  const prompt = createPrompts()
  const queue = [...answers]
  vi.mocked(prompt.confirm).mockImplementation(async () => queue.shift() ?? false)
  return prompt
}

/** Waits until `code` is shown, then sends it as `senderId`. */
async function pairWhenShown(
  runtimes: readonly FakeRuntime[],
  code: string,
  senderId: string,
): Promise<PairResult | undefined> {
  const shown = `note:Pairing code: ${code.slice(0, 4)}-${code.slice(4)}`
  await vi.waitFor(() => expect(recording.events).toContain(shown))
  return runtimes[0]?.handlers?.pair?.(senderId, code)
}

const APPROVERS_HEADING = 'Approvers (pass to send request):'

test('pairs approvers after the owner and prints their -u line last', async () => {
  const { provider, stop } = createProvider()
  const printed: string[] = []
  const prompt = createConfirms(true, true, false)
  const running = runSetupCi(
    {},
    createDeps(provider, printed, { prompt, generateCode: createCodes() }),
  )
  const [first, second, third] = APPROVER_CODES
  expect(await pairWhenShown(provider.runtimes, first ?? '', 'o')).toBe('paired')
  expect(await pairWhenShown(provider.runtimes, second ?? '', 'a')).toBe('paired')
  expect(await pairWhenShown(provider.runtimes, third ?? '', 'b')).toBe('paired')
  expect(await running).toBe(0)
  expect(prompt.confirm).toHaveBeenCalledWith('Pair an approver?', false)
  expect(printed).toContain('FAKE_OWNER=o')
  expect(recording.notes()).toContain('Approver paired: a')
  expect(recording.notes()).toContain('Approver paired: b')
  expect(printed.slice(-2)).toEqual([APPROVERS_HEADING, '-u a -u b'])
  expect(stop).toHaveBeenCalledTimes(1)
})

test('the env block prints before approvers are asked about', async () => {
  const { provider } = createProvider()
  const printed: string[] = []
  const prompt = createPrompts()
  let ownerLineIndexAtAsk: number | undefined
  vi.mocked(prompt.confirm).mockImplementation(async () => {
    ownerLineIndexAtAsk = printed.indexOf('FAKE_OWNER=o')
    return false
  })
  const running = runSetupCi({}, createDeps(provider, printed, { prompt }))
  await pairWhenStarted(provider.runtimes, 'o', CODE)
  expect(await running).toBe(0)
  expect(ownerLineIndexAtAsk).toBeGreaterThanOrEqual(0)
})

test('no approvers prints the same output as before', async () => {
  const { provider } = createProvider()
  const printed: string[] = []
  const running = runSetupCi({}, createDeps(provider, printed, { prompt: createConfirms(false) }))
  await pairWhenStarted(provider.runtimes, 'owner-1', CODE)
  expect(await running).toBe(0)
  expect(recording.notes()).toEqual(['Pairing code: ABCD-EFGH', `Say ${CODE} to fake`])
  expect(printed).toEqual([
    '',
    expect.stringContaining('GitHub secrets'),
    'JAYPOST_MODE=direct',
    'JAYPOST_PROVIDER=fakepair',
    'FAKE_KEY=k',
    'FAKE_OWNER=owner-1',
  ])
})

test('approvers-only skips the owner and the env block', async () => {
  const { provider, stop } = createProvider()
  const printed: string[] = []
  const prompt = createConfirms(true, false)
  const running = runSetupCi(
    { approversOnly: true },
    createDeps(provider, printed, { prompt, generateCode: createCodes() }),
  )
  expect(await pairWhenShown(provider.runtimes, 'ABCDEFGH', 'a')).toBe('paired')
  expect(await running).toBe(0)
  expect(printed.filter((line) => line.startsWith('JAYPOST_'))).toEqual([])
  expect(printed).not.toContain('FAKE_KEY=k')
  expect(printed.slice(-2)).toEqual([APPROVERS_HEADING, '-u a'])
  expect(stop).toHaveBeenCalledTimes(1)
})

test('approvers use approverPairingInstructions when the provider has it', async () => {
  const { provider } = createProvider({
    runtime: { approverPairingInstructions: (code) => `Invite them, then say ${code}` },
  })
  const printed: string[] = []
  const running = runSetupCi(
    { approversOnly: true },
    createDeps(provider, printed, { prompt: createConfirms(true, false) }),
  )
  await pairWhenShown(provider.runtimes, CODE, 'a')
  expect(await running).toBe(0)
  expect(recording.events).toContain(`note:Invite them, then say ${CODE}`)
  expect(recording.events).not.toContain(`note:Say ${CODE} to fake`)
})

test('a blocked approver code asks again', async () => {
  const { provider } = createProvider()
  const printed: string[] = []
  const prompt = createConfirms(true, true, false)
  const running = runSetupCi(
    { approversOnly: true },
    createDeps(provider, printed, { prompt, generateCode: createCodes() }),
  )
  await vi.waitFor(() => expect(recording.events).toContain('note:Pairing code: ABCD-EFGH'))
  let result: PairResult | undefined
  while (result !== 'blocked') {
    result = provider.runtimes[0]?.handlers?.pair?.('stranger', 'WRONG')
  }
  expect(await pairWhenShown(provider.runtimes, 'JKLMNPQR', 'b')).toBe('paired')
  expect(await running).toBe(0)
  expect(recording.notes()).toContain('Too many wrong pairing codes for that approver.')
  expect(prompt.confirm).toHaveBeenCalledTimes(3)
  expect(printed.slice(-2)).toEqual([APPROVERS_HEADING, '-u b'])
})

test('an interrupt while waiting for an approver prints those paired so far and returns 130', async () => {
  const { provider, stop } = createProvider()
  const printed: string[] = []
  const controller = new AbortController()
  const running = runSetupCi(
    { approversOnly: true },
    createDeps(provider, printed, {
      prompt: createConfirms(true, true),
      generateCode: createCodes(),
      signal: controller.signal,
    }),
  )
  await pairWhenShown(provider.runtimes, 'ABCDEFGH', 'a')
  await vi.waitFor(() => expect(recording.events).toContain('note:Pairing code: JKLM-NPQR'))
  controller.abort()
  expect(await running).toBe(130)
  expect(printed.slice(-2)).toEqual([APPROVERS_HEADING, '-u a'])
  expect(stop).toHaveBeenCalledTimes(1)
})

test('an interrupted approver prompt counts as an interrupt', async () => {
  const { provider } = createProvider()
  const printed: string[] = []
  const prompt = createPrompts()
  vi.mocked(prompt.confirm).mockRejectedValue(new PromptAborted())
  const running = runSetupCi({}, createDeps(provider, printed, { prompt }))
  await pairWhenStarted(provider.runtimes, 'o', CODE)
  expect(await running).toBe(130)
  expect(printed).toContain('FAKE_OWNER=o')
})

test('an interrupt before the approver prompt returns 130', async () => {
  const controller = new AbortController()
  const { provider, stop } = createProvider({
    runtime: {
      checkCredentials: async () => {
        controller.abort()
        return ACCEPTED
      },
    },
  })
  const printed: string[] = []
  const prompt = createPrompts()
  const running = runSetupCi(
    { approversOnly: true },
    createDeps(provider, printed, { prompt, signal: controller.signal }),
  )
  expect(await running).toBe(130)
  expect(printed).toEqual([])
  expect(recording.notes()).toEqual([''])
  expect(prompt.confirm).not.toHaveBeenCalled()
  expect(stop).toHaveBeenCalledTimes(1)
})

test('an interrupt during the approver prompt prints those paired so far and returns 130', async () => {
  const { provider } = createProvider()
  const printed: string[] = []
  const controller = new AbortController()
  const prompt = createPrompts()
  vi.mocked(prompt.confirm)
    .mockImplementationOnce(async () => true)
    .mockImplementationOnce(async () => {
      controller.abort()
      return false
    })
  const running = runSetupCi(
    { approversOnly: true },
    createDeps(provider, printed, { prompt, signal: controller.signal }),
  )
  await pairWhenShown(provider.runtimes, CODE, 'a')
  expect(await running).toBe(130)
  expect(printed.slice(-2)).toEqual([APPROVERS_HEADING, '-u a'])
  expect(recording.notes().at(-1)).toBe('')
})

test('a provider failure while waiting for an approver prints the block and the reason', async () => {
  const { provider } = createProvider()
  const printed: string[] = []
  const prompt = createConfirms(true, true)
  vi.mocked(prompt.password).mockResolvedValue('secret-key')
  const running = runSetupCi(
    { approversOnly: true },
    createDeps(provider, printed, { prompt, generateCode: createCodes() }),
  )
  await pairWhenShown(provider.runtimes, 'ABCDEFGH', 'a')
  await vi.waitFor(() => expect(recording.events).toContain('note:Pairing code: JKLM-NPQR'))
  provider.runtimes[0]?.handlers?.fatal('Fake went away, key secret-key')
  expect(await running).toBe(1)
  expect(printed.slice(-2)).toEqual([APPROVERS_HEADING, '-u a'])
  expect(recording.notes().at(-1)).toBe('Setup failed: Fake went away, key ***')
})

test('the runtime starts once and stops once', async () => {
  let starts = 0
  const { provider, stop } = createProvider({
    runtime: {
      start: (handlers) => {
        starts += 1
        const runtime = provider.runtimes.at(-1)
        if (runtime !== undefined) {
          runtime.handlers = handlers
        }
      },
    },
  })
  const printed: string[] = []
  const running = runSetupCi(
    {},
    createDeps(provider, printed, {
      prompt: createConfirms(true, true, false),
      generateCode: createCodes(),
    }),
  )
  await pairWhenShown(provider.runtimes, 'ABCDEFGH', 'o')
  await pairWhenShown(provider.runtimes, 'JKLMNPQR', 'a')
  await pairWhenShown(provider.runtimes, 'STUVWXYZ', 'b')
  expect(await running).toBe(0)
  expect(provider.runtimes).toHaveLength(1)
  expect(starts).toBe(1)
  expect(stop).toHaveBeenCalledTimes(1)
})
