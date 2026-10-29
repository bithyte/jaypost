import {
  ADMIN_TOO_OLD_MESSAGE,
  describeUnauthorized,
  findEnvEndpoint,
  toLocalEndpoint,
} from '@jaypost/client'
import { findExistingInstall, resolveRecordProvider } from '@jaypost/install'
import type { InstallRecord, Target } from '@jaypost/install'
import { findOwnerSetting, requireProvider } from '@jaypost/core'
import type { Provider } from '@jaypost/core'
import { resolveClientToken } from '@jaypost/store'
import type { ClientToken } from '@jaypost/store'
import { runStep } from '../progress/index.ts'
import { openAdmin } from './admin-access.ts'
import { POLL_INTERVAL_MS, START_POLL_COUNT } from './constants.ts'
import { createAbortableSleep } from './pairing-wait.ts'
import { PromptAborted } from './prompts.ts'
import type { ResetOwnerDeps, StatusFetch, WaitResult } from './types.ts'

/** How clearing the owner ended; `failed` carries the note to print, already worded. */
type ResetOutcome =
  | { readonly kind: 'reset' }
  | { readonly kind: 'failed'; readonly message: string }

/** The pairing /status named for the token, with its key when the service said. */
type PairingLookup =
  | { readonly kind: 'found'; readonly pairingId: string; readonly keyId: string | undefined }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * Key 1's token for reset-owner: the token file init wrote, else `JAYPOST_TOKEN`, so a shell set
 * up for another key doesn't pick the pairing. Never throws.
 */
export function resolveResetOwnerToken(env: NodeJS.ProcessEnv, tokenFile: string): ClientToken {
  const fromFile = resolveClientToken({}, tokenFile)
  return fromFile.kind === 'none' ? resolveClientToken(env, tokenFile) : fromFile
}

/**
 * Unlinks the paired owner without a restart: reads /status with key 1's token to learn its
 * pairing (and names it in the prompt), resets that pairing through the admin route, drops the
 * owner from the install's seed inputs and waits for a new pairing. A stopped service is restarted
 * after the prompt. Refuses while `JAYPOST_URL` is set: it only works on this machine's install.
 * Returns 0 on success or if the user declines, 1 on failure, not installed, `JAYPOST_URL` set or
 * a provider that doesn't pair, 130 on interrupt.
 */
export async function runResetOwner(deps: ResetOwnerDeps): Promise<number> {
  const print = deps.progress.note
  if (findEnvEndpoint(deps.env) !== undefined) {
    print(
      "JAYPOST_URL is set, but reset-owner only works on this machine's install. Unset it and run reset-owner again.",
    )
    return 1
  }
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
    const isRunning = await target.isRunning(record)
    const known = isRunning ? await findPairing(deps, target, record, token) : undefined
    if (known?.kind === 'failed') {
      print(known.message)
      return 1
    }
    if (!(await deps.confirm(formatConfirm(warning, known), false))) {
      return 0
    }
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
      () => resetOwnerPairing(deps, target, record, token, known),
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
      url: toLocalEndpoint(record.port).url,
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

/** The provider's warning, naming the pairing and key when /status was read before the prompt. */
function formatConfirm(
  warning: string,
  known: Extract<PairingLookup, { readonly kind: 'found' }> | undefined,
): string {
  if (known === undefined) {
    return `${warning} Continue?`
  }
  const key = known.keyId === undefined ? '' : ` (key ${known.keyId})`
  return `${warning} It resets pairing ${known.pairingId}${key}. Continue?`
}

/** Asks /status which pairing `token` belongs to. Throws only when interrupted. */
async function findPairing(
  deps: ResetOwnerDeps,
  target: Target,
  record: InstallRecord,
  token: string | undefined,
): Promise<PairingLookup> {
  const fetched = await fetchStartedStatus(deps, record.port, token)
  switch (fetched.kind) {
    case 'unreachable':
      return { kind: 'failed', message: `The service didn't answer. ${target.logsHint(record)}` }
    case 'unauthorized':
      return { kind: 'failed', message: describeUnauthorized(token !== undefined) }
    case 'answered':
      break
  }
  const { pairing, key } = fetched.status
  // A service from before pairings has no admin routes either.
  return pairing === undefined
    ? { kind: 'failed', message: ADMIN_TOO_OLD_MESSAGE }
    : { kind: 'found', pairingId: pairing, keyId: key }
}

/**
 * Resets the pairing (`known`, or the one /status names now) through `openAdmin`, then
 * drops the owner from the install's seed inputs so a later re-seed can't pair them again. Throws
 * when interrupted or when the seed inputs can't be written.
 */
async function resetOwnerPairing(
  deps: ResetOwnerDeps,
  target: Target,
  record: InstallRecord,
  token: string | undefined,
  known: PairingLookup | undefined,
): Promise<ResetOutcome> {
  const found = known ?? (await findPairing(deps, target, record, token))
  if (found.kind === 'failed') {
    return found
  }
  // Opened only now: a service restarted a moment ago may have just written its admin key.
  const opened = await openAdmin(deps)
  if (opened.kind !== 'opened') {
    return { kind: 'failed', message: opened.message }
  }
  const reset = await opened.caller.resetPairing(found.pairingId)
  if (reset.kind === 'failed') {
    return { kind: 'failed', message: reset.message }
  }
  await target.forgetSeedOwner(record)
  return { kind: 'reset' }
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
    const fetched = await deps.fetchStatus(toLocalEndpoint(port).url, token)
    if (deps.signal?.aborted) {
      throw new Error('interrupted')
    }
    if (fetched.kind !== 'unreachable' || attempt >= START_POLL_COUNT) {
      return fetched
    }
    await sleep(POLL_INTERVAL_MS)
  }
}
