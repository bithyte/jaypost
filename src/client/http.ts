import { request as httpRequest } from 'node:http'
import { DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS } from '../approval/constants.ts'
import {
  ATTACHMENT_GRACE_MS,
  ATTACHMENT_NOT_SUPPORTED_MESSAGE,
  BACKGROUND_TOO_OLD_MESSAGE,
  CANCELLED_MESSAGE,
  FETCH_GRACE_MS,
  HOST,
  LEGACY_MAX_TIMEOUT_SECONDS,
  NOT_PAIRED_MESSAGE,
  NOT_SUPPORTED_MESSAGE,
  SEND_FAILED_MESSAGE,
  TOKEN_REJECTED_MESSAGE,
  TIMEOUT_TOO_OLD_MESSAGE,
  TOKEN_REQUIRED_MESSAGE,
  TOO_OLD_MESSAGE,
} from './constants.ts'
import type {
  ApiMethod,
  ApiOptions,
  ApiPath,
  ApiResult,
  AskBody,
  AskOptions,
  AskResult,
  StateBody,
} from './types.ts'

/** POSTs JSON to the local service; see `callApi`. */
export function postApi(
  port: number,
  path: ApiPath,
  body: object,
  options: ApiOptions,
): Promise<ApiResult> {
  return callApi(port, 'POST', path, body, options)
}

/**
 * Calls the local service with JSON (no body when `body` is undefined). 200 and 202 are ok. Never
 * throws; no retries. Uses node:http rather than fetch, whose 300 s headers timeout would cut off
 * a request that waits the full approval timeout.
 */
export async function callApi(
  port: number,
  method: ApiMethod,
  path: ApiPath,
  body: object | undefined,
  options: ApiOptions,
): Promise<ApiResult> {
  const timeout = AbortSignal.timeout(Math.ceil(options.timeoutMs))
  const signal = AbortSignal.any([options.signal, timeout])
  let response: RawResponse
  try {
    response = await send(
      options.host ?? HOST,
      port,
      method,
      path,
      body === undefined ? undefined : JSON.stringify(body),
      signal,
      options.token,
    )
  } catch {
    return {
      kind: 'failed',
      message: describeTransportFailure(port, options, timeout),
    }
  }
  if (response.status === 200 || response.status === 202) {
    return parseOk(response.text)
  }
  return {
    kind: 'failed',
    message: describeStatus(response.status, path, response.text, options.token !== undefined),
  }
}

const KEEPALIVE_MS = 60_000

/**
 * HTTP timeout for a /request call: the capped approval timeout plus a grace period, and more
 * when the call uploads an attachment.
 */
export function toFetchTimeoutMs(
  timeoutSeconds: number | undefined,
  hasAttachment = false,
): number {
  return (
    Math.min(timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS) * 1000 +
    toSendTimeoutMs(hasAttachment)
  )
}

/** HTTP timeout for a call that returns once the message is sent (/notify, /request/async). */
export function toSendTimeoutMs(hasAttachment: boolean): number {
  return FETCH_GRACE_MS + (hasAttachment ? ATTACHMENT_GRACE_MS : 0)
}

/**
 * Asks a question through /request. Fails with `TIMEOUT_TOO_OLD_MESSAGE` when a request over
 * 300 s times out early, since only a service without long timeouts caps it at 300 s. Never throws.
 */
export async function requestApi(
  port: number,
  body: AskBody,
  options: AskOptions,
): Promise<AskResult> {
  const now = options.now ?? (() => performance.now())
  const startMs = now()
  const result = await postApi(port, '/request', body, {
    ...options,
    timeoutMs: toFetchTimeoutMs(body.timeout, body.attachment !== undefined),
  })
  const elapsedMs = now() - startMs
  if (result.kind === 'failed') {
    return result
  }
  if (!isOutcome(result.body)) {
    return {
      kind: 'failed',
      message: `jaypost service sent an unreadable answer: ${JSON.stringify(result.body)}`,
    }
  }
  const { answer, timedOut } = result.body
  if (timedOut && isTooEarly(body.timeout, elapsedMs)) {
    return { kind: 'failed', message: TIMEOUT_TOO_OLD_MESSAGE }
  }
  return { kind: 'ok', outcome: { answer, timedOut } }
}

function isTooEarly(timeoutSeconds: number | undefined, elapsedMs: number): boolean {
  if (timeoutSeconds === undefined || timeoutSeconds <= LEGACY_MAX_TIMEOUT_SECONDS) {
    return false
  }
  return elapsedMs < Math.min(timeoutSeconds, MAX_TIMEOUT_SECONDS) * 1000 - FETCH_GRACE_MS
}

type RawResponse = { readonly status: number; readonly text: string }

/** Rejects on connection errors, resets and aborts; an abort destroys the socket. */
function send(
  host: string,
  port: number,
  method: ApiMethod,
  path: ApiPath,
  payload: string | undefined,
  signal: AbortSignal,
  token: string | undefined,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host,
        port,
        path,
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

function describeTransportFailure(port: number, options: ApiOptions, timeout: AbortSignal): string {
  if (options.signal.aborted) {
    return CANCELLED_MESSAGE
  }
  if (timeout.aborted) {
    return `jaypost service didn't answer within ${options.timeoutMs / 1000} s`
  }
  return `jaypost service not reachable on ${options.host ?? HOST}:${port} (run jaypost status)`
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
export function describeUnknownRequest(id: string): string {
  return `jaypost doesn't know request ${id} (the service restarted, or the answer expired after 24 h)`
}

/** True for a /request answer body: `{ answer, timedOut }`. */
export function isOutcome(body: unknown): body is { answer: string; timedOut: boolean } {
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
    return {
      kind: 'failed',
      message: `jaypost service sent an unreadable answer: ${text.trim()}`,
    }
  }
}

/** The 401 copy: a token was never sent, or it was sent and refused. */
export function describeUnauthorized(sentToken: boolean): string {
  return sentToken ? TOKEN_REJECTED_MESSAGE : TOKEN_REQUIRED_MESSAGE
}

function describeStatus(status: number, path: ApiPath, text: string, sentToken: boolean): string {
  const error = readErrorField(text)
  if (status === 401) {
    return describeUnauthorized(sentToken)
  }
  if (status === 400 && error !== undefined) {
    return error
  }
  if (status === 404 && path === '/notify') {
    return TOO_OLD_MESSAGE
  }
  if (status === 404 && path === '/request/async') {
    return BACKGROUND_TOO_OLD_MESSAGE
  }
  if (status === 404 && path.startsWith('/request/')) {
    return describeUnknownRequest(path.slice('/request/'.length).split('?')[0] ?? '')
  }
  if (status === 501) {
    return error === 'attachments not supported'
      ? ATTACHMENT_NOT_SUPPORTED_MESSAGE
      : NOT_SUPPORTED_MESSAGE
  }
  if (status === 503) {
    return NOT_PAIRED_MESSAGE
  }
  if (status === 502) {
    return SEND_FAILED_MESSAGE
  }
  return `jaypost service error ${status}: ${error ?? text.trim()}`
}

function readErrorField(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      return typeof parsed.error === 'string' ? parsed.error : undefined
    }
  } catch {
    // not JSON, caller falls back to the raw text
  }
  return undefined
}
