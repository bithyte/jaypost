import { expect, test, vi } from 'vite-plus/test'
import { PromptAborted, runPairApprover } from '../../src/commands/index.ts'
import type { PairApproverDeps, Prompts } from '../../src/commands/index.ts'
import type { CredentialCheck, PairResult, ProviderRuntime, SettingValues } from '@jaypost/core'
import { createFakeProvider, createPairingFakeProvider } from '@jaypost/testing'
import type { FakeRuntime } from '@jaypost/testing'
import { createRecordingProgress } from '../progress/recording.ts'

const CODE = 'ABCDEFGH'
const APPROVER_CODES = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ']
const ACCEPTED: CredentialCheck = { ok: true, displayName: 'fake' }
const HEADING =
  'Add these to your approvers list and the JAYPOST_APPROVERS secret (each also works as -u ID):'

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
  provider: PairApproverDeps['providers'][number],
  printed: string[],
  over: Partial<PairApproverDeps> = {},
): PairApproverDeps {
  recording = createRecordingProgress()
  return {
    progress: recording.progress,
    prompt: createPrompts(),
    providers: [provider],
    print: (text) => printed.push(text),
    log: () => {},
    generateCode: createCodes(),
    ...over,
  }
}

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
  const shown = `Pairing code: ${code.slice(0, 4)}-${code.slice(4)}`
  await vi.waitFor(() => expect(recording.notes()).toContain(shown))
  return runtimes[0]?.handlers?.pair?.(senderId, code)
}

/** Waits until `code` is shown, then sends wrong codes until the sender is blocked. */
async function blockWhenShown(runtimes: readonly FakeRuntime[], code: string): Promise<void> {
  const shown = `Pairing code: ${code.slice(0, 4)}-${code.slice(4)}`
  await vi.waitFor(() => expect(recording.notes()).toContain(shown))
  let result: PairResult | undefined
  while (result !== 'blocked') {
    result = runtimes[0]?.handlers?.pair?.('stranger', 'WRONG')
  }
}

test('pairs one approver without asking, then asks to pair another', async () => {
  const { provider, stop } = createProvider()
  const printed: string[] = []
  const prompt = createConfirms(true, false)
  const running = runPairApprover({}, createDeps(provider, printed, { prompt }))
  expect(await pairWhenShown(provider.runtimes, 'ABCDEFGH', 'a')).toBe('paired')
  expect(await pairWhenShown(provider.runtimes, 'JKLMNPQR', 'b')).toBe('paired')
  expect(await running).toBe(0)
  expect(prompt.confirm).toHaveBeenCalledTimes(2)
  expect(prompt.confirm).toHaveBeenNthCalledWith(1, 'Pair another?', false)
  expect(prompt.confirm).toHaveBeenNthCalledWith(2, 'Pair another?', false)
  expect(recording.notes()).toContain('Approver paired: a')
  expect(recording.notes()).toContain('Approver paired: b')
  expect(printed).toEqual([HEADING, 'a,b'])
  expect(stop).toHaveBeenCalledTimes(1)
})

test('shows each approver pairing as a step and prints only the ids on stdout', async () => {
  const { provider } = createProvider()
  const printed: string[] = []
  const running = runPairApprover(
    {},
    createDeps(provider, printed, { prompt: createConfirms(true, false) }),
  )
  await pairWhenShown(provider.runtimes, 'ABCDEFGH', 'a')
  await pairWhenShown(provider.runtimes, 'JKLMNPQR', 'b')
  expect(await running).toBe(0)
  expect(recording.events.filter((event) => /^(done|start|succeed):/.test(event))).toEqual([
    'done:Bot token checked (fake)',
    'start:Waiting for an approver to pair',
    'succeed:Approver paired',
    'start:Waiting for an approver to pair',
    'succeed:Approver paired',
  ])
  expect(printed).toEqual([HEADING, 'a,b'])
})

test('pairs no owner and prints no env vars', async () => {
  const { provider } = createProvider()
  const printed: string[] = []
  const running = runPairApprover(
    {},
    createDeps(provider, printed, { prompt: createConfirms(false) }),
  )
  await pairWhenShown(provider.runtimes, 'ABCDEFGH', 'a')
  expect(await running).toBe(0)
  expect(printed.filter((line) => line.startsWith('JAYPOST_'))).toEqual([])
  expect(printed).not.toContain('FAKE_KEY=k')
})

test('uses approverPairingInstructions when the provider has it', async () => {
  const { provider } = createProvider({
    runtime: { approverPairingInstructions: (code) => `Invite them, then say ${code}` },
  })
  const printed: string[] = []
  const running = runPairApprover({}, createDeps(provider, printed))
  await pairWhenShown(provider.runtimes, CODE, 'a')
  expect(await running).toBe(0)
  expect(recording.notes()).toContain(`Invite them, then say ${CODE}`)
  expect(recording.notes()).not.toContain(`Say ${CODE} to fake`)
})

test('falls back to pairingInstructions', async () => {
  const { provider } = createProvider()
  const printed: string[] = []
  const running = runPairApprover({}, createDeps(provider, printed))
  await pairWhenShown(provider.runtimes, CODE, 'a')
  expect(await running).toBe(0)
  expect(recording.notes()).toContain(`Say ${CODE} to fake`)
})

test('a blocked code says so and asks to pair another', async () => {
  const { provider } = createProvider()
  const printed: string[] = []
  const prompt = createConfirms(true, false)
  const running = runPairApprover({}, createDeps(provider, printed, { prompt }))
  await blockWhenShown(provider.runtimes, 'ABCDEFGH')
  expect(await pairWhenShown(provider.runtimes, 'JKLMNPQR', 'b')).toBe('paired')
  expect(await running).toBe(0)
  expect(recording.notes()).toContain('Too many wrong pairing codes for that approver.')
  expect(prompt.confirm).toHaveBeenCalledTimes(2)
  expect(printed).toEqual([HEADING, 'b'])
})

test('prints no list when nobody paired', async () => {
  const { provider } = createProvider()
  const printed: string[] = []
  const running = runPairApprover(
    {},
    createDeps(provider, printed, { prompt: createConfirms(false) }),
  )
  await blockWhenShown(provider.runtimes, 'ABCDEFGH')
  expect(await running).toBe(0)
  expect(printed).toEqual([])
})

test('an interrupt while waiting prints those paired so far and returns 130', async () => {
  const { provider, stop } = createProvider()
  const printed: string[] = []
  const controller = new AbortController()
  const running = runPairApprover(
    {},
    createDeps(provider, printed, { prompt: createConfirms(true), signal: controller.signal }),
  )
  await pairWhenShown(provider.runtimes, 'ABCDEFGH', 'a')
  await vi.waitFor(() => expect(recording.notes()).toContain('Pairing code: JKLM-NPQR'))
  controller.abort()
  expect(await running).toBe(130)
  expect(printed).toEqual([HEADING, 'a'])
  expect(recording.events).toContain('cancel:Waiting for an approver to pair')
  expect(stop).toHaveBeenCalledTimes(1)
})

test('an interrupted prompt prints those paired so far and returns 130', async () => {
  const { provider, stop } = createProvider()
  const printed: string[] = []
  const prompt = createPrompts()
  vi.mocked(prompt.confirm).mockRejectedValue(new PromptAborted())
  const running = runPairApprover({}, createDeps(provider, printed, { prompt }))
  await pairWhenShown(provider.runtimes, 'ABCDEFGH', 'a')
  expect(await running).toBe(130)
  expect(printed).toEqual([HEADING, 'a'])
  expect(recording.notes().at(-1)).toBe('')
  expect(stop).toHaveBeenCalledTimes(1)
})

test('a provider failure while waiting prints those paired so far and the reason, secrets masked', async () => {
  const { provider, stop } = createProvider()
  const printed: string[] = []
  const prompt = createConfirms(true)
  vi.mocked(prompt.password).mockResolvedValue('secret-key')
  const running = runPairApprover({}, createDeps(provider, printed, { prompt }))
  await pairWhenShown(provider.runtimes, 'ABCDEFGH', 'a')
  await vi.waitFor(() => expect(recording.notes()).toContain('Pairing code: JKLM-NPQR'))
  provider.runtimes[0]?.handlers?.fatal('Fake went away, key secret-key')
  expect(await running).toBe(1)
  expect(printed).toEqual([HEADING, 'a'])
  expect(recording.notes().at(-1)).toBe('Setup failed: Fake went away, key ***')
  expect(recording.events).toContain('fail:Waiting for an approver to pair')
  expect(stop).toHaveBeenCalledTimes(1)
})

test('rejected credentials exit 1 with the reason', async () => {
  const { provider, stop } = createProvider({
    runtime: { checkCredentials: async () => ({ ok: false, reason: 'Fake said no' }) },
  })
  const printed: string[] = []
  expect(await runPairApprover({}, createDeps(provider, printed))).toBe(1)
  expect(recording.notes()).toContain('Setup failed: Fake said no')
  expect(provider.runtimes[0]?.handlers).toBeUndefined()
  expect(stop).toHaveBeenCalledTimes(1)
})

test('an unknown provider exits 1', async () => {
  const { provider } = createProvider()
  const printed: string[] = []
  expect(await runPairApprover({ provider: 'nope' }, createDeps(provider, printed))).toBe(1)
  expect(recording.notes()).toEqual(['Unknown provider "nope".'])
  expect(printed).toEqual([])
  expect(provider.runtimes).toEqual([])
})

test('a provider without pairing exits 1', async () => {
  const provider = createFakeProvider()
  const printed: string[] = []
  expect(await runPairApprover({}, createDeps(provider, printed))).toBe(1)
  expect(recording.notes()).toContain(
    `Setup failed: ${provider.label} has no pairing, so it has no approvers to pair`,
  )
  expect(provider.runtimes[0]?.handlers).toBeUndefined()
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
      checkCredentials: async () => ACCEPTED,
    },
  })
  const printed: string[] = []
  const running = runPairApprover(
    {},
    createDeps(provider, printed, { prompt: createConfirms(true, false) }),
  )
  await pairWhenShown(provider.runtimes, 'ABCDEFGH', 'a')
  await pairWhenShown(provider.runtimes, 'JKLMNPQR', 'b')
  expect(await running).toBe(0)
  expect(provider.runtimes).toHaveLength(1)
  expect(starts).toBe(1)
  expect(stop).toHaveBeenCalledTimes(1)
})
