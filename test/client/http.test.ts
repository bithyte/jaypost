import { createServer } from 'node:http'
import type { RequestListener, Server } from 'node:http'
import { Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, test, vi } from 'vite-plus/test'
import {
  ATTACHMENT_GRACE_MS,
  ATTACHMENT_NOT_SUPPORTED_MESSAGE,
  ATTACHMENT_TOO_OLD_MESSAGE,
  BACKGROUND_TOO_OLD_MESSAGE,
  FETCH_GRACE_MS,
  TIMEOUT_TOO_OLD_MESSAGE,
  TOKEN_REJECTED_MESSAGE,
  TOKEN_REQUIRED_MESSAGE,
  callApi,
  isStateBody,
  postApi,
  requestApi,
  toFetchTimeoutMs,
  toSendTimeoutMs,
} from '../../src/client/index.ts'

const servers: Server[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
})

async function startStub(handler: RequestListener): Promise<number> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

function reply(status: number, body: string): RequestListener {
  return (_request, response) => {
    response.statusCode = status
    response.end(body)
  }
}

function options(timeoutMs = 5000): { signal: AbortSignal; timeoutMs: number } {
  return { signal: new AbortController().signal, timeoutMs }
}

const TOKEN = 'A'.repeat(43)

function unreachable(port: number): string {
  return `jaypost service not reachable on 127.0.0.1:${port} (run jaypost status)`
}

test('200 returns the parsed body', async () => {
  let seen: { method?: string; url?: string; type?: string; body: string } = {
    body: '',
  }
  const port = await startStub((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      seen = {
        method: request.method,
        url: request.url,
        type: request.headers['content-type'],
        body,
      }
      response.end('{"answer":"Approve","timedOut":false}')
    })
  })
  const result = await postApi(port, '/request', { question: 'ok?' }, options())
  expect(result).toEqual({
    kind: 'ok',
    body: { answer: 'Approve', timedOut: false },
  })
  expect(seen).toEqual({
    method: 'POST',
    url: '/request',
    type: 'application/json',
    body: '{"question":"ok?"}',
  })
})

test.each([
  [400, '/request', '{"error":"options must be unique"}', 'options must be unique'],
  [
    404,
    '/notify',
    '{"error":"not found"}',
    'jaypost service is too old for notifications (run jaypost init to upgrade)',
  ],
  [501, '/notify', '{"error":"x"}', 'notifications not supported by this provider'],
  [501, '/request', '{"error":"attachments not supported"}', ATTACHMENT_NOT_SUPPORTED_MESSAGE],
  [501, '/notify', '{"error":"attachments not supported"}', ATTACHMENT_NOT_SUPPORTED_MESSAGE],
  [
    501,
    '/request/async',
    '{"error":"notifications not supported"}',
    'notifications not supported by this provider',
  ],
  [503, '/request', '{"error":"x"}', "jaypost isn't paired yet (run jaypost status)"],
  [502, '/request', '{"error":"x"}', "couldn't send the message to the user"],
  [
    500,
    '/request',
    '{"error":"internal server error"}',
    'jaypost service error 500: internal server error',
  ],
] as const)('status %i on %s maps to a message', async (status, path, body, message) => {
  const port = await startStub(reply(status, body))
  expect(await postApi(port, path, {}, options())).toEqual({
    kind: 'failed',
    message,
  })
})

test('non-json error body is used as is', async () => {
  const port = await startStub(reply(404, '<html>nope</html>\n'))
  expect(await postApi(port, '/request', {}, options())).toEqual({
    kind: 'failed',
    message: 'jaypost service error 404: <html>nope</html>',
  })
})

test('unreachable port', async () => {
  const port = await freePort()
  expect(await postApi(port, '/request', {}, options())).toEqual({
    kind: 'failed',
    message: unreachable(port),
  })
})

test('a fractional timeout reads as unreachable instead of throwing', async () => {
  const port = await freePort()
  expect(
    await requestApi(
      port,
      {
        text: 'Deploy?',
        options: ['Approve'],
        timeoutOption: 'Approve',
        timeout: 1.0005,
      },
      { signal: new AbortController().signal },
    ),
  ).toEqual({ kind: 'failed', message: unreachable(port) })
})

test('connection reset mid-request reads as unreachable', async () => {
  const port = await startStub((request) => {
    request.socket.destroy()
  })
  expect(await postApi(port, '/request', {}, options())).toEqual({
    kind: 'failed',
    message: unreachable(port),
  })
})

test('timeout', async () => {
  const port = await startStub(() => {})
  expect(await postApi(port, '/request', {}, options(50))).toEqual({
    kind: 'failed',
    message: "jaypost service didn't answer within 0.05 s",
  })
})

test('caller abort', async () => {
  const controller = new AbortController()
  let closed!: Promise<void>
  let seen!: () => void
  const requestSeen = new Promise<void>((resolve) => (seen = resolve))
  const port = await startStub((request) => {
    closed = new Promise<void>((resolve) => request.on('close', resolve))
    seen()
  })
  const pending = postApi(port, '/request', {}, { signal: controller.signal, timeoutMs: 5000 })
  await requestSeen
  controller.abort()
  expect(await pending).toEqual({ kind: 'failed', message: 'cancelled' })
  await closed
})

// Global fetch has a fixed 300 s headers timeout that drops an ask waiting the full 300 s; a real
// 300 s wait is too slow for a test, so this pins the client to not going through fetch at all.
test('does not use global fetch', async () => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('fetch must not be used')))
  const port = await startStub(reply(200, '{"ok":true}'))
  expect(await postApi(port, '/notify', {}, options())).toEqual({
    kind: 'ok',
    body: { ok: true },
  })
})

test('timeout is capped at 24 h', () => {
  expect(toFetchTimeoutMs(900)).toBe(930_000)
  expect(toFetchTimeoutMs(100_000)).toBe(86_430_000)
  expect(toFetchTimeoutMs(undefined)).toBe(330_000)
  expect(toFetchTimeoutMs(10)).toBe(40_000)
})

test('an attachment adds its grace to the timeouts', () => {
  expect(toFetchTimeoutMs(30, true)).toBe(30_000 + FETCH_GRACE_MS + ATTACHMENT_GRACE_MS)
  expect(toFetchTimeoutMs(30, false)).toBe(30_000 + FETCH_GRACE_MS)
  expect(toSendTimeoutMs(false)).toBe(FETCH_GRACE_MS)
  expect(toSendTimeoutMs(true)).toBe(FETCH_GRACE_MS + ATTACHMENT_GRACE_MS)
})

test('the token is sent as a bearer header only when given', async () => {
  const seen: (string | undefined)[] = []
  const port = await startStub((request, response) => {
    seen.push(request.headers.authorization)
    response.end('{}')
  })
  await postApi(port, '/request', {}, { ...options(), token: TOKEN })
  await postApi(port, '/request', {}, options())
  expect(seen).toEqual([`Bearer ${TOKEN}`, undefined])
})

test('401 explains whether a token was sent', async () => {
  const port = await startStub(reply(401, '{"error":"unauthorized"}'))
  expect(await postApi(port, '/request', {}, options())).toEqual({
    kind: 'failed',
    message: TOKEN_REQUIRED_MESSAGE,
  })
  const result = await postApi(port, '/request', {}, { ...options(), token: TOKEN })
  expect(result).toEqual({ kind: 'failed', message: TOKEN_REJECTED_MESSAGE })
  expect(JSON.stringify(result)).not.toContain(TOKEN)
})

const PENDING = '{"id":"x","state":"pending","expiresAt":"2026-10-20T06:00:00.000Z"}'

test.each(['GET', 'DELETE'] as const)('%s sends no body and 202 is ok', async (method) => {
  let seen: { method?: string; url?: string; length?: string } = {}
  const port = await startStub((request, response) => {
    seen = {
      method: request.method,
      url: request.url,
      length: request.headers['content-length'],
    }
    response.statusCode = 202
    response.end(PENDING)
  })
  expect(await callApi(port, method, '/request/x?wait=5', undefined, options())).toEqual({
    kind: 'ok',
    body: JSON.parse(PENDING),
  })
  expect(seen).toEqual({
    method,
    url: '/request/x?wait=5',
    length: undefined,
  })
})

test('404 on /request/async means the service is too old', async () => {
  const port = await startStub(reply(404, '{"error":"not found"}'))
  expect(await callApi(port, 'POST', '/request/async', {}, options())).toEqual({
    kind: 'failed',
    message: BACKGROUND_TOO_OLD_MESSAGE,
  })
})

test('404 on a request id means the service lost it', async () => {
  const port = await startStub(reply(404, '{"error":"not found"}'))
  expect(await callApi(port, 'GET', '/request/abc?wait=0', undefined, options())).toEqual({
    kind: 'failed',
    message:
      "jaypost doesn't know request abc (the service restarted, or the answer expired after 24 h)",
  })
})

test('sockets use tcp keepalive', async () => {
  const spy = vi.spyOn(Socket.prototype, 'setKeepAlive')
  const port = await startStub(reply(200, '{}'))
  await postApi(port, '/notify', {}, options())
  expect(spy).toHaveBeenCalledWith(true, 60_000)
})

const ASK = {
  text: 'ok?',
  options: ['Approve', 'Decline'],
  timeoutOption: 'Decline',
}

function clock(values: readonly number[]): () => number {
  let index = 0
  return () => values[index++] ?? Number.NaN
}

async function ask(
  timeout: number | undefined,
  body: string,
  times: readonly number[],
): ReturnType<typeof requestApi> {
  const port = await startStub(reply(200, body))
  return requestApi(
    port,
    { ...ASK, ...(timeout === undefined ? {} : { timeout }) },
    { signal: new AbortController().signal, now: clock(times) },
  )
}

const TIMED_OUT = '{"answer":"Decline","timedOut":true}'
const TIMED_OUT_OUTCOME = {
  kind: 'ok',
  outcome: { answer: 'Decline', timedOut: true },
}

test('an early timeout on a request over 300 s means the service is too old', async () => {
  expect(await ask(900, TIMED_OUT, [0, 300_000])).toEqual({
    kind: 'failed',
    message: TIMEOUT_TOO_OLD_MESSAGE,
  })
})

test('a timeout at the requested time is a normal timeout', async () => {
  expect(await ask(900, TIMED_OUT, [0, 900_000])).toEqual(TIMED_OUT_OUTCOME)
})

test('a request over the cap that times out at the cap is a normal timeout', async () => {
  expect(await ask(108_000, TIMED_OUT, [0, 86_400_000])).toEqual(TIMED_OUT_OUTCOME)
})

test('an early answer that is not a timeout passes through', async () => {
  expect(await ask(900, '{"answer":"Decline","timedOut":false}', [0, 1000])).toEqual({
    kind: 'ok',
    outcome: { answer: 'Decline', timedOut: false },
  })
})

test.each([300, undefined])('requests of 300 s or less are never flagged (%s)', async (timeout) => {
  expect(await ask(timeout, TIMED_OUT, [0, 1000])).toEqual(TIMED_OUT_OUTCOME)
})

test('an unreadable /request answer fails with the body', async () => {
  expect(await ask(undefined, '{"answer":1}', [0, 1000])).toEqual({
    kind: 'failed',
    message: 'jaypost service sent an unreadable answer: {"answer":1}',
  })
})

test('isStateBody accepts the three states and rejects the rest', () => {
  expect(isStateBody(JSON.parse(PENDING))).toBe(true)
  expect(isStateBody({ id: 'x', state: 'done', answer: 'A', timedOut: false })).toBe(true)
  expect(isStateBody({ id: 'x', state: 'cancelled' })).toBe(true)
  expect(isStateBody({ id: 'x', state: 'pending' })).toBe(false)
  expect(isStateBody({ id: 'x', state: 'done', answer: 'A' })).toBe(false)
  expect(isStateBody({ id: 'x', state: 'other' })).toBe(false)
  expect(isStateBody({ state: 'cancelled' })).toBe(false)
  expect(isStateBody(null)).toBe(false)
})

test('the too-old messages use the spec wording', () => {
  expect(TIMEOUT_TOO_OLD_MESSAGE).toBe(
    'jaypost service is too old for timeouts over 300 s (run jaypost init to upgrade)',
  )
  expect(BACKGROUND_TOO_OLD_MESSAGE).toBe(
    'jaypost service is too old for background questions (run jaypost init to upgrade)',
  )
})

test('the attachment messages use the spec wording', () => {
  expect(ATTACHMENT_TOO_OLD_MESSAGE).toBe(
    'jaypost service is too old for attachments (run jaypost init to upgrade)',
  )
  expect(ATTACHMENT_NOT_SUPPORTED_MESSAGE).toBe('attachments not supported by this provider')
})
