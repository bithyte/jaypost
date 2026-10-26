import net from 'node:net'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { afterEach, expect, test, vi } from 'vite-plus/test'
import { parse } from 'yaml'
import { LOCAL_PERSON, NO_AUTH } from '@jaypost/store'
import type { ApiAuth, AuditReadResult } from '@jaypost/store'
import { ApprovalService, MAX_ATTACHMENT_BYTES, SendError } from '@jaypost/core'
import type {
  ApprovalRequest,
  FormattedText,
  MessageEnding,
  MessageReference,
  Messenger,
  NotifyRequest,
  RequestResult,
} from '@jaypost/core'
import { createApiServer, createSingleBotRouter } from '../../src/server/index.ts'
import { MAX_BODY_BYTES } from '../../src/server/constants.ts'
import type { StatusInfo } from '@jaypost/protocol'
import type { ApiBot, BotRoute, KeyRoute } from '../../src/server/index.ts'

const TEST_VERSION = '1.2.3'

type RequestFn = (req: ApprovalRequest, signal?: AbortSignal) => Promise<RequestResult>
type NotifyFn = (req: NotifyRequest) => Promise<void>

const valid = {
  text: 'Deploy?',
  options: ['Approve', 'Decline'],
  timeoutOption: 'Decline',
  timeout: 30,
}

let server: FastifyInstance | undefined

afterEach(async () => {
  if (!server) {
    return
  }
  const s = server
  server = undefined
  await s.close()
})

function createStub(request: RequestFn): ApiBot['service'] {
  const unexpected = (): never => {
    throw new Error('unexpected call')
  }
  return {
    request,
    start: unexpected,
    get: unexpected,
    waitFor: unexpected,
    cancel: unexpected,
    // Retries go through send; it settles with request's result, so `request` stays the one mock.
    send: async (sent, signal) => {
      const result = await request(sent, signal)
      return {
        id: 'q',
        reference: { chatId: 1, messageId: 1 },
        message: sent.message,
        result: Promise.resolve(result),
        finalText: () => undefined,
      }
    },
    close: unexpected,
    update: unexpected,
  }
}

async function start(
  request: RequestFn,
  status: () => StatusInfo = () => ({ paired: true, bot: 'b' }),
  notify?: NotifyFn,
  auth: ApiAuth = NO_AUTH,
  maxAttachmentBytes: number = MAX_ATTACHMENT_BYTES,
  recipient: () => string | undefined = () => undefined,
): Promise<string> {
  const stub = createStub(vi.fn(request))
  server = createApiServer(
    createSingleBotRouter({
      version: TEST_VERSION,
      recipient,
      service: stub,
      status: status,
      maxTextLength: 3900,
      providerName: 'test',
      resolveVoters: () => ({ kind: 'noOwner' }),
      describe: () => ({ provider: 'test', displayName: 'test' }),
      rejectForKeys: () => undefined,
      auth,
      maxAttachmentBytes,
      ...(notify === undefined ? {} : { notifications: { notify } }),
    }),
  )
  await server.listen({ port: 0, host: '127.0.0.1' })
  const { port } = server.server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

const BIG = Buffer.alloc(100_000, 7).toString('base64')

const post = (url: string, body: string) =>
  fetch(`${url}/request`, { method: 'POST', body, headers: { 'content-type': 'application/json' } })

const postNotify = (url: string, body: string) =>
  fetch(`${url}/notify`, { method: 'POST', body, headers: { 'content-type': 'application/json' } })

const TOKEN = 'a'.repeat(43)
const WRONG = 'b'.repeat(43)
const TOKEN_AUTH: ApiAuth = { kind: 'token', token: TOKEN }

const call = (
  url: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
) =>
  fetch(`${url}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body }),
  })

const unpaired = (): StatusInfo => ({ paired: false, code: 'ABCD-EFGH', bot: 'b' })

test('200 with outcome', async () => {
  const request = vi.fn<RequestFn>(async () => ({
    kind: 'completed',
    outcome: { answer: 'Approve', timedOut: false },
  }))
  const url = await start(request)
  const res = await post(url, JSON.stringify(valid))
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('application/json')
  expect(await res.json()).toEqual({ answer: 'Approve', timedOut: false })
  expect(request.mock.calls[0]?.[0]).toEqual({
    message: { text: 'Deploy?', spans: [] },
    question: 'Deploy?',
    options: ['Approve', 'Decline'],
    timeoutOption: 'Decline',
    allowText: false,
    timeoutSeconds: 30,
    attachment: undefined,
    reaskOnTimeout: false,
    caller: { key: 'k1', pairing: 'p1' },
  })
})

test('400 on non-JSON body, service not called', async () => {
  const request = vi.fn<RequestFn>()
  const url = await start(request)
  const res = await post(url, '{not json')
  expect(res.status).toBe(400)
  expect(res.headers.get('content-type')).toContain('application/json')
  expect(typeof ((await res.json()) as { error: unknown }).error).toBe('string')
  expect(request).not.toHaveBeenCalled()
})

test('400 on JSON null, array, and validation failure, error message present', async () => {
  const request = vi.fn<RequestFn>()
  const url = await start(request)
  for (const body of ['null', '[]', JSON.stringify({ ...valid, options: [] })]) {
    const res = await post(url, body)
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string }
    expect(json.error.length).toBeGreaterThan(0)
  }
  expect(request).not.toHaveBeenCalled()
})

test('413 on a body one byte over MAX_BODY_BYTES', async () => {
  const request = vi.fn<RequestFn>()
  const url = await start(request)
  const res = await post(url, 'x'.repeat(MAX_BODY_BYTES + 1))
  expect(res.status).toBe(413)
  expect(res.headers.get('content-type')).toContain('application/json')
  expect(typeof ((await res.json()) as { error: unknown }).error).toBe('string')
  expect(request).not.toHaveBeenCalled()
})

test('size limit counts bytes, not characters', async () => {
  const request = vi.fn<RequestFn>()
  const url = await start(request)
  // half the limit in characters, just over the limit in bytes
  const res = await post(url, 'é'.repeat(MAX_BODY_BYTES / 2 + 1))
  expect(res.status).toBe(413)
  expect(request).not.toHaveBeenCalled()
})

test('502 on SendError', async () => {
  const url = await start(async () => {
    throw new SendError('boom')
  })
  const res = await post(url, JSON.stringify(valid))
  expect(res.status).toBe(502)
  expect(await res.json()).toEqual({ error: 'failed to send message' })
})

test('server uses the provider text limit', async () => {
  server = createApiServer(
    createSingleBotRouter({
      version: TEST_VERSION,
      recipient: () => undefined,
      service: createStub(vi.fn<RequestFn>()),
      status: () => ({ paired: true, bot: 'b' }),
      maxTextLength: 10,
      providerName: 'test',
      resolveVoters: () => ({ kind: 'noOwner' }),
      describe: () => ({ provider: 'test', displayName: 'test' }),
      rejectForKeys: () => undefined,
      auth: NO_AUTH,
    }),
  )
  await server.listen({ port: 0, host: '127.0.0.1' })
  const { port } = server.server.address() as AddressInfo
  const res = await post(
    `http://127.0.0.1:${port}`,
    JSON.stringify({ ...valid, text: 'x'.repeat(11) }),
  )
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'text must be at most 10 characters' })
})

test('500 on unexpected error without leaking details', async () => {
  const url = await start(async () => {
    throw new Error('secret internal detail')
  })
  const res = await post(url, JSON.stringify(valid))
  expect(res.status).toBe(500)
  const text = await res.text()
  expect(text).not.toContain('secret')
  expect(JSON.parse(text)).toHaveProperty('error')
})

test('GET /openapi.yaml serves the spec with the listening port and text limit', async () => {
  const url = await start(vi.fn<RequestFn>(), unpaired)
  const res = await fetch(`${url}/openapi.yaml`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('application/yaml')
  const document = parse(await res.text())
  expect(document.info.version).toBe(TEST_VERSION)
  expect(document.servers).toEqual([{ url }])
  expect(document.components.schemas.ApprovalRequest.properties.text.description).toContain('3900')
})

test('405 on POST /openapi.yaml', async () => {
  const url = await start(vi.fn<RequestFn>())
  const res = await fetch(`${url}/openapi.yaml`, { method: 'POST' })
  expect(res.status).toBe(405)
  expect(res.headers.get('allow')).toBe('GET')
})

test('404 on GET /other, 405 on GET /request', async () => {
  const url = await start(vi.fn<RequestFn>())
  const other = await fetch(`${url}/other`)
  expect(other.status).toBe(404)
  expect(other.headers.get('content-type')).toContain('application/json')
  const wrongMethod = await fetch(`${url}/request`)
  expect(wrongMethod.status).toBe(405)
  expect(wrongMethod.headers.get('content-type')).toContain('application/json')
})

test('client abort triggers signal', async () => {
  let signal: AbortSignal | undefined
  const url = await start((_req, s) => {
    signal = s
    return new Promise(() => {})
  })
  const ac = new AbortController()
  const aborting = fetch(`${url}/request`, {
    method: 'POST',
    body: JSON.stringify(valid),
    signal: ac.signal,
  }).catch(() => {})
  setTimeout(() => ac.abort(), 50)
  await aborting
  await vi.waitFor(() => expect(signal?.aborted).toBe(true))
})

test('signal is not aborted after a normal response', async () => {
  let signal: AbortSignal | undefined
  const url = await start(async (_req, s) => {
    signal = s
    return { kind: 'completed', outcome: { answer: 'Approve', timedOut: false } }
  })
  const res = await post(url, JSON.stringify(valid))
  await res.json()
  await new Promise((r) => setTimeout(r, 50))
  expect(signal).toBeDefined()
  expect(signal?.aborted).toBe(false)
})

test('client gone before service resolves does not crash the server', async () => {
  let resolve!: (o: RequestResult) => void
  const url = await start(
    (_req, s) =>
      new Promise((r) => {
        resolve = r
        s?.addEventListener('abort', () => r({ kind: 'cancelled' }))
      }),
  )
  const ac = new AbortController()
  const p = fetch(`${url}/request`, {
    method: 'POST',
    body: JSON.stringify(valid),
    signal: ac.signal,
  }).catch(() => {})
  await vi.waitFor(() => expect(resolve).toBeDefined())
  ac.abort()
  await p
  await new Promise((r) => setTimeout(r, 50))
  resolve({ kind: 'completed', outcome: { answer: 'Approve', timedOut: false } })
  await new Promise((r) => setTimeout(r, 50))
  const again = await fetch(`${url}/other`)
  expect(again.status).toBe(404)
})

test('malformed request target gets 404 and the server keeps serving', async () => {
  const url = await start(vi.fn<RequestFn>())
  const port = Number(new URL(url).port)
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let data = ''
    socket.on('data', (d) => (data += d))
    socket.on('error', reject)
    socket.on('close', () => resolve(data))
    socket.write('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
  })
  expect(raw.startsWith('HTTP/1.1 404')).toBe(true)
  expect(raw).toContain('application/json')
  const after = await fetch(`${url}/other`)
  expect(after.status).toBe(404)
})

test('GET /status reports pairing', async () => {
  const url = await start(
    async () => ({ kind: 'cancelled' }),
    () => ({ paired: false, code: 'K7QM-4XPD', bot: 'b' }),
  )
  const res = await fetch(`${url}/status`)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    paired: false,
    code: 'K7QM-4XPD',
    bot: 'b',
    maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
    maxTextLength: 3900,
  })
})

test('GET /status when paired', async () => {
  const url = await start(async () => ({ kind: 'cancelled' }))
  const res = await fetch(`${url}/status`)
  expect(await res.json()).toEqual({
    paired: true,
    bot: 'b',
    maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
    maxTextLength: 3900,
  })
})

test('POST /request is 503 while unpaired, service not called', async () => {
  const request = vi.fn<RequestFn>()
  const url = await start(request, () => ({ paired: false, code: 'X', bot: 'b' }))
  const res = await post(url, JSON.stringify(valid))
  expect(res.status).toBe(503)
  expect(await res.json()).toEqual({ error: 'not paired' })
  const bad = await post(url, '{not json')
  expect(bad.status).toBe(503)
  expect(request).not.toHaveBeenCalled()
})

test('POST /status is 405 with Allow: GET', async () => {
  const url = await start(async () => ({ kind: 'cancelled' }))
  const res = await fetch(`${url}/status`, { method: 'POST', body: '{}' })
  expect(res.status).toBe(405)
  expect(res.headers.get('allow')).toBe('GET')
})

test('project is folded into the request text', async () => {
  const request = vi.fn<RequestFn>(async () => ({
    kind: 'completed',
    outcome: { answer: 'Approve', timedOut: false },
  }))
  const url = await start(request)
  const res = await post(url, JSON.stringify({ ...valid, project: 'api' }))
  expect(res.status).toBe(200)
  expect(request.mock.calls[0]?.[0].message.text).toBe('[api]\n\nDeploy?')
})

test('project is folded into the notification text', async () => {
  const notify = vi.fn<NotifyFn>(async () => {})
  const url = await start(vi.fn<RequestFn>(), undefined, notify)
  const res = await postNotify(url, JSON.stringify({ text: 'hi', project: 'api' }))
  expect(res.status).toBe(200)
  expect(notify).toHaveBeenCalledWith({ message: { text: '[api]\n\nhi', spans: [] } }, undefined)
})

test('POST /notify returns ok once sent', async () => {
  const notify = vi.fn<NotifyFn>(async () => {})
  const url = await start(vi.fn<RequestFn>(), undefined, notify)
  const res = await postNotify(url, JSON.stringify({ text: 'hi' }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  expect(notify).toHaveBeenCalledWith({ message: { text: 'hi', spans: [] } }, undefined)
})

test('POST /notify 400 on bad JSON and bad text, notify not called', async () => {
  const notify = vi.fn<NotifyFn>()
  const url = await start(vi.fn<RequestFn>(), undefined, notify)
  for (const body of ['{not json', JSON.stringify({ text: '' }), 'null']) {
    const res = await postNotify(url, body)
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string }
    expect(json.error.length).toBeGreaterThan(0)
  }
  expect(notify).not.toHaveBeenCalled()
})

test('POST /notify 502 on SendError', async () => {
  const url = await start(vi.fn<RequestFn>(), undefined, async () => {
    throw new SendError('x')
  })
  const res = await postNotify(url, JSON.stringify({ text: 'hi' }))
  expect(res.status).toBe(502)
})

test('POST /notify 413 on a body one byte over MAX_BODY_BYTES', async () => {
  const notify = vi.fn<NotifyFn>()
  const url = await start(vi.fn<RequestFn>(), undefined, notify)
  const res = await postNotify(url, 'x'.repeat(MAX_BODY_BYTES + 1))
  expect(res.status).toBe(413)
  expect(notify).not.toHaveBeenCalled()
})

test('POST /notify is 503 while unpaired, before validation', async () => {
  const notify = vi.fn<NotifyFn>()
  const url = await start(vi.fn<RequestFn>(), unpaired, notify)
  const res = await postNotify(url, '{not json')
  expect(res.status).toBe(503)
  expect(await res.json()).toEqual({ error: 'not paired' })
  expect(notify).not.toHaveBeenCalled()
})

test('POST /notify is 501 without notifications, before pairing check', async () => {
  const url = await start(vi.fn<RequestFn>(), unpaired)
  const res = await postNotify(url, JSON.stringify({ text: 'hi' }))
  expect(res.status).toBe(501)
  expect(await res.json()).toEqual({ error: 'notifications not supported' })
})

test('GET /notify is 405 with Allow: POST', async () => {
  const url = await start(vi.fn<RequestFn>(), undefined, vi.fn<NotifyFn>())
  const res = await fetch(`${url}/notify`)
  expect(res.status).toBe(405)
  expect(res.headers.get('allow')).toBe('POST')
})

test('401 with WWW-Authenticate on every api route for a missing, malformed or wrong token', async () => {
  const url = await start(vi.fn<RequestFn>(), undefined, vi.fn<NotifyFn>(), TOKEN_AUTH)
  const routes = [
    ['POST', '/request', JSON.stringify(valid)],
    ['POST', '/notify', JSON.stringify({ text: 'hi' })],
    ['GET', '/status', undefined],
  ] as const
  const headerSets: Record<string, string>[] = [
    {},
    { authorization: `Basic ${TOKEN}` },
    { authorization: `Bearer ${WRONG}` },
  ]
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  for (const [method, path, body] of routes) {
    for (const headers of headerSets) {
      const res = await call(url, method, path, headers, body)
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe('Bearer')
      expect(await res.json()).toEqual({ error: 'unauthorized' })
    }
  }
  error.mockRestore()
})

test('401 comes before 503, 400 and 413, and nothing reaches the service', async () => {
  const request = vi.fn<RequestFn>()
  const notify = vi.fn<NotifyFn>()
  const url = await start(request, unpaired, notify, TOKEN_AUTH)
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  for (const body of [JSON.stringify(valid), '{not json', 'x'.repeat(70_000)]) {
    for (const path of ['/request', '/notify']) {
      expect((await call(url, 'POST', path, {}, body)).status).toBe(401)
    }
  }
  expect(request).not.toHaveBeenCalled()
  expect(notify).not.toHaveBeenCalled()
  error.mockRestore()
})

test('the right token behaves as today', async () => {
  const request = vi.fn<RequestFn>(async () => ({
    kind: 'completed',
    outcome: { answer: 'Approve', timedOut: false },
  }))
  const url = await start(request, undefined, undefined, TOKEN_AUTH)
  for (const authorization of [`Bearer ${TOKEN}`, `bearer   ${TOKEN}`]) {
    const res = await call(url, 'POST', '/request', { authorization }, JSON.stringify(valid))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ answer: 'Approve', timedOut: false })
  }
  const status = await call(url, 'GET', '/status', { authorization: `Bearer ${TOKEN}` })
  expect(status.status).toBe(200)
  expect(await status.json()).toEqual({
    paired: true,
    bot: 'b',
    maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
    maxTextLength: 3900,
  })
})

test('openapi.yaml, 404 and 405 stay open with a token', async () => {
  const url = await start(vi.fn<RequestFn>(), undefined, undefined, TOKEN_AUTH)
  expect((await call(url, 'GET', '/openapi.yaml', {})).status).toBe(200)
  expect((await call(url, 'GET', '/other', {})).status).toBe(404)
  const res = await call(url, 'GET', '/request', {})
  expect(res.status).toBe(405)
  expect(res.headers.get('allow')).toBe('POST')
})

test('rejections are logged once each without the token', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const url = await start(vi.fn<RequestFn>(), undefined, undefined, TOKEN_AUTH)
  await call(url, 'POST', '/request', {}, JSON.stringify(valid))
  await call(url, 'GET', '/status', { authorization: `Bearer ${WRONG}` })
  expect(error.mock.calls).toEqual([
    ['rejected POST /request: missing token'],
    ['rejected GET /status: wrong token'],
  ])
  error.mockRestore()
})

test('without a token a stray authorization header is ignored', async () => {
  const request = vi.fn<RequestFn>(async () => ({
    kind: 'completed',
    outcome: { answer: 'Approve', timedOut: false },
  }))
  const url = await start(request)
  const res = await call(
    url,
    'POST',
    '/request',
    { authorization: 'Bearer whatever' },
    JSON.stringify(valid),
  )
  expect(res.status).toBe(200)
})

function toBot(request: RequestFn, maxTextLength: number): ApiBot {
  return {
    botId: 'b1',
    service: createStub(request),
    maxTextLength,
    providerName: 'test',
    resolveVoters: () => ({ kind: 'noOwner' }),
    describe: () => ({ provider: 'test', displayName: 'test' }),
    rejectForKeys: () => undefined,
  }
}

function toRoute(
  bot: ApiBot | undefined,
  options: { readonly key?: string; readonly person?: string; readonly log?: AuditReadResult } = {},
): KeyRoute {
  const key = options.key ?? 'k1'
  return {
    kind: 'key',
    caller: { key, pairing: 'p1' },
    person: options.person,
    bot,
    status: () => ({ paired: options.person !== undefined, code: 'ABCD-EFGH', key }),
    readLog: () => options.log ?? { entries: [], skippedCount: 0 },
  }
}

async function startRouted(route: (authorization: string | undefined) => BotRoute) {
  server = createApiServer({
    route,
    openApi: () => ({ version: TEST_VERSION, maxTextLength: 100, maxAttachmentBytes: 0 }),
  })
  await server.listen({ port: 0, host: '127.0.0.1' })
  const { port } = server.server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

test('a router with several bots sends each call to the bot its token picks', async () => {
  const askFirst = vi.fn<RequestFn>(async () => ({
    kind: 'completed',
    outcome: { answer: 'first', timedOut: false },
  }))
  const askSecond = vi.fn<RequestFn>(async () => ({
    kind: 'completed',
    outcome: { answer: 'second', timedOut: false },
  }))
  const routesByToken = new Map([
    [TOKEN, toRoute(toBot(askFirst, 100), { person: 'u1' })],
    [WRONG, toRoute(toBot(askSecond, 200), { key: 'k2', person: 'u2' })],
  ])
  const url = await startRouted(
    (authorization) =>
      routesByToken.get(authorization?.replace('Bearer ', '') ?? '') ?? {
        kind: 'unauthorized',
        reason: 'wrong',
      },
  )
  const ask = (token: string) =>
    call(url, 'POST', '/request', { authorization: `Bearer ${token}` }, JSON.stringify(valid))
  const status = (token: string) =>
    call(url, 'GET', '/status', { authorization: `Bearer ${token}` })
  expect(await (await ask(TOKEN)).json()).toEqual({ answer: 'first', timedOut: false })
  expect(await (await ask(WRONG)).json()).toEqual({ answer: 'second', timedOut: false })
  expect(await (await status(WRONG)).json()).toEqual({
    paired: true,
    code: 'ABCD-EFGH',
    key: 'k2',
  })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect((await ask('c'.repeat(43))).status).toBe(401)
  error.mockRestore()
  expect(askFirst.mock.calls[0]?.[0]).toMatchObject({
    recipient: 'u1',
    caller: { key: 'k1', pairing: 'p1' },
  })
  expect(askSecond.mock.calls[0]?.[0]).toMatchObject({
    recipient: 'u2',
    caller: { key: 'k2', pairing: 'p1' },
  })
})

test('a key whose bot is not running gets 503 on every question route', async () => {
  const url = await startRouted(() => toRoute(undefined, { person: 'u1' }))
  const routes = [
    ['POST', '/request', JSON.stringify(valid)],
    ['POST', '/request/async', JSON.stringify(valid)],
    ['POST', '/vote', JSON.stringify(valid)],
    ['POST', '/notify', JSON.stringify({ text: 'hi' })],
    ['GET', '/request/q1', undefined],
    ['DELETE', '/request/q1', undefined],
  ] as const
  for (const [method, path, body] of routes) {
    const res = await call(url, method, path, {}, body)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'bot unavailable' })
  }
  const status = await call(url, 'GET', '/status', {})
  expect(status.status).toBe(200)
  expect(await status.json()).toEqual({ paired: true, code: 'ABCD-EFGH', key: 'k1' })
})

test('the local person of a bot that does not pair sends to nobody in particular', async () => {
  const request = vi.fn<RequestFn>(async () => ({
    kind: 'completed',
    outcome: { answer: 'Approve', timedOut: false },
  }))
  const url = await startRouted(() => toRoute(toBot(request, 100), { person: LOCAL_PERSON }))
  expect((await post(url, JSON.stringify(valid))).status).toBe(200)
  expect(request.mock.calls[0]?.[0]).not.toHaveProperty('recipient')
  expect(request.mock.calls[0]?.[0].caller).toEqual({ key: 'k1', pairing: 'p1' })
})

test('GET /log answers the route log and checks its query', async () => {
  const entry = {
    id: 'q1',
    askedAt: '2026-10-26T10:00:00.000Z',
    text: 'Deploy?',
    options: ['Approve', 'Decline'],
    timeoutOption: 'Decline',
    timeoutSeconds: 30,
    status: 'answered',
    answer: 'Approve',
    key: 'k1',
    pairing: 'p1',
  }
  const readLog = vi.fn<KeyRoute['readLog']>(() => ({ entries: [entry], skippedCount: 2 }))
  const url = await startRouted(() => ({ ...toRoute(undefined), readLog }))
  const res = await call(url, 'GET', '/log?since=2026-10-01&project=api&limit=5', {})
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ entries: [entry], skippedCount: 2 })
  expect(readLog).toHaveBeenCalledWith({
    since: new Date(2026, 9, 1),
    project: 'api',
    limit: 5,
  })
  for (const query of ['?since=soon', '?limit=0', '?limit=x', '?project=a&project=b']) {
    const bad = await call(url, 'GET', `/log${query}`, {})
    expect(bad.status).toBe(400)
  }
  expect(readLog).toHaveBeenCalledTimes(1)
  const post405 = await call(url, 'POST', '/log', {}, '{}')
  expect(post405.status).toBe(405)
  expect(post405.headers.get('allow')).toBe('GET')
})

test('markdown request reaches the provider as spans', async () => {
  const request = vi.fn<RequestFn>(async () => ({
    kind: 'completed',
    outcome: { answer: 'Approve', timedOut: false },
  }))
  const notify = vi.fn<NotifyFn>(async () => {})
  const url = await start(request, undefined, notify)
  const body = { text: 'Run `ls`?', format: 'markdown' }
  expect((await post(url, JSON.stringify({ ...valid, ...body }))).status).toBe(200)
  expect(request.mock.calls[0]?.[0].message).toEqual({
    text: 'Run ls?',
    spans: [{ kind: 'code', offset: 4, length: 2 }],
  })
  expect((await postNotify(url, JSON.stringify(body))).status).toBe(200)
  expect(notify).toHaveBeenCalledWith(
    { message: { text: 'Run ls?', spans: [{ kind: 'code', offset: 4, length: 2 }] } },
    undefined,
  )
})

test('POST /notify sends to the bot owner', async () => {
  const notify = vi.fn<NotifyFn>(async () => {})
  const url = await start(
    vi.fn<RequestFn>(),
    undefined,
    notify,
    NO_AUTH,
    MAX_ATTACHMENT_BYTES,
    () => '42',
  )
  expect((await postNotify(url, JSON.stringify({ text: 'hi' }))).status).toBe(200)
  expect(notify).toHaveBeenCalledWith({ message: { text: 'hi', spans: [] } }, '42')
})

test('POST /request asks the bot owner', async () => {
  const request = vi.fn<RequestFn>(async () => ({
    kind: 'completed',
    outcome: { answer: 'Approve', timedOut: false },
  }))
  const url = await start(request, undefined, undefined, NO_AUTH, MAX_ATTACHMENT_BYTES, () => '42')
  expect((await post(url, JSON.stringify(valid))).status).toBe(200)
  expect(request.mock.calls[0]?.[0].recipient).toBe('42')
})

test('an unknown format is a 400 on both endpoints', async () => {
  const notify = vi.fn<NotifyFn>()
  const url = await start(vi.fn<RequestFn>(), undefined, notify)
  for (const [send, body] of [
    [post, { ...valid, format: 'html' }],
    [postNotify, { text: 'hi', format: 'html' }],
  ] as const) {
    const res = await send(url, JSON.stringify(body))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'format must be "plain" or "markdown"' })
  }
})

test('held requests have no server-side time limit', async () => {
  await start(async () => ({ kind: 'cancelled' }))
  expect(server?.server.requestTimeout).toBe(0)
  expect(server?.initialConfig.connectionTimeout).toBe(0)
  expect(server?.server.timeout).toBe(0)
})

class RecordingMessenger implements Messenger {
  sent: { id: string; text: string }[] = []
  recipients: (string | undefined)[] = []
  finalized: { text: string; ending: MessageEnding }[] = []
  failSend = false

  async sendRequest(
    id: string,
    message: FormattedText,
    _options: readonly string[],
    _allowText: boolean,
    _attachment: unknown,
    recipient: string | undefined,
  ): Promise<MessageReference> {
    if (this.failSend) {
      throw new Error('telegram down')
    }
    this.sent.push({ id, text: message.text })
    this.recipients.push(recipient)
    return { chatId: 1, messageId: this.sent.length }
  }

  idOf(recipient: string | undefined): string {
    const index = this.recipients.lastIndexOf(recipient)
    const id = this.sent[index]?.id
    if (id === undefined) {
      throw new Error(`nothing sent to ${String(recipient)}`)
    }
    return id
  }

  async finalize(
    _reference: MessageReference,
    message: FormattedText,
    ending: MessageEnding,
  ): Promise<void> {
    this.finalized.push({ text: message.text, ending })
  }
}

async function startReal(
  options: {
    readonly status?: () => StatusInfo
    readonly auth?: ApiAuth
    readonly maxAttachmentBytes?: number
    readonly maxTextLength?: number
    readonly maxOptionCount?: number
    readonly resolveVoters?: ApiBot['resolveVoters']
    readonly recipient?: string
  } = {},
) {
  const messenger = new RecordingMessenger()
  const service = new ApprovalService(messenger)
  server = createApiServer(
    createSingleBotRouter({
      version: TEST_VERSION,
      recipient: () => options.recipient,
      service,
      status: options.status ?? (() => ({ paired: true, bot: 'b' })),
      maxTextLength: options.maxTextLength ?? 3900,
      providerName: 'test',
      resolveVoters: options.resolveVoters ?? (() => ({ kind: 'noOwner' })),
      describe: () => ({ provider: 'test', displayName: 'test' }),
      rejectForKeys: () => undefined,
      auth: options.auth ?? NO_AUTH,
      maxAttachmentBytes: options.maxAttachmentBytes ?? MAX_ATTACHMENT_BYTES,
      ...(options.maxOptionCount === undefined ? {} : { maxOptionCount: options.maxOptionCount }),
    }),
  )
  await server.listen({ port: 0, host: '127.0.0.1' })
  const { port } = server.server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, messenger, service }
}

const postAsync = (url: string, body: string) =>
  fetch(`${url}/request/async`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
  })

async function createAsync(url: string, messenger: RecordingMessenger): Promise<string> {
  const res = await postAsync(url, JSON.stringify(valid))
  expect(res.status).toBe(202)
  const body = (await res.json()) as { id: string }
  expect(messenger.sent.map((message) => message.id)).toContain(body.id)
  return body.id
}

test('async create answers 202 with the id, location and expiry', async () => {
  const { url } = await startReal()
  const before = Date.now()
  const res = await postAsync(url, JSON.stringify(valid))
  expect(res.status).toBe(202)
  const body = (await res.json()) as { id: string; state: string; expiresAt: string }
  expect(res.headers.get('location')).toBe(`/request/${body.id}`)
  expect(body).toEqual({ id: body.id, state: 'pending', expiresAt: expect.any(String) })
  const expiresAtMs = Date.parse(body.expiresAt)
  expect(new Date(expiresAtMs).toISOString()).toBe(body.expiresAt)
  expect(expiresAtMs).toBeGreaterThanOrEqual(before + 30_000)
  expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + 30_000)
})

test('get answers at once with the current state', async () => {
  const { url, messenger, service } = await startReal()
  const id = await createAsync(url, messenger)
  const pending = await fetch(`${url}/request/${id}`)
  expect(pending.status).toBe(200)
  expect(await pending.json()).toEqual({ id, state: 'pending', expiresAt: expect.any(String) })
  service.tap(id, 0)
  const done = await fetch(`${url}/request/${id}`)
  expect(await done.json()).toEqual({ id, state: 'done', answer: 'Approve', timedOut: false })
})

test('a long-poll returns as soon as the question settles', async () => {
  const { url, messenger, service } = await startReal()
  const id = await createAsync(url, messenger)
  const startedAt = performance.now()
  const response = fetch(`${url}/request/${id}?wait=60`)
  setTimeout(() => service.tap(id, 1), 50)
  const res = await response
  expect(await res.json()).toEqual({ id, state: 'done', answer: 'Decline', timedOut: false })
  expect(performance.now() - startedAt).toBeLessThan(5000)
})

test('a long-poll returns pending when wait runs out', async () => {
  const { url, messenger } = await startReal()
  const id = await createAsync(url, messenger)
  const res = await fetch(`${url}/request/${id}?wait=0.2`)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ id, state: 'pending', expiresAt: expect.any(String) })
})

test('closing a long-poll leaves the question open', async () => {
  const { url, messenger, service } = await startReal()
  const id = await createAsync(url, messenger)
  const controller = new AbortController()
  const poll = fetch(`${url}/request/${id}?wait=60`, { signal: controller.signal })
  await new Promise((resolve) => setTimeout(resolve, 100))
  controller.abort()
  await expect(poll).rejects.toThrow()
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(service.get(id, 'k1')?.kind).toBe('pending')
  expect(messenger.finalized).toEqual([])
  service.tap(id, 0)
  const res = await fetch(`${url}/request/${id}`)
  expect(await res.json()).toEqual({ id, state: 'done', answer: 'Approve', timedOut: false })
})

test('delete cancels a pending question and get agrees', async () => {
  const { url, messenger } = await startReal()
  const id = await createAsync(url, messenger)
  const res = await fetch(`${url}/request/${id}`, { method: 'DELETE' })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ id, state: 'cancelled' })
  const after = await fetch(`${url}/request/${id}`)
  expect(after.status).toBe(200)
  expect(await after.json()).toEqual({ id, state: 'cancelled' })
  await vi.waitFor(() => expect(messenger.finalized).toHaveLength(1))
  expect(messenger.finalized[0]?.ending).toEqual({ kind: 'cancelled' })
})

test('delete on a settled question returns its state', async () => {
  const { url, messenger, service } = await startReal()
  const id = await createAsync(url, messenger)
  service.tap(id, 0)
  const res = await fetch(`${url}/request/${id}`, { method: 'DELETE' })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ id, state: 'done', answer: 'Approve', timedOut: false })
})

test('unknown ids answer 404', async () => {
  const { url } = await startReal()
  for (const method of ['GET', 'DELETE']) {
    const res = await fetch(`${url}/request/nope`, { method })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'unknown request' })
  }
})

test('a bad wait answers 400', async () => {
  const { url, messenger } = await startReal()
  const id = await createAsync(url, messenger)
  const queries = ['wait=', 'wait=-1', 'wait=abc', 'wait=Infinity', 'wait=1e999', 'wait=1&wait=2']
  for (const query of queries) {
    const res = await fetch(`${url}/request/${id}?${query}`)
    expect(res.status, query).toBe(400)
    expect(await res.json()).toEqual({ error: 'wait must be a non-negative number' })
  }
})

test('async create validates like /request', async () => {
  const { url, messenger } = await startReal()
  expect((await postAsync(url, '{nope')).status).toBe(400)
  expect((await postAsync(url, JSON.stringify({ text: 'x' }))).status).toBe(400)
  expect((await postAsync(url, 'x'.repeat(MAX_BODY_BYTES + 1))).status).toBe(413)
  expect(messenger.sent).toEqual([])
  await server?.close()
  server = undefined
  const unpairedServer = await startReal({ status: unpaired })
  expect((await postAsync(unpairedServer.url, JSON.stringify(valid))).status).toBe(503)
  expect(unpairedServer.messenger.sent).toEqual([])
})

test('async create answers 502 when the message fails to send', async () => {
  const { url, messenger } = await startReal()
  messenger.failSend = true
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const res = await postAsync(url, JSON.stringify(valid))
  spy.mockRestore()
  expect(res.status).toBe(502)
  expect(await res.json()).toEqual({ error: 'failed to send message' })
})

test('only async create checks pairing', async () => {
  const { url, messenger, service } = await startReal()
  const id = await createAsync(url, messenger)
  await server?.close()
  server = undefined
  const other = createApiServer(
    createSingleBotRouter({
      version: TEST_VERSION,
      recipient: () => undefined,
      service,
      status: unpaired,
      maxTextLength: 3900,
      providerName: 'test',
      resolveVoters: () => ({ kind: 'noOwner' }),
      describe: () => ({ provider: 'test', displayName: 'test' }),
      rejectForKeys: () => undefined,
      auth: NO_AUTH,
    }),
  )
  server = other
  await other.listen({ port: 0, host: '127.0.0.1' })
  const { port } = other.server.address() as AddressInfo
  const res = await fetch(`http://127.0.0.1:${port}/request/${id}`)
  expect(res.status).toBe(200)
})

test('the new routes answer 405 with Allow', async () => {
  const { url } = await startReal()
  const put = await fetch(`${url}/request/async`, { method: 'PUT' })
  expect(put.status).toBe(405)
  expect(put.headers.get('allow')).toBe('POST')
  const other = await fetch(`${url}/request/abc`, { method: 'POST' })
  expect(other.status).toBe(405)
  expect(other.headers.get('allow')).toBe('GET, DELETE')
})

test('the new routes need the token', async () => {
  const { url, messenger } = await startReal({ auth: TOKEN_AUTH })
  const headers = { authorization: `Bearer ${TOKEN}` }
  const created = await call(url, 'POST', '/request/async', headers, JSON.stringify(valid))
  const { id } = (await created.json()) as { id: string }
  expect(messenger.sent).toHaveLength(1)
  const rejected = [
    await call(url, 'POST', '/request/async', {}, JSON.stringify(valid)),
    await call(url, 'GET', `/request/${id}`, {}),
    await call(url, 'DELETE', `/request/${id}`, { authorization: `Bearer ${WRONG}` }),
  ]
  expect(rejected.map((res) => res.status)).toEqual([401, 401, 401])
  expect(messenger.sent).toHaveLength(1)
  expect((await call(url, 'GET', `/request/${id}`, headers)).status).toBe(200)
})

const ATTACHMENT = { name: 'a.bin', data: BIG }

test('a body over 64 KiB with an attachment is accepted', async () => {
  const request = vi.fn<RequestFn>(async () => ({
    kind: 'completed',
    outcome: { answer: 'Approve', timedOut: false },
  }))
  const url = await start(request)
  const res = await post(url, JSON.stringify({ ...valid, attachment: ATTACHMENT }))
  expect(res.status).toBe(200)
  expect(request.mock.calls[0]?.[0].attachment?.content.byteLength).toBe(100_000)
})

test('501 without attachment support only when the body has attachment', async () => {
  const request = vi.fn<RequestFn>(async () => ({
    kind: 'completed',
    outcome: { answer: 'Approve', timedOut: false },
  }))
  const url = await start(request, undefined, undefined, NO_AUTH, 0)
  const res = await post(url, JSON.stringify({ ...valid, attachment: null }))
  expect(res.status).toBe(501)
  expect(await res.json()).toEqual({ error: 'attachments not supported' })
  expect(request).not.toHaveBeenCalled()
  expect((await post(url, JSON.stringify(valid))).status).toBe(200)
})

test('/request check order: 503, bad json, 501, validation', async () => {
  const request = vi.fn<RequestFn>()
  let url = await start(request, unpaired)
  expect((await post(url, JSON.stringify({ attachment: ATTACHMENT }))).status).toBe(503)
  await server?.close()
  url = await start(request, undefined, undefined, NO_AUTH, 0)
  const bad = await post(url, '{nope')
  expect(bad.status).toBe(400)
  expect(await bad.json()).toEqual({ error: 'body must be valid JSON' })
  expect((await post(url, JSON.stringify({ text: 1, attachment: 5 }))).status).toBe(501)
  expect(request).not.toHaveBeenCalled()
})

test('/notify check order: 501 notifications, 503, bad json, 501 attachments, validation', async () => {
  const notify = vi.fn<NotifyFn>()
  const body = JSON.stringify({ text: 1, attachment: 5 })
  let url = await start(vi.fn<RequestFn>(), unpaired)
  expect((await postNotify(url, body)).status).toBe(501)
  await server?.close()
  url = await start(vi.fn<RequestFn>(), unpaired, notify)
  expect((await postNotify(url, body)).status).toBe(503)
  await server?.close()
  url = await start(vi.fn<RequestFn>(), undefined, notify, NO_AUTH, 0)
  expect((await postNotify(url, '{nope')).status).toBe(400)
  const res = await postNotify(url, body)
  expect(res.status).toBe(501)
  expect(await res.json()).toEqual({ error: 'attachments not supported' })
  expect(notify).not.toHaveBeenCalled()
})

test('/notify takes an attachment', async () => {
  const notify = vi.fn<NotifyFn>()
  const url = await start(vi.fn<RequestFn>(), undefined, notify)
  const res = await postNotify(url, JSON.stringify({ text: 'hi', attachment: ATTACHMENT }))
  expect(res.status).toBe(200)
  expect(notify.mock.calls[0]?.[0].attachment?.content.byteLength).toBe(100_000)
})

test('/request/async asks the bot owner', async () => {
  const { url, messenger } = await startReal({ recipient: '42' })
  expect((await postAsync(url, JSON.stringify(valid))).status).toBe(202)
  expect(messenger.recipients).toEqual(['42'])
})

test('/request/async takes an attachment', async () => {
  const { url, messenger } = await startReal()
  const res = await postAsync(url, JSON.stringify({ ...valid, attachment: ATTACHMENT }))
  expect(res.status).toBe(202)
  expect(messenger.sent).toHaveLength(1)
  await server?.close()
  server = undefined
  const unsupported = await startReal({ maxAttachmentBytes: 0 })
  const refused = await postAsync(
    unsupported.url,
    JSON.stringify({ ...valid, attachment: ATTACHMENT }),
  )
  expect(refused.status).toBe(501)
  expect(await refused.json()).toEqual({ error: 'attachments not supported' })
  expect(unsupported.messenger.sent).toEqual([])
})

test('an attachment over the limit is a 400 with the limit', async () => {
  const url = await start(vi.fn<RequestFn>(), undefined, undefined, NO_AUTH, 10)
  const res = await post(
    url,
    JSON.stringify({
      ...valid,
      attachment: { name: 'a.bin', data: Buffer.alloc(11).toString('base64') },
    }),
  )
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'attachment must be at most 10 bytes' })
})

test('GET /status reports maxAttachmentBytes, 0 without support', async () => {
  let url = await start(vi.fn<RequestFn>(), undefined, undefined, NO_AUTH, 1234)
  expect(await (await fetch(`${url}/status`)).json()).toEqual({
    paired: true,
    bot: 'b',
    maxAttachmentBytes: 1234,
    maxTextLength: 3900,
  })
  await server?.close()
  url = await start(vi.fn<RequestFn>(), undefined, undefined, NO_AUTH, 0)
  expect(await (await fetch(`${url}/status`)).json()).toMatchObject({ maxAttachmentBytes: 0 })
})

test('status reports maxTextLength, and maxOptionCount only when set', async () => {
  const limited = await startReal({ maxTextLength: 1800, maxOptionCount: 25 })
  expect(await (await fetch(`${limited.url}/status`)).json()).toMatchObject({
    maxTextLength: 1800,
    maxOptionCount: 25,
  })
  await server?.close()
  const unlimited = await startReal()
  const body = await (await fetch(`${unlimited.url}/status`)).json()
  expect(body).toMatchObject({ maxTextLength: 3900 })
  expect(body).not.toHaveProperty('maxOptionCount')
})

test('a request over maxOptionCount answers 400', async () => {
  const { url } = await startReal({ maxOptionCount: 25 })
  const options = Array.from({ length: 26 }, (_, index) => `o${index}`)
  const response = await fetch(`${url}/request`, {
    method: 'POST',
    body: JSON.stringify({ text: 'q', options, timeoutOption: 'o0' }),
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'options must have at most 25 entries' })
})

// Voters as sent, the owner `o` when there are none, and `bad` refused.
const resolveTestVoters: ApiBot['resolveVoters'] = (voters) => {
  if (voters === undefined) {
    return { kind: 'voters', voters: ['o'] }
  }
  const invalid = voters.find((voter) => voter === 'bad')
  return invalid === undefined ? { kind: 'voters', voters } : { kind: 'invalid', voter: invalid }
}

const postVote = (url: string, body: unknown) =>
  fetch(`${url}/vote`, { method: 'POST', body: JSON.stringify(body) })

async function waitForSent(messenger: RecordingMessenger, count: number): Promise<void> {
  await vi.waitFor(() => expect(messenger.sent.length).toBeGreaterThanOrEqual(count))
}

test('POST /vote asks every voter and reports the tally', async () => {
  const { url, messenger, service } = await startReal({ resolveVoters: resolveTestVoters })
  const response = postVote(url, { ...valid, voters: ['1', '2', '3'], require: 'majority' })
  await waitForSent(messenger, 3)
  expect(messenger.recipients).toEqual(['1', '2', '3'])
  service.tap(messenger.idOf('1'), 0)
  service.tap(messenger.idOf('2'), 0)
  const res = await response
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    answer: 'Approve',
    timedOut: false,
    approved: true,
    require: 'majority',
    votes: { '1': 'Approve', '2': 'Approve', '3': null },
    rounds: 1,
  })
})

test('POST /vote without voters asks the owner and requires all', async () => {
  const { url, messenger, service } = await startReal({ resolveVoters: resolveTestVoters })
  const response = postVote(url, valid)
  await waitForSent(messenger, 1)
  service.tap(messenger.idOf('o'), 1)
  expect(await (await response).json()).toEqual({
    answer: 'Decline',
    timedOut: false,
    approved: false,
    require: 'all',
    votes: { o: 'Decline' },
    rounds: 1,
  })
})

test('POST /vote re-asks voters who timed out and rejects once the rounds run out', async () => {
  const { url, messenger } = await startReal({ resolveVoters: resolveTestVoters })
  const res = await postVote(url, { ...valid, timeout: 0.1, voters: ['1'], retry: 1 })
  expect(await res.json()).toMatchObject({ approved: false, timedOut: true, rounds: 2 })
  expect(messenger.recipients).toEqual(['1', '1'])
})

test('POST /vote answers 400 for bodies that are not a vote', async () => {
  const { url, messenger } = await startReal({ resolveVoters: resolveTestVoters })
  for (const [body, error] of [
    [{ ...valid, voters: ['1', 'bad'] }, 'invalid user id "bad"'],
    [
      { ...valid, options: ['A', 'B', 'Decline'] },
      'a vote needs exactly two options: approve, then reject',
    ],
    [{ ...valid, timeoutOption: 'Approve' }, 'timeoutOption must be the second option'],
    [{ ...valid, allowText: true }, "a vote can't allow text replies"],
    [{ ...valid, voters: [] }, 'voters must be a non-empty array'],
    [{ ...valid, voters: [' '] }, 'voters must contain only non-empty strings'],
    [{ ...valid, require: 'some' }, 'require must be "all" or "majority"'],
    [{ ...valid, retry: -1 }, 'retry must be an integer 0-100'],
  ] as const) {
    const res = await postVote(url, body)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error })
  }
  expect(messenger.sent).toEqual([])
})

test('POST /vote without voters answers 400 when the provider has no owner', async () => {
  const { url } = await startReal()
  const res = await postVote(url, valid)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({
    error: 'voters is required, since this provider has no owner',
  })
})

test('POST /vote answers 502 naming the voter it could not reach', async () => {
  const { url, messenger } = await startReal({ resolveVoters: resolveTestVoters })
  messenger.failSend = true
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const res = await postVote(url, { ...valid, voters: ['1'] })
  expect(res.status).toBe(502)
  expect(await res.json()).toEqual({ error: 'failed to send message', voter: '1' })
  expect(error).toHaveBeenCalledWith('failed to send message to 1 via b1 (test)')
  error.mockRestore()
})

test('POST /vote answers 503 while unpaired, and GET /vote is 405', async () => {
  const { url } = await startReal({ status: unpaired, resolveVoters: resolveTestVoters })
  expect((await postVote(url, valid)).status).toBe(503)
  const res = await fetch(`${url}/vote`)
  expect(res.status).toBe(405)
  expect(res.headers.get('allow')).toBe('POST')
})

test('POST /request with retry re-asks after a timeout and reports the rounds', async () => {
  const { url, messenger } = await startReal()
  const res = await post(url, JSON.stringify({ ...valid, timeout: 0.1, retry: 2 }))
  expect(await res.json()).toEqual({ answer: 'Decline', timedOut: true, rounds: 3 })
  expect(messenger.finalized.map((message) => message.ending.kind)).toEqual([
    'reasked',
    'reasked',
    'timedOut',
  ])
})

test('POST /request with retry stops once answered', async () => {
  const { url, messenger, service } = await startReal()
  const response = post(url, JSON.stringify({ ...valid, retry: 2 }))
  await waitForSent(messenger, 1)
  service.tap(messenger.idOf(undefined), 0)
  expect(await (await response).json()).toEqual({ answer: 'Approve', timedOut: false, rounds: 1 })
})

test('a bad retry is a 400, and /request/async refuses retry', async () => {
  const { url, messenger } = await startReal()
  for (const retry of [-1, 1.5, 101, '2']) {
    const res = await post(url, JSON.stringify({ ...valid, retry }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'retry must be an integer 0-100' })
  }
  const res = await postAsync(url, JSON.stringify({ ...valid, retry: 1 }))
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: "retry isn't supported on /request/async" })
  expect(messenger.sent).toEqual([])
})
