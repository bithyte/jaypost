import { expect, test, vi } from 'vite-plus/test'
import { SETUP_CI_APPROVERS_HINT } from '../../src/commands/constants.ts'
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

test('pairs and prints the env vars, then the approvers hint', async () => {
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
  expect(recording.notes().slice(-2)).toEqual(['', SETUP_CI_APPROVERS_HINT])
  expect(stop).toHaveBeenCalled()
})

test('does not ask about approvers', async () => {
  const { provider } = createProvider()
  const printed: string[] = []
  const deps = createDeps(provider, printed)
  const running = runSetupCi({}, deps)
  await pairWhenStarted(provider.runtimes, 'owner-1', CODE)
  expect(await running).toBe(0)
  expect(deps.prompt.confirm).not.toHaveBeenCalledWith('Pair an approver?', expect.anything())
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
    'note:',
    `note:${SETUP_CI_APPROVERS_HINT}`,
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
  const running = runSetupCi({}, createDeps(provider, printed))
  await pairWhenStarted(provider.runtimes, 'o', CODE)
  expect(await running).toBe(0)
  expect(provider.runtimes).toHaveLength(1)
  expect(starts).toBe(1)
  expect(stop).toHaveBeenCalledTimes(1)
})
