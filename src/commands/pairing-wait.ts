import { setTimeout as delay } from 'node:timers/promises'
import { NO_CLIENT_TOKEN } from '../auth/index.ts'
import { Caller, toLocalEndpoint } from '../client/index.ts'
import {
  DEFAULT_START_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  STATUS_TIMEOUT_MS,
  UNAUTHORIZED_STATUS,
  UNREACHABLE_STATUS,
} from './constants.ts'
import { formatPairingText } from './pairing-text.ts'
import type { StatusFetch, WaitOptions, WaitResult } from './types.ts'

/**
 * GETs the local /status, sending the bearer token when given. A 401 is `unauthorized`; any other
 * failure or unexpected body is `unreachable` (typically the service isn't up yet). Never throws.
 */
export async function defaultFetchStatus(port: number, token?: string): Promise<StatusFetch> {
  const caller = new Caller({
    endpoint: toLocalEndpoint(port),
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
 * Polls /status, printing the pairing code once. Start timeout only applies until the service first
 * answers; ends as paired, interrupted, stopped (not running), notStarted or unauthorized (the
 * service rejected the token).
 */
export async function waitForPairing(options: WaitOptions): Promise<WaitResult> {
  const print = options.print ?? ((text: string) => console.log(text))
  const fetchStatus = options.fetchStatus ?? defaultFetchStatus
  const sleep = options.sleep ?? createAbortableSleep(options.signal)
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
  const began = Date.now()
  let answered = false
  let shown = false
  for (;;) {
    if (options.signal?.aborted) {
      print(
        'Service is still running and waiting for pairing. Run "jaypost status" to see the code again.',
      )
      return 'interrupted'
    }
    const fetched = await fetchStatus(options.port, options.token)
    if (fetched.kind === 'unauthorized') {
      return 'unauthorized'
    }
    if (fetched.kind === 'answered') {
      answered = true
      if (fetched.status.paired) {
        return 'paired'
      }
      if (!shown) {
        shown = true
        print(formatPairingText(fetched.status))
      }
    } else if (!answered && Date.now() - began >= startTimeoutMs) {
      return 'notStarted'
    }
    if (!(await options.isRunning())) {
      print(`The service stopped. ${options.logsHint}`)
      return 'stopped'
    }
    await sleep(POLL_INTERVAL_MS)
  }
}
