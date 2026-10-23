import { MODE_ENV_VAR, PROVIDER_ENV_VAR } from '../config/index.ts'
import { DIRECT_MODE } from '../direct/index.ts'
import { formatCode, generateCode, Pairing } from '../pairing/index.ts'
import { runStep } from '../progress/index.ts'
import type { ProgressStep } from '../progress/index.ts'
import { findOwnerSetting, findProvider } from '../provider/index.ts'
import type { Provider, ProviderRuntime, SettingValues } from '../provider/index.ts'
import { BLOCKED_PAIRING, INTERRUPTED_PAIRING, SETUP_CI_SECRETS_HINT } from './constants.ts'
import { PromptAborted } from './prompts.ts'
import { redact, resolveProviderSettings, selectProvider } from './provider-setup.ts'
import type { OwnerPairing, SetupCiArgs, SetupCiDeps } from './types.ts'

/**
 * Asks for the provider and its settings, pairs the owner against an in-process bot, prints the
 * `JAYPOST_*` env vars for direct mode, then pairs as many approvers as asked for and prints their
 * `-u` flags. `approversOnly` skips the owner and the env vars. Writes no files. Returns 0 once
 * done, 1 on failure, 130 on interrupt (after printing what paired so far); error text is shown
 * with known secrets masked.
 */
export async function runSetupCi(args: SetupCiArgs, deps: SetupCiDeps): Promise<number> {
  // Every secret value setup-ci has seen, so error messages can be shown with them masked.
  const seen: string[] = []
  try {
    return await runSetupCiInner(args, deps, seen)
  } catch (error) {
    if (error instanceof PromptAborted || deps.signal?.aborted) {
      deps.progress.note('')
      return 130
    }
    const message = error instanceof Error ? error.message : String(error)
    deps.progress.note(`Setup failed: ${redact(message, seen)}`)
    return 1
  }
}

async function runSetupCiInner(
  args: SetupCiArgs,
  deps: SetupCiDeps,
  seen: string[],
): Promise<number> {
  const { print } = deps
  const note = deps.progress.note
  const provider = await chooseProvider(args, deps)
  if (provider === undefined) {
    note(`Unknown provider "${args.provider}".`)
    return 1
  }
  const resolved = await resolveProviderSettings({
    provider,
    saved: {},
    prompt: deps.prompt,
    print: note,
    ...(deps.signal ? { signal: deps.signal } : {}),
    seen,
  })
  if (resolved.kind === 'rejected') {
    return 1
  }
  const { settings } = resolved
  const runtime = provider.createRuntime(settings, deps.log ?? ((line) => console.error(line)))
  try {
    const check = await runtime.checkCredentials()
    if (!check.ok) {
      note(`Setup failed: ${check.reason}`)
      return 1
    }
    deps.progress.done(
      check.displayName === undefined
        ? 'Bot token checked'
        : `Bot token checked (${check.displayName})`,
    )
    const ownerSetting = findOwnerSetting(provider)
    if (args.approversOnly === true && ownerSetting === undefined) {
      note(`Setup failed: ${provider.label} has no pairing, so it has no approvers to pair`)
      return 1
    }
    const waitFor = createPairingWaiter(runtime, deps)
    if (args.approversOnly !== true && ownerSetting !== undefined) {
      const outcome = await waitFor(describeOwnerPairing(provider, runtime), OWNER_STEP_TITLES)
      switch (outcome.kind) {
        case 'interrupted':
          note('')
          return 130
        case 'blocked':
          note('Too many wrong pairing codes. Run jaypost setup-ci again.')
          return 1
        case 'fatal':
          note(`Setup failed: ${redact(outcome.message, seen)}`)
          return 1
        case 'paired': {
          const owner = ownerSetting.parse(outcome.senderId)
          if (owner === undefined) {
            note(`Setup failed: ${provider.label} sent an owner id jaypost can't use`)
            return 1
          }
          printEnvBlock(provider, { ...settings, [ownerSetting.configKey]: owner }, print)
        }
      }
    } else if (ownerSetting === undefined) {
      printEnvBlock(provider, settings, print)
      return 0
    }
    return await pairApprovers(runtime, waitFor, deps, seen)
  } finally {
    await stopRuntime(runtime)
  }
}

function printEnvBlock(
  provider: Provider,
  paired: SettingValues,
  print: (text: string) => void,
): void {
  print('')
  print(SETUP_CI_SECRETS_HINT)
  print(`${MODE_ENV_VAR}=${DIRECT_MODE.kind}`)
  print(`${PROVIDER_ENV_VAR}=${provider.name}`)
  for (const setting of provider.settings) {
    const value = paired[setting.configKey]
    if (value !== undefined) {
      print(`${setting.envVar}=${String(value)}`)
    }
  }
}

const OWNER_STEP_TITLES = {
  waiting: 'Waiting for the owner to pair',
  paired: 'Owner paired',
}
const APPROVER_STEP_TITLES = {
  waiting: 'Waiting for an approver to pair',
  paired: 'Approver paired',
}

/** Asks "Pair an approver?" until the answer is no, printing each one that pairs. */
async function pairApprovers(
  runtime: ProviderRuntime,
  waitFor: PairingWaiter,
  deps: SetupCiDeps,
  seen: string[],
): Promise<number> {
  const { print } = deps
  const note = deps.progress.note
  const approvers: string[] = []
  const instructions = runtime.approverPairingInstructions ?? runtime.pairingInstructions
  if (instructions === undefined) {
    throw new Error('provider has no pairing support')
  }
  for (;;) {
    let wanted: boolean
    try {
      wanted = !deps.signal?.aborted && (await deps.prompt.confirm('Pair an approver?', false))
    } catch (error) {
      if (!(error instanceof PromptAborted)) {
        throw error
      }
      return interruptApprovers(approvers, deps)
    }
    if (deps.signal?.aborted) {
      return interruptApprovers(approvers, deps)
    }
    if (!wanted) {
      break
    }
    const outcome = await waitFor(instructions, APPROVER_STEP_TITLES)
    switch (outcome.kind) {
      case 'interrupted':
        return interruptApprovers(approvers, deps)
      case 'fatal':
        printApprovers(approvers, print)
        note(`Setup failed: ${redact(outcome.message, seen)}`)
        return 1
      case 'blocked':
        note('Too many wrong pairing codes for that approver.')
        break
      case 'paired':
        approvers.push(outcome.senderId)
        note(`Approver paired: ${outcome.senderId}`)
    }
  }
  printApprovers(approvers, print)
  return 0
}

function interruptApprovers(approvers: readonly string[], deps: SetupCiDeps): number {
  deps.progress.note('')
  printApprovers(approvers, deps.print)
  return 130
}

function printApprovers(approvers: readonly string[], print: (text: string) => void): void {
  if (approvers.length === 0) {
    return
  }
  print('Approvers (pass to send request):')
  print(approvers.map((id) => `-u ${id}`).join(' '))
}

/**
 * The provider from `--provider`, the only registered one, or the user's pick (defaulting to the
 * first). Undefined when `--provider` names an unregistered one.
 */
async function chooseProvider(args: SetupCiArgs, deps: SetupCiDeps): Promise<Provider | undefined> {
  if (args.provider !== undefined) {
    return findProvider(deps.providers, args.provider)
  }
  return selectProvider(deps.providers, deps.prompt.select, undefined)
}

type PairingWaiter = (
  instructions: (code: string) => string,
  titles: { readonly waiting: string; readonly paired: string },
) => Promise<OwnerPairing>

function describeOwnerPairing(
  provider: Provider,
  runtime: ProviderRuntime,
): (code: string) => string {
  if (runtime.pairingInstructions === undefined) {
    throw new Error(
      `provider ${JSON.stringify(provider.name)} has an owner setting but no pairing support`,
    )
  }
  return runtime.pairingInstructions
}

/**
 * Starts the runtime once, with handlers that only pair, and returns a function that shows a
 * fresh pairing code and waits until someone pairs, someone is blocked, the provider fails or
 * `deps.signal` aborts. Each wait gets its own `Pairing`, so wrong-guess counts reset. A provider
 * failure between waits is kept and ends the next one.
 */
function createPairingWaiter(runtime: ProviderRuntime, deps: SetupCiDeps): PairingWaiter {
  const { signal } = deps
  let current:
    | { readonly pairing: Pairing; readonly settle: (outcome: OwnerPairing) => void }
    | undefined
  let failure: OwnerPairing | undefined
  let started = false
  const start = (): void => {
    started = true
    runtime.start({
      answer: () => 'expired',
      reply: () => 'expired',
      dismiss: () => false,
      pair: (senderId, text) => {
        if (current === undefined) {
          return 'notPairing'
        }
        const result = current.pairing.attempt(senderId, text)
        if (result === 'paired') {
          current.settle({ kind: 'paired', senderId })
        } else if (result === 'blocked') {
          current.settle(BLOCKED_PAIRING)
        }
        return result
      },
      commands: [],
      command: () => undefined,
      fatal: (message) => {
        failure = { kind: 'fatal', message }
        current?.settle(failure)
      },
    })
  }
  const waitForOutcome = async (pairing: Pairing): Promise<OwnerPairing> => {
    let onAbort: (() => void) | undefined
    try {
      return await new Promise<OwnerPairing>((resolve) => {
        current = { pairing, settle: resolve }
        onAbort = () => resolve(INTERRUPTED_PAIRING)
        signal?.addEventListener('abort', onAbort, { once: true })
        if (!started) {
          start()
        }
      })
    } finally {
      current = undefined
      if (onAbort !== undefined) {
        signal?.removeEventListener('abort', onAbort)
      }
    }
  }
  return async (instructions, titles) => {
    if (signal?.aborted) {
      return INTERRUPTED_PAIRING
    }
    if (failure !== undefined) {
      return failure
    }
    const code = (deps.generateCode ?? generateCode)()
    const instructionText = instructions(code)
    return runStep(
      deps.progress,
      titles.waiting,
      () => {
        // A note, not a step detail: it must print in plain mode and keep long URLs whole.
        deps.progress.note(`Pairing code: ${formatCode(code)}`)
        deps.progress.note(instructionText)
        return waitForOutcome(new Pairing(code))
      },
      { settle: (step, outcome) => settleStep(step, outcome, titles.paired) },
    )
  }
}

/** Ends the pairing step to match how the wait ended. */
function settleStep(step: ProgressStep, outcome: OwnerPairing, pairedTitle: string): void {
  switch (outcome.kind) {
    case 'paired':
      step.succeed(pairedTitle)
      return
    case 'interrupted':
      step.cancel()
      return
    case 'blocked':
    case 'fatal':
      step.fail()
  }
}

async function stopRuntime(runtime: ProviderRuntime): Promise<void> {
  try {
    await runtime.stop()
  } catch {
    // Stopping is best effort, and the error could carry provider details we don't want shown.
  }
}
