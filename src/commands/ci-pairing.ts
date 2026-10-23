import { formatCode, generateCode, Pairing } from '../pairing/index.ts'
import { runStep } from '../progress/index.ts'
import type { ProgressStep } from '../progress/index.ts'
import { findProvider } from '../provider/index.ts'
import type { CredentialCheck, Provider, ProviderRuntime } from '../provider/index.ts'
import { BLOCKED_PAIRING, INTERRUPTED_PAIRING } from './constants.ts'
import { PromptAborted } from './prompts.ts'
import { redact, resolveProviderSettings, selectProvider } from './provider-setup.ts'
import type { OpenedRuntime, OwnerPairing, PairingWaiter, SetupCiDeps } from './types.ts'

/**
 * Runs `run` with a fresh list for every secret value seen, so error text can be shown with them
 * masked. An interrupt (a `PromptAborted` or an aborted `deps.signal`) notes an empty line and
 * returns 130; any other error notes `Setup failed: <message>` and returns 1.
 */
export async function runCiPairing(
  deps: SetupCiDeps,
  run: (seen: string[]) => Promise<number>,
): Promise<number> {
  const seen: string[] = []
  try {
    return await run(seen)
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

/**
 * Picks the provider (`providerName`, the only registered one, or the user's pick), asks for its
 * settings, creates the runtime and checks its credentials. Returns `failed` after noting why;
 * otherwise the caller owns the runtime and must stop it.
 */
export async function openPairingRuntime(
  providerName: string | undefined,
  deps: SetupCiDeps,
  seen: string[],
): Promise<OpenedRuntime> {
  const note = deps.progress.note
  const provider = await chooseProvider(providerName, deps)
  if (provider === undefined) {
    note(`Unknown provider "${providerName}".`)
    return { kind: 'failed' }
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
    return { kind: 'failed' }
  }
  const { settings } = resolved
  const runtime = provider.createRuntime(settings, deps.log ?? ((line) => console.error(line)))
  let check: CredentialCheck
  try {
    check = await runtime.checkCredentials()
  } catch (error) {
    await stopRuntime(runtime)
    throw error
  }
  if (!check.ok) {
    note(`Setup failed: ${check.reason}`)
    await stopRuntime(runtime)
    return { kind: 'failed' }
  }
  deps.progress.done(
    check.displayName === undefined
      ? 'Bot token checked'
      : `Bot token checked (${check.displayName})`,
  )
  return { kind: 'opened', provider, settings, runtime }
}

/**
 * Starts the runtime once, with handlers that only pair, and returns a function that shows a
 * fresh pairing code and waits until someone pairs, someone is blocked, the provider fails or
 * `deps.signal` aborts. Each wait gets its own `Pairing`, so wrong-guess counts reset. A provider
 * failure between waits is kept and ends the next one.
 */
export function createPairingWaiter(runtime: ProviderRuntime, deps: SetupCiDeps): PairingWaiter {
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

/** Stops the runtime, ignoring any error. */
export async function stopRuntime(runtime: ProviderRuntime): Promise<void> {
  try {
    await runtime.stop()
  } catch {
    // Stopping is best effort, and the error could carry provider details we don't want shown.
  }
}

/**
 * The provider named by `providerName`, the only registered one, or the user's pick (defaulting
 * to the first). Undefined when `providerName` names an unregistered one.
 */
async function chooseProvider(
  providerName: string | undefined,
  deps: SetupCiDeps,
): Promise<Provider | undefined> {
  if (providerName !== undefined) {
    return findProvider(deps.providers, providerName)
  }
  return selectProvider(deps.providers, deps.prompt.select, undefined)
}
