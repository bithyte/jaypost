import { setTimeout as delay } from 'node:timers/promises'
import { NO_CLIENT_TOKEN } from '../auth/index.ts'
import { Caller } from '../client/index.ts'
import {
  DEFAULT_START_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  STATUS_TIMEOUT_MS,
  UNAUTHORIZED_STATUS,
  UNREACHABLE_STATUS,
} from './constants.ts'
import { formatPairingText } from './pairing-text.ts'
import type { ProgressStep } from '../progress/index.ts'
import type { StatusFetch, WaitOptions, WaitResult } from './types.ts'

/**
 * GETs the local /status, sending the bearer token when given. A 401 is `unauthorized`; any other
 * failure or unexpected body is `unreachable` (typically the service isn't up yet). Never throws.
 */
export async function defaultFetchStatus(port: number, token?: string): Promise<StatusFetch> {
  const caller = new Caller({
    port,
    readToken: () =>
      token === undefined ? NO_CLIENT_TOKEN : { kind: 'token', token, source: 'file' },
  })
  const result = await caller.status({
    signal: new AbortController().signal,
    timeoutMs: STATUS_TIMEOUT_MS,
  })
  if (result.kind === 'status') {
    return { kind: 'answered', status: result.status }
  }
  return result.reason === 'unauthorized' ? UNAUTHORIZED_STATUS : UNREACHABLE_STATUS
}

function createAbortableSleep(signal?: AbortSignal): (delayMs: number) => Promise<void> {
  // Rejects on abort; the loop checks the signal right after.
  return (delayMs) => delay(delayMs, undefined, { signal }).catch(() => {})
}

/**
 * Polls /status, showing the service start and then the pairing code as checklist steps. Start
 * timeout only applies until the service first answers; ends as paired, interrupted, stopped (not
 * running), notStarted or unauthorized (the service rejected the token). A throw from `isRunning`
 * fails the running step first, so the terminal is never left on a live step.
 */
export async function waitForPairing(options: WaitOptions): Promise<WaitResult> {
  const { progress } = options
  const startStep = progress.start('Waiting for the service to start')
  // The running step; every exit path ends it.
  let step: ProgressStep = startStep
  try {
    return await pollPairing(options, {
      current: () => step,
      replace: (next) => {
        step = next
      },
    })
  } catch (error) {
    step.fail()
    throw error
  }
}

type StepHolder = {
  readonly current: () => ProgressStep
  readonly replace: (step: ProgressStep) => void
}

async function pollPairing(options: WaitOptions, holder: StepHolder): Promise<WaitResult> {
  const { progress } = options
  const fetchStatus = options.fetchStatus ?? defaultFetchStatus
  const sleep = options.sleep ?? createAbortableSleep(options.signal)
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
  const began = Date.now()
  let answered = false
  let shown = false
  for (;;) {
    if (options.signal?.aborted) {
      holder.current().cancel()
      progress.note(
        'Service is still running and waiting for pairing. Run "jaypost status" to see the code again.',
      )
      return 'interrupted'
    }
    const fetched = await fetchStatus(options.port, options.token)
    if (fetched.kind === 'unauthorized') {
      holder.current().fail()
      return 'unauthorized'
    }
    if (fetched.kind === 'answered') {
      if (!answered) {
        answered = true
        holder.current().succeed('Service is up')
        if (fetched.status.paired) {
          return 'paired'
        }
        holder.replace(progress.start('Waiting for pairing'))
      }
      if (fetched.status.paired) {
        holder.current().succeed('Paired')
        return 'paired'
      }
      if (!shown) {
        shown = true
        // A note, not a step detail: it must print in plain mode and keep long URLs whole.
        progress.note(formatPairingText(fetched.status))
      }
    } else if (!answered && Date.now() - began >= startTimeoutMs) {
      holder.current().fail()
      return 'notStarted'
    }
    if (!(await options.isRunning())) {
      holder.current().fail()
      progress.note(`The service stopped. ${options.logsHint}`)
      return 'stopped'
    }
    await sleep(POLL_INTERVAL_MS)
  }
}
