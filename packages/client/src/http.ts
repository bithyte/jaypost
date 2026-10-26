import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS } from '@jaypost/core'
import {
  ATTACHMENT_GRACE_MS,
  ATTACHMENT_NOT_SUPPORTED_MESSAGE,
  BACKGROUND_TOO_OLD_MESSAGE,
  CANCELLED_MESSAGE,
  FETCH_GRACE_MS,
  LEGACY_MAX_TIMEOUT_SECONDS,
  LOG_TOO_OLD_MESSAGE,
  MAX_TIMER_MS,
  NOT_PAIRED_MESSAGE,
  NOT_SUPPORTED_MESSAGE,
  RETRY_TOO_OLD_MESSAGE,
  SEND_FAILED_MESSAGE,
  TOKEN_REJECTED_MESSAGE,
  TIMEOUT_TOO_OLD_MESSAGE,
  TOKEN_REQUIRED_MESSAGE,
  TOO_OLD_MESSAGE,
  VOTE_TOO_OLD_MESSAGE,
} from './constants.ts'
import { voteReportSchema } from '@jaypost/protocol'
import { describeEndpoint, isLoopbackEndpoint, resolveApiUrl } from './endpoint.ts'
import type {
  ApiMethod,
  ApiOptions,
  ApiPath,
  ApiResult,
  AskBody,
  AskOptions,
  AskResult,
  Failure,
  LogFilter,
  RawApiResult,
  RawResponse,
  StateBody,
  VoteBody,
  VoteOutcome,
} from './types.ts'

/** POSTs JSON to the service; see `callApi`. */
export function postApi(
  endpoint: URL,
  path: ApiPath,
  body: object,
  options: ApiOptions,
): Promise<ApiResult> {
  return callApi(endpoint, 'POST', path, body, options)
}

/**
 * Calls the service at `endpoint` (its path prefixes `path`) with JSON (no body when `body` is undefined). 200 and 202 are ok. Never
 * throws; no retries. Uses node:http rather than fetch, whose 300 s headers timeout would cut off
 * a request that waits the full approval timeout.
 */
export async function callApi(
  endpoint: URL,
  method: ApiMethod,
  path: ApiPath,
  body: object | undefined,
  options: ApiOptions,
): Promise<ApiResult> {
  const response = await fetchApi(endpoint, method, path, body, options)
  if (response.kind === 'failed') {
    return response
  }
  if (response.status === 200 || response.status === 202) {
    return parseOk(response.text)
  }
  return toStatusFailure(response.status, path, response.text, options.token !== undefined)
}

/**
 * Sends one call and returns the status and body text as they came; only a transport problem
 * (unreachable, timeout, abort) is a failure. Never throws; no retries.
 */
export async function fetchApi(
  endpoint: URL,
  method: ApiMethod,
  path: ApiPath,
  body: object | undefined,
  options: ApiOptions,
): Promise<RawApiResult> {
  const timeout = AbortSignal.timeout(Math.ceil(options.timeoutMs))
  const signal = AbortSignal.any([options.signal, timeout])
  try {
    const response = await send(
      resolveApiUrl(endpoint, path),
      method,
      body === undefined ? undefined : JSON.stringify(body),
      signal,
      options.token,
    )
    return { kind: 'response', ...response }
  } catch {
    return toTransportFailure(endpoint, options, timeout)
  }
}

const KEEPALIVE_MS = 60_000

/**
 * HTTP timeout for a /request or /vote call: the capped approval timeout for every round plus a
 * grace period, and more when the call uploads an attachment, at most `MAX_TIMER_MS`.
 */
function toFetchTimeoutMs(body: AskBody): number {
  const roundCount = (body.retry ?? 0) + 1
  // Many long rounds would pass the timer limit, which fires at once or throws past it.
  return Math.min(
    Math.min(body.timeout ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS) * 1000 * roundCount +
      toSendTimeoutMs(body.attachment !== undefined),
    MAX_TIMER_MS,
  )
}

/** HTTP timeout for a call that returns once the message is sent (/notify, /request/async). */
export function toSendTimeoutMs(hasAttachment: boolean): number {
  return FETCH_GRACE_MS + (hasAttachment ? ATTACHMENT_GRACE_MS : 0)
}

/**
 * Asks a question through /request. Fails with `TIMEOUT_TOO_OLD_MESSAGE` when a request over
 * 300 s times out early, since only a service without long timeouts caps it at 300 s, and with
 * `RETRY_TOO_OLD_MESSAGE` when one with `retry` times out without `rounds` in the answer, since
 * only a service without retries leaves it out. Never throws.
 */
export async function requestApi(
  endpoint: URL,
  body: AskBody,
  options: AskOptions,
): Promise<AskResult> {
  const now = options.now ?? (() => performance.now())
  const startMs = now()
  const result = await postApi(endpoint, '/request', body, {
    ...options,
    timeoutMs: toFetchTimeoutMs(body),
  })
  const elapsedMs = now() - startMs
  if (result.kind === 'failed') {
    return result
  }
  if (!isOutcome(result.body)) {
    return unreadable(JSON.stringify(result.body))
  }
  const { answer, timedOut } = result.body
  if (timedOut && isTooEarly(body.timeout, elapsedMs)) {
    return { kind: 'failed', reason: 'tooOld', message: TIMEOUT_TOO_OLD_MESSAGE }
  }
  if (timedOut && (body.retry ?? 0) > 0 && !('rounds' in result.body)) {
    return { kind: 'failed', reason: 'tooOld', message: RETRY_TOO_OLD_MESSAGE }
  }
  const rounds = 'rounds' in result.body ? result.body.rounds : undefined
  return {
    kind: 'ok',
    outcome: { answer, timedOut, ...(typeof rounds === 'number' ? { rounds } : {}) },
  }
}

/** Runs a vote through /vote and resolves once it is decided. Never throws. */
export async function voteApi(
  endpoint: URL,
  body: VoteBody,
  options: Omit<ApiOptions, 'timeoutMs'>,
): Promise<VoteOutcome> {
  const result = await postApi(endpoint, '/vote', body, {
    ...options,
    timeoutMs: toFetchTimeoutMs(body),
  })
  if (result.kind === 'failed') {
    return result
  }
  const parsed = voteReportSchema.safeParse(result.body)
  if (!parsed.success) {
    return unreadable(JSON.stringify(result.body))
  }
  return { kind: 'voted', report: parsed.data }
}

function isTooEarly(timeoutSeconds: number | undefined, elapsedMs: number): boolean {
  if (timeoutSeconds === undefined || timeoutSeconds <= LEGACY_MAX_TIMEOUT_SECONDS) {
    return false
  }
  return elapsedMs < Math.min(timeoutSeconds, MAX_TIMEOUT_SECONDS) * 1000 - FETCH_GRACE_MS
}

/** Rejects on connection errors, resets and aborts; an abort destroys the socket. */
function send(
  url: URL,
  method: ApiMethod,
  payload: string | undefined,
  signal: AbortSignal,
  token: string | undefined,
): Promise<RawResponse> {
  const sendRequest = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const request = sendRequest(
      url,
      {
        method,
        headers: {
          ...(payload === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }),
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        signal,
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          text += chunk
        })
        response.on('error', reject)
        response.on('close', () => {
          if (!response.complete) {
            reject(new Error('response cut off'))
            return
          }
          resolve({ status: response.statusCode ?? 0, text })
        })
      },
    )
    request.on('socket', (socket) => {
      socket.setKeepAlive(true, KEEPALIVE_MS)
    })
    request.on('error', reject)
    request.end(payload)
  })
}

function toTransportFailure(endpoint: URL, options: ApiOptions, timeout: AbortSignal): Failure {
  if (options.signal.aborted) {
    return { kind: 'failed', reason: 'cancelled', message: CANCELLED_MESSAGE }
  }
  if (timeout.aborted) {
    return {
      kind: 'failed',
      reason: 'httpTimeout',
      message: `jaypost service didn't answer within ${options.timeoutMs / 1000} s`,
    }
  }
  const hint = isLoopbackEndpoint(endpoint)
    ? 'run jaypost status'
    : 'check the URL and that the service there is running'
  return {
    kind: 'failed',
    reason: 'unreachable',
    message: `jaypost service not reachable on ${describeEndpoint(endpoint)} (${hint})`,
  }
}

/** The failure for a body that parsed but isn't the shape the service promised. */
export function unreadable(shown: string): Failure {
  return {
    kind: 'failed',
    reason: 'unreadable',
    message: `jaypost service sent an unreadable answer: ${shown}`,
  }
}

/** True for a GET /request/<id> body. */
export function isStateBody(body: unknown): body is StateBody {
  if (typeof body !== 'object' || body === null || !('id' in body) || typeof body.id !== 'string') {
    return false
  }
  if (!('state' in body)) {
    return false
  }
  switch (body.state) {
    case 'pending':
      return 'expiresAt' in body && typeof body.expiresAt === 'string'
    case 'done':
      return (
        'answer' in body &&
        typeof body.answer === 'string' &&
        'timedOut' in body &&
        typeof body.timedOut === 'boolean'
      )
    case 'cancelled':
      return true
    default:
      return false
  }
}

/** The copy for a 404 on a request id. */
function describeUnknownRequest(id: string): string {
  return `jaypost doesn't know request ${id} (the service restarted, or the answer expired after 24 h)`
}

/** True for a /request answer body: `{ answer, timedOut }`. */
function isOutcome(body: unknown): body is { answer: string; timedOut: boolean } {
  return (
    typeof body === 'object' &&
    body !== null &&
    'answer' in body &&
    typeof body.answer === 'string' &&
    'timedOut' in body &&
    typeof body.timedOut === 'boolean'
  )
}

function parseOk(text: string): ApiResult {
  try {
    return { kind: 'ok', body: JSON.parse(text) }
  } catch {
    return unreadable(text.trim())
  }
}

/** The 401 copy: a token was never sent, or it was sent and refused. */
export function describeUnauthorized(sentToken: boolean): string {
  return sentToken ? TOKEN_REJECTED_MESSAGE : TOKEN_REQUIRED_MESSAGE
}

function toStatusFailure(status: number, path: ApiPath, text: string, sentToken: boolean): Failure {
  const error = readStringField(text, 'error')
  if (status === 401) {
    return { kind: 'failed', reason: 'unauthorized', message: describeUnauthorized(sentToken) }
  }
  if (status === 400 && error !== undefined) {
    return { kind: 'failed', reason: 'rejected', message: error }
  }
  if (status === 404 && path === '/notify') {
    return { kind: 'failed', reason: 'tooOld', message: TOO_OLD_MESSAGE }
  }
  if (status === 404 && (path === '/log' || path.startsWith('/log?'))) {
    return { kind: 'failed', reason: 'tooOld', message: LOG_TOO_OLD_MESSAGE }
  }
  if (status === 404 && path === '/vote') {
    return { kind: 'failed', reason: 'tooOld', message: VOTE_TOO_OLD_MESSAGE }
  }
  if (status === 404 && path === '/request/async') {
    return { kind: 'failed', reason: 'tooOld', message: BACKGROUND_TOO_OLD_MESSAGE }
  }
  if (status === 404 && path.startsWith('/request/')) {
    return {
      kind: 'failed',
      reason: 'unknownRequest',
      message: describeUnknownRequest(path.slice('/request/'.length).split('?')[0] ?? ''),
    }
  }
  if (status === 501) {
    return {
      kind: 'failed',
      reason: 'notSupported',
      message:
        error === 'attachments not supported'
          ? ATTACHMENT_NOT_SUPPORTED_MESSAGE
          : NOT_SUPPORTED_MESSAGE,
    }
  }
  if (status === 503) {
    return { kind: 'failed', reason: 'notPaired', message: NOT_PAIRED_MESSAGE }
  }
  if (status === 502) {
    const voter = readStringField(text, 'voter')
    return {
      kind: 'failed',
      reason: 'sendFailed',
      message: voter === undefined ? SEND_FAILED_MESSAGE : `couldn't send the message to ${voter}`,
    }
  }
  return {
    kind: 'failed',
    reason: 'unexpected',
    message: `jaypost service error ${status}: ${error ?? text.trim()}`,
  }
}

/** The string field `key` of the JSON object in `text`, or undefined. Never throws. */
export function readStringField(text: string, key: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && Object.hasOwn(parsed, key)) {
      const value: unknown = Reflect.get(parsed, key)
      return typeof value === 'string' ? value : undefined
    }
  } catch {
    // not JSON, caller falls back to the raw text
  }
  return undefined
}

/** `?name=value&...` of the defined fields, or '' when there are none. */
export function toQuery(fields: Readonly<Record<string, string | undefined>>): string {
  const entries = Object.entries(fields).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  )
  return entries.length === 0 ? '' : `?${new URLSearchParams(entries).toString()}`
}

/** The query fields GET /log and GET /admin/log share. */
export function toLogQueryFields(filter: LogFilter): Readonly<Record<string, string | undefined>> {
  return {
    ...(filter.since === undefined ? {} : { since: filter.since.toISOString() }),
    ...(filter.project === undefined ? {} : { project: filter.project }),
    ...(filter.limit === undefined ? {} : { limit: String(filter.limit) }),
  }
}
