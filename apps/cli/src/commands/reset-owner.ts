import {
  AdminCaller,
  ADMIN_TOO_OLD_MESSAGE,
  describeUnauthorized,
  toLocalEndpoint,
} from '@jaypost/client'
import { findExistingInstall, resolveRecordProvider } from '@jaypost/install'
import type { InstallRecord, Target } from '@jaypost/install'
import { findOwnerSetting, requireProvider } from '@jaypost/core'
import type { Provider } from '@jaypost/core'
import { runStep } from '../progress/index.ts'
import { POLL_INTERVAL_MS, START_POLL_COUNT } from './constants.ts'
import { createAbortableSleep } from './pairing-wait.ts'
import { PromptAborted } from './prompts.ts'
import type { ResetOwnerDeps, StatusFetch, WaitResult } from './types.ts'

/** How clearing the owner ended; `failed` carries the note to print, already worded. */
type ResetOutcome =
  | { readonly kind: 'reset' }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * Unlinks the paired owner without a restart: reads /status with key 1's token to learn its
 * pairing, resets that pairing through the admin route and waits for a new pairing. A stopped
 * service is restarted first. Returns 0 on success or if the user declines, 1 on failure, not
 * installed or a provider that doesn't pair, 130 on interrupt.
 */
export async function runResetOwner(deps: ResetOwnerDeps): Promise<number> {
  const print = deps.progress.note
  const existing = findExistingInstall(deps.paths, deps.targets)
  if (!existing) {
    print('Not installed. Run "jaypost init".')
    return 1
  }
  const { record } = existing
  if (deps.token.kind === 'unusable') {
    print(deps.token.message)
    return 1
  }
  const target = deps.targets[record.target]
  let provider: Provider
  try {
    provider = requireProvider(deps.providers, resolveRecordProvider(record))
  } catch (error) {
    print(error instanceof Error ? error.message : String(error))
    return 1
  }
  const warning = provider.setup.text.resetOwnerWarning
  if (findOwnerSetting(provider) === undefined || warning === undefined) {
    print(`${provider.label} doesn't support re-pairing.`)
    return 1
  }
  const token = deps.token.kind === 'token' ? deps.token.token : undefined
  const stepOptions = deps.signal ? { signal: deps.signal } : {}
  let outcome: ResetOutcome
  try {
    if (!(await deps.confirm(`${warning} Continue?`, false))) {
      return 0
    }
    const isRunning = await target.isRunning(record)
    deps.progress.plan([
      ...(isRunning ? [] : ['Restarting the service']),
      'Clearing the owner',
      'Waiting for the service to start',
      'Waiting for pairing',
    ])
    if (!isRunning) {
      await runStep(deps.progress, 'Restarting the service', () => target.restart(record), {
        ...stepOptions,
        settle: (step) => step.succeed('Restarted the service'),
      })
    }
    outcome = await runStep(
      deps.progress,
      'Clearing the owner',
      () => resetSeedPairing(deps, target, record, token),
      {
        ...stepOptions,
        settle: (step, value) =>
          value.kind === 'reset' ? step.succeed('Cleared the owner') : step.fail(),
      },
    )
  } catch (error) {
    if (error instanceof PromptAborted || deps.signal?.aborted) {
      print('')
      return 130
    }
    print(`Reset failed. ${target.logsHint(record)}`)
    return 1
  }
  if (outcome.kind === 'failed') {
    print(outcome.message)
    return 1
  }
  let result: WaitResult
  try {
    result = await deps.wait({
      port: record.port,
      isRunning: () => target.isRunning(record),
      logsHint: target.logsHint(record),
      ...(token === undefined ? {} : { token }),
      ...(deps.signal ? { signal: deps.signal } : {}),
      progress: deps.progress,
    })
  } catch {
    if (deps.signal?.aborted) {
      print('')
      return 130
    }
    print(`Waiting for pairing failed. ${target.logsHint(record)}`)
    return 1
  }
  if (result === 'paired') {
    print('Paired. Try it: jaypost ping')
    return 0
  }
  if (result === 'interrupted') {
    return 130
  }
  if (result === 'unauthorized') {
    print(describeUnauthorized(deps.token.kind === 'token'))
    return 1
  }
  print(target.logsHint(record))
  return 1
}

/**
 * Asks /status which pairing `token` belongs to and resets it with the install's admin key.
 * Throws only when interrupted.
 */
async function resetSeedPairing(
  deps: ResetOwnerDeps,
  target: Target,
  record: InstallRecord,
  token: string | undefined,
): Promise<ResetOutcome> {
  const fetched = await fetchStartedStatus(deps, record.port, token)
  switch (fetched.kind) {
    case 'unreachable':
      return { kind: 'failed', message: `Reset failed. ${target.logsHint(record)}` }
    case 'unauthorized':
      return { kind: 'failed', message: describeUnauthorized(token !== undefined) }
    case 'answered':
      break
  }
  const pairingId = fetched.status.pairing
  // A service from before pairings has no admin routes either.
  if (pairingId === undefined) {
    return { kind: 'failed', message: ADMIN_TOO_OLD_MESSAGE }
  }
  let adminKey: string
  try {
    adminKey = await target.readAdminKey(record)
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
  const caller = new AdminCaller({ endpoint: toLocalEndpoint(record.port), adminKey })
  const reset = await caller.resetPairing(pairingId)
  return reset.kind === 'failed' ? { kind: 'failed', message: reset.message } : { kind: 'reset' }
}

/**
 * Polls /status until the service answers or the start timeout passes; throws once `signal`
 * aborts, so the step is cancelled.
 */
async function fetchStartedStatus(
  deps: ResetOwnerDeps,
  port: number,
  token: string | undefined,
): Promise<StatusFetch> {
  const sleep = deps.sleep ?? createAbortableSleep(deps.signal)
  for (let attempt = 1; ; attempt += 1) {
    const fetched = await deps.fetchStatus(port, token)
    if (deps.signal?.aborted) {
      throw new Error('interrupted')
    }
    if (fetched.kind !== 'unreachable' || attempt >= START_POLL_COUNT) {
      return fetched
    }
    await sleep(POLL_INTERVAL_MS)
  }
}
