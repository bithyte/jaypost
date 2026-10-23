import { chmodSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { RequestListener, Server } from 'node:http'
import { Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import { MAX_ATTACHMENT_BYTES } from '../../src/approval/constants.ts'
import { ApprovalService } from '../../src/approval/index.ts'
import type {
  ApprovalRequest,
  MessageReference,
  Messenger,
  RequestResult,
} from '../../src/approval/index.ts'
import { NO_AUTH, NO_CLIENT_TOKEN } from '../../src/auth/index.ts'
import type { ClientToken } from '../../src/auth/index.ts'
import {
  ATTACHMENT_NOT_SUPPORTED_MESSAGE,
  ATTACHMENT_TOO_OLD_MESSAGE,
  BACKGROUND_TOO_OLD_MESSAGE,
  Caller,
  TIMEOUT_TOO_OLD_MESSAGE,
  TOKEN_REJECTED_MESSAGE,
  TOKEN_REQUIRED_MESSAGE,
  toLocalEndpoint,
} from '../../src/client/index.ts'
import type { NotifyRequest } from '../../src/notify/index.ts'
import { createApiServer, createSingleBotRouter } from '../../src/server/index.ts'

const TOKEN = 'A'.repeat(43)
const CALL = { signal: new AbortController().signal }
const ASK = { text: 'ok?', options: ['Approve', 'Decline'], timeoutOption: 'Decline' }
const TIMED_OUT = '{"answer":"Decline","timedOut":true}'
const TIMED_OUT_DONE = { kind: 'done', answer: 'Decline', timedOut: true }
let directory = ''
const servers: Server[] = []

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jaypost-caller-'))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
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

/** Stub that answers `GET /status` with `status` and everything else with `status`/`body`. */
async function startRecordingStub(
  statusBody: string,
  other: { status: number; body: string } = { status: 200, body: '{}' },
): Promise<{ port: number; seen: string[]; bodies: unknown[] }> {
  const seen: string[] = []
  const bodies: unknown[] = []
  const port = await startStub((request, response) => {
    let text = ''
    request.on('data', (chunk) => (text += chunk))
    request.on('end', () => {
      seen.push(`${request.method} ${request.url}`)
      if (text !== '') {
        bodies.push(JSON.parse(text))
      }
      if (request.url === '/status') {
        response.end(statusBody)
        return
      }
      response.statusCode = other.status
      response.end(other.body)
    })
  })
  return { port, seen, bodies }
}

async function startApi(options: { maxAttachmentBytes?: number; notifications?: boolean } = {}) {
  const requests: ApprovalRequest[] = []
  const notifications: NotifyRequest[] = []
  const unexpected = (): never => {
    throw new Error('unexpected call')
  }
  const request = async (request: ApprovalRequest): Promise<RequestResult> => {
    requests.push(request)
    return { kind: 'completed', outcome: { answer: 'Approve', timedOut: false } }
  }
  const service = {
    request,
    start: unexpected,
    get: unexpected,
    waitFor: unexpected,
    cancel: unexpected,
    send: async (sent: ApprovalRequest) => ({
      id: 'q',
      reference: { chatId: 1, messageId: 1 },
      message: sent.message,
      result: Promise.resolve(await request(sent)),
      finalText: () => undefined,
    }),
    close: unexpected,
    update: unexpected,
  }
  const app = createApiServer(
    createSingleBotRouter({
      service,
      status: () => ({ paired: true, bot: 'b' }),
      maxTextLength: 3900,
      providerName: 'test',
      resolveVoters: () => ({ kind: 'noOwner' }),
      auth: NO_AUTH,
      maxAttachmentBytes: options.maxAttachmentBytes ?? 1000,
      notifications: {
        notify: async (notification) => {
          notifications.push(notification)
        },
      },
    }),
  )
  await app.listen({ port: 0, host: '127.0.0.1' })
  servers.push(app.server)
  return { port: (app.server.address() as AddressInfo).port, requests, notifications }
}

function caller(port: number, token: ClientToken = NO_CLIENT_TOKEN, now?: () => number): Caller {
  return new Caller({
    endpoint: toLocalEndpoint(port),
    readToken: () => token,
    ...(now === undefined ? {} : { now }),
  })
}

function clock(values: readonly number[]): () => number {
  let index = 0
  return () => values[index++] ?? Number.NaN
}

function unreachable(port: number): string {
  return `jaypost service not reachable on 127.0.0.1:${port} (run jaypost status)`
}

function failed(reason: string, message: unknown): object {
  return { kind: 'failed', reason, message }
}

const writeFile = (name: string, bytes: Uint8Array): string => {
  const path = join(directory, name)
  writeFileSync(path, bytes)
  return path
}

test('ask returns the answer and sends every field', async () => {
  const { port, requests } = await startApi()
  const result = await caller(port).ask(
    {
      text: 'Deploy?',
      options: ['Approve'],
      allowText: true,
      timeoutOption: 'Approve',
      timeout: 60,
      project: 'api',
      format: 'markdown',
      attachment: { name: 'a.diff', text: 'x' },
    },
    CALL,
  )
  expect(result).toEqual({ kind: 'done', answer: 'Approve', timedOut: false })
  expect(requests[0]).toMatchObject({
    message: { text: expect.stringContaining('Deploy?') },
    options: ['Approve'],
    allowText: true,
    timeoutSeconds: 60,
    project: 'api',
    attachment: { name: 'a.diff', content: new Uint8Array([120]) },
  })
})

test('notify omits unset fields', async () => {
  const { port, bodies } = await startRecordingStub('{"paired":true}')
  expect(await caller(port).notify({ text: 'done' }, CALL)).toEqual({ kind: 'sent' })
  expect(bodies).toEqual([{ text: 'done' }])
})

test('notify delivers a text attachment', async () => {
  const { port, notifications } = await startApi()
  const result = await caller(port).notify(
    { text: 'done', attachment: { name: 'a.diff', text: 'x' } },
    CALL,
  )
  expect(result).toEqual({ kind: 'sent' })
  expect(notifications[0]?.attachment).toEqual({ name: 'a.diff', content: new Uint8Array([120]) })
})

test('an unusable token makes no request', async () => {
  const { port, seen } = await startRecordingStub('{"paired":true}')
  const unusable = caller(port, { kind: 'unusable', message: 'bad token' })
  const expected = failed('unusableToken', 'bad token')
  expect(await unusable.ask(ASK, CALL)).toEqual(expected)
  expect(await unusable.notify({ text: 'x' }, CALL)).toEqual(expected)
  expect(await unusable.status(CALL)).toEqual(expected)
  expect(seen).toEqual([])
})

test('readToken runs once per operation', async () => {
  const { port, seen } = await startRecordingStub('{"paired":true,"maxAttachmentBytes":100}', {
    status: 200,
    body: TIMED_OUT,
  })
  const readToken = vi.fn((): ClientToken => NO_CLIENT_TOKEN)
  const result = await new Caller({ endpoint: toLocalEndpoint(port), readToken }).ask(
    { ...ASK, attachment: { name: 'a', text: 'x' } },
    CALL,
  )
  expect(result.kind).toBe('done')
  expect(readToken).toHaveBeenCalledTimes(1)
  expect(seen).toEqual(['GET /status', 'POST /request'])
})

test('status parses the daemon status', async () => {
  const { port } = await startRecordingStub('{"paired":true,"bot":"b","maxTextLength":3900}')
  expect(await caller(port).status(CALL)).toEqual({
    kind: 'status',
    status: { paired: true, bot: 'b', maxTextLength: 3900 },
  })
})

test('an unreadable status is unreadable', async () => {
  const { port } = await startRecordingStub('{"nope":1}')
  expect(await caller(port).status(CALL)).toEqual(
    failed('unreadable', 'jaypost service sent an unreadable answer: {"nope":1}'),
  )
})

test('a status that never answers is an http timeout', async () => {
  const port = await startStub(() => {})
  expect(await caller(port).status({ ...CALL, timeoutMs: 50 })).toEqual(
    failed('httpTimeout', "jaypost service didn't answer within 0.05 s"),
  )
})

test.each([
  [400, '{"error":"options must be unique"}', 'rejected', 'options must be unique'],
  [501, '{"error":"x"}', 'notSupported', 'notifications not supported by this provider'],
  [501, '{"error":"attachments not supported"}', 'notSupported', ATTACHMENT_NOT_SUPPORTED_MESSAGE],
  [503, '{"error":"x"}', 'notPaired', "jaypost isn't paired yet (run jaypost status)"],
  [502, '{"error":"x"}', 'sendFailed', "couldn't send the message to the user"],
  [
    500,
    '{"error":"internal server error"}',
    'unexpected',
    'jaypost service error 500: internal server error',
  ],
  [404, '<html>nope</html>\n', 'unexpected', 'jaypost service error 404: <html>nope</html>'],
] as const)('ask maps status %i to %s', async (status, body, reason, message) => {
  const port = await startStub(reply(status, body))
  expect(await caller(port).ask(ASK, CALL)).toEqual(failed(reason, message))
})

test.each([
  [
    404,
    '{"error":"not found"}',
    'tooOld',
    'jaypost service is too old for notifications (run jaypost init to upgrade)',
  ],
  [501, '{"error":"x"}', 'notSupported', 'notifications not supported by this provider'],
  [501, '{"error":"attachments not supported"}', 'notSupported', ATTACHMENT_NOT_SUPPORTED_MESSAGE],
] as const)('notify maps status %i to %s', async (status, body, reason, message) => {
  const port = await startStub(reply(status, body))
  expect(await caller(port).notify({ text: 'x' }, CALL)).toEqual(failed(reason, message))
})

test('an unreachable port is unreachable', async () => {
  const port = await freePort()
  expect(await caller(port).ask(ASK, CALL)).toEqual(failed('unreachable', unreachable(port)))
})

test('a fractional timeout reads as unreachable instead of throwing', async () => {
  const port = await freePort()
  expect(await caller(port).ask({ ...ASK, timeout: 1.0005 }, CALL)).toEqual(
    failed('unreachable', unreachable(port)),
  )
})

test('a connection reset mid-request reads as unreachable', async () => {
  const port = await startStub((request) => {
    request.socket.destroy()
  })
  expect(await caller(port).ask(ASK, CALL)).toEqual(failed('unreachable', unreachable(port)))
})

test('a caller abort mid-request is cancelled and closes the socket', async () => {
  const controller = new AbortController()
  let closed!: Promise<void>
  let seen!: () => void
  const requestSeen = new Promise<void>((resolve) => (seen = resolve))
  const port = await startStub((request) => {
    closed = new Promise<void>((resolve) => request.on('close', resolve))
    seen()
  })
  const pending = caller(port).ask(ASK, { signal: controller.signal })
  await requestSeen
  controller.abort()
  expect(await pending).toEqual(failed('cancelled', 'cancelled'))
  await closed
})

test('a 401 explains whether a token was sent and never echoes it', async () => {
  const port = await startStub(reply(401, '{"error":"unauthorized"}'))
  expect(await caller(port).ask(ASK, CALL)).toEqual(failed('unauthorized', TOKEN_REQUIRED_MESSAGE))
  const result = await caller(port, { kind: 'token', token: TOKEN, source: 'env' }).ask(ASK, CALL)
  expect(result).toEqual(failed('unauthorized', TOKEN_REJECTED_MESSAGE))
  expect(JSON.stringify(result)).not.toContain(TOKEN)
})

test('the token is sent as a bearer header only when there is one', async () => {
  const seen: (string | undefined)[] = []
  const port = await startStub((request, response) => {
    seen.push(request.headers.authorization)
    response.end(TIMED_OUT)
  })
  await caller(port, { kind: 'token', token: TOKEN, source: 'file' }).ask(ASK, CALL)
  await caller(port).ask(ASK, CALL)
  expect(seen).toEqual([`Bearer ${TOKEN}`, undefined])
})

test.each([
  ['a non-json body', 'not json', 'jaypost service sent an unreadable answer: not json'],
  [
    'a wrong shaped body',
    '{"answer":1}',
    'jaypost service sent an unreadable answer: {"answer":1}',
  ],
])('%s is unreadable', async (_name, body, message) => {
  const port = await startStub(reply(200, body))
  expect(await caller(port).ask(ASK, CALL)).toEqual(failed('unreadable', message))
})

// Global fetch has a fixed 300 s headers timeout that drops an ask waiting the full 300 s; a real
// 300 s wait is too slow for a test, so this pins the client to not going through fetch at all.
test('does not use global fetch', async () => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('fetch must not be used')))
  const port = await startStub(reply(200, '{"ok":true}'))
  expect(await caller(port).notify({ text: 'x' }, CALL)).toEqual({ kind: 'sent' })
})

test('sockets use tcp keepalive', async () => {
  const spy = vi.spyOn(Socket.prototype, 'setKeepAlive')
  const port = await startStub(reply(200, '{}'))
  await caller(port).notify({ text: 'x' }, CALL)
  expect(spy).toHaveBeenCalledWith(true, 60_000)
})

async function askWith(
  timeout: number | undefined,
  body: string,
  times: readonly number[],
): Promise<object> {
  const port = await startStub(reply(200, body))
  return caller(port, NO_CLIENT_TOKEN, clock(times)).ask(
    { ...ASK, ...(timeout === undefined ? {} : { timeout }) },
    CALL,
  )
}

test('an early timeout on a request over 300 s means the service is too old', async () => {
  expect(await askWith(900, TIMED_OUT, [0, 300_000])).toEqual(
    failed('tooOld', TIMEOUT_TOO_OLD_MESSAGE),
  )
})

test('a timeout at the requested time is a normal timeout', async () => {
  expect(await askWith(900, TIMED_OUT, [0, 900_000])).toEqual(TIMED_OUT_DONE)
})

test('a request over the cap that times out at the cap is a normal timeout', async () => {
  expect(await askWith(108_000, TIMED_OUT, [0, 86_400_000])).toEqual(TIMED_OUT_DONE)
})

test('an early answer that is not a timeout passes through', async () => {
  expect(await askWith(900, '{"answer":"Decline","timedOut":false}', [0, 1000])).toEqual({
    kind: 'done',
    answer: 'Decline',
    timedOut: false,
  })
})

test.each([300, undefined])('requests of 300 s or less are never flagged (%s)', async (timeout) => {
  expect(await askWith(timeout, TIMED_OUT, [0, 1000])).toEqual(TIMED_OUT_DONE)
})

test('a path attachment is read and sent as base64 with its basename', async () => {
  const { port, requests } = await startApi()
  const path = writeFile('build.log', new Uint8Array([0, 1, 2]))
  await caller(port).ask({ ...ASK, attachment: { path } }, CALL)
  expect(requests[0]?.attachment).toEqual({ name: 'build.log', content: new Uint8Array([0, 1, 2]) })
})

test('a path with a name uses the name', async () => {
  const { port, requests } = await startApi()
  const path = writeFile('build.log', new Uint8Array([0, 1, 2]))
  await caller(port).ask({ ...ASK, attachment: { path, name: 'out.txt' } }, CALL)
  expect(requests[0]?.attachment?.name).toBe('out.txt')
})

test('a relative path resolves against the working directory', async () => {
  const { port, requests } = await startApi()
  const path = writeFile('rel.bin', new Uint8Array([255]))
  await caller(port).ask({ ...ASK, attachment: { path: relative(process.cwd(), path) } }, CALL)
  expect(requests[0]?.attachment).toEqual({ name: 'rel.bin', content: new Uint8Array([255]) })
})

test('bytes are sent as given', async () => {
  const { port, requests } = await startApi()
  await caller(port).ask(
    { ...ASK, attachment: { name: 'a.bin', data: new Uint8Array([255]) } },
    CALL,
  )
  expect(requests[0]?.attachment).toEqual({ name: 'a.bin', content: new Uint8Array([255]) })
})

test('stdin is read to the end', async () => {
  const { port, requests } = await startApi()
  const stream = Readable.from([Buffer.from('ab'), 'c'])
  await caller(port).ask({ ...ASK, attachment: { stream, name: 'x.txt' } }, CALL)
  expect(requests[0]?.attachment).toEqual({
    name: 'x.txt',
    content: new Uint8Array(Buffer.from('abc')),
  })
})

test('a missing file fails without calling the service', async () => {
  const { port, seen } = await startRecordingStub('{"paired":true,"maxAttachmentBytes":1000}')
  const path = join(directory, 'nope.txt')
  expect(await caller(port).ask({ ...ASK, attachment: { path } }, CALL)).toEqual(
    failed('attachment', `attachment ${JSON.stringify(path)} not found`),
  )
  expect(seen).toEqual([])
})

test('a directory is not a file', async () => {
  const { port, seen } = await startRecordingStub('{"paired":true,"maxAttachmentBytes":1000}')
  const path = join(directory, 'sub')
  mkdirSync(path)
  expect(await caller(port).notify({ text: 'x', attachment: { path } }, CALL)).toEqual(
    failed('attachment', `attachment ${JSON.stringify(path)} is not a file`),
  )
  expect(seen).toEqual([])
})

test('a file over the cap fails from stat without reading it', async () => {
  const { port } = await startRecordingStub('{"paired":true,"maxAttachmentBytes":1000}')
  const path = writeFile('big.bin', new Uint8Array())
  truncateSync(path, MAX_ATTACHMENT_BYTES + 1)
  chmodSync(path, 0o000)
  expect(await caller(port).ask({ ...ASK, attachment: { path } }, CALL)).toEqual(
    failed(
      'attachment',
      `attachment ${JSON.stringify(path)} is over ${MAX_ATTACHMENT_BYTES} bytes`,
    ),
  )
})

test('an unreadable file reports the reason', async () => {
  const { port } = await startRecordingStub('{"paired":true,"maxAttachmentBytes":1000}')
  writeFileSync(join(directory, 'file'), 'x')
  const path = join(directory, 'file', 'x')
  expect(await caller(port).ask({ ...ASK, attachment: { path } }, CALL)).toEqual(
    failed('attachment', expect.stringMatching(/^couldn't read attachment ".*": /)),
  )
})

test('stdin over the cap fails and stops reading', async () => {
  const { port } = await startRecordingStub('{"paired":true,"maxAttachmentBytes":1000}')
  let pulled = 0
  async function* zeros(): AsyncGenerator<Uint8Array> {
    for (;;) {
      pulled += 1
      yield new Uint8Array(1_048_576)
    }
  }
  const result = await caller(port).ask(
    { ...ASK, attachment: { stream: zeros(), name: 'x' } },
    CALL,
  )
  expect(result).toEqual(
    failed('attachment', `attachment from stdin is over ${MAX_ATTACHMENT_BYTES} bytes`),
  )
  expect(pulled).toBeLessThanOrEqual(11)
})

test('an abort during a stalled stdin read is cancelled', async () => {
  const { port } = await startRecordingStub('{"paired":true,"maxAttachmentBytes":1000}')
  const controller = new AbortController()
  const stalled: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
  }
  const pending = caller(port).ask(
    { ...ASK, attachment: { stream: stalled, name: 'x' } },
    { signal: controller.signal },
  )
  controller.abort()
  expect(await pending).toEqual(
    failed('cancelled', expect.stringMatching(/^couldn't read attachment from stdin: /)),
  )
})

test('an old service without maxAttachmentBytes fails with the upgrade message', async () => {
  const { port } = await startRecordingStub('{"paired":true}')
  expect(await caller(port).ask({ ...ASK, attachment: { name: 'a', text: 'x' } }, CALL)).toEqual(
    failed('tooOld', ATTACHMENT_TOO_OLD_MESSAGE),
  )
})

test('a provider without attachment support fails', async () => {
  const { port } = await startRecordingStub('{"paired":true,"maxAttachmentBytes":0}')
  expect(await caller(port).ask({ ...ASK, attachment: { name: 'a', text: 'x' } }, CALL)).toEqual(
    failed('notSupported', ATTACHMENT_NOT_SUPPORTED_MESSAGE),
  )
})

test('a file over the service limit fails before uploading', async () => {
  const { port, seen } = await startRecordingStub('{"paired":true,"maxAttachmentBytes":2}')
  const path = writeFile('three.bin', new Uint8Array([1, 2, 3]))
  expect(await caller(port).ask({ ...ASK, attachment: { path } }, CALL)).toEqual(
    failed('attachment', `attachment ${JSON.stringify(path)} is over 2 bytes`),
  )
  expect(seen).toEqual(['GET /status'])
})

test('an attachment against an unreachable service is unreachable', async () => {
  const port = await freePort()
  expect(await caller(port).ask({ ...ASK, attachment: { name: 'a', text: 'x' } }, CALL)).toEqual(
    failed('unreachable', unreachable(port)),
  )
})

class RecordingMessenger implements Messenger {
  sent: { id: string }[] = []

  async sendRequest(id: string): Promise<MessageReference> {
    this.sent.push({ id })
    return { chatId: 1, messageId: 2 }
  }

  async finalize(): Promise<void> {}
}

async function startBackgroundApi() {
  const messenger = new RecordingMessenger()
  const service = new ApprovalService(messenger)
  const app = createApiServer(
    createSingleBotRouter({
      service,
      status: () => ({ paired: true, bot: 'b' }),
      maxTextLength: 3900,
      providerName: 'test',
      resolveVoters: () => ({ kind: 'noOwner' }),
      auth: NO_AUTH,
      maxAttachmentBytes: 1000,
    }),
  )
  await app.listen({ port: 0, host: '127.0.0.1' })
  servers.push(app.server)
  return { port: (app.server.address() as AddressInfo).port, service, messenger }
}

async function startPending(): Promise<{
  port: number
  id: string
  service: ApprovalService
  asked: Awaited<ReturnType<Caller['askInBackground']>>
}> {
  const { port, service } = await startBackgroundApi()
  const asked = await caller(port).askInBackground(
    { ...ASK, options: ['Approve'], timeoutOption: 'Approve' },
    CALL,
  )
  return { port, id: asked.kind === 'pending' ? asked.id : '', service, asked }
}

test('askInBackground then waitFor returns the answer', async () => {
  const { port, id, service, asked } = await startPending()
  expect(asked).toEqual({ kind: 'pending', id: expect.any(String), expiresAt: expect.any(String) })
  service.tap(id, 0)
  expect(await caller(port).waitFor(id, CALL)).toEqual({
    kind: 'done',
    id,
    answer: 'Approve',
    timedOut: false,
  })
})

test('waitFor reports pending once waitSeconds passes', async () => {
  const { port, id } = await startPending()
  expect(await caller(port).waitFor(id, { ...CALL, waitSeconds: 0.2 })).toEqual({
    kind: 'pending',
    id,
    expiresAt: expect.any(String),
  })
})

test('waitFor with waitSeconds 0 checks once', async () => {
  const seen: string[] = []
  const port = await startStub((request, response) => {
    seen.push(`${request.method} ${request.url}`)
    response.end('{"id":"x","state":"pending","expiresAt":"2026-10-21T06:00:00.000Z"}')
  })
  expect(await caller(port).waitFor('x', { ...CALL, waitSeconds: 0 })).toEqual({
    kind: 'pending',
    id: 'x',
    expiresAt: '2026-10-21T06:00:00.000Z',
  })
  expect(seen).toEqual(['GET /request/x?wait=0'])
})

test('waitFor on an unknown id is unknownRequest', async () => {
  const seen: string[] = []
  const port = await startStub((request, response) => {
    seen.push(`${request.method} ${request.url}`)
    response.statusCode = 404
    response.end('{"error":"not found"}')
  })
  expect(await caller(port).waitFor('a/b', { ...CALL, waitSeconds: 0 })).toEqual(
    failed(
      'unknownRequest',
      "jaypost doesn't know request a%2Fb (the service restarted, or the answer expired after 24 h)",
    ),
  )
  expect(seen).toEqual(['GET /request/a%2Fb?wait=0'])
})

test('cancel returns cancelled and waitFor then sees it', async () => {
  const { port, id } = await startPending()
  expect(await caller(port).cancel(id, CALL)).toEqual({ kind: 'cancelled', id })
  expect(await caller(port).waitFor(id, CALL)).toEqual({ kind: 'cancelled', id })
})

test('askInBackground on an old service is tooOld', async () => {
  const port = await startStub(reply(404, '{"error":"not found"}'))
  expect(await caller(port).askInBackground(ASK, CALL)).toEqual(
    failed('tooOld', BACKGROUND_TOO_OLD_MESSAGE),
  )
})

test('askInBackground leaves retry out of the body', async () => {
  const { port } = await startBackgroundApi()
  expect(await caller(port).askInBackground({ ...ASK, retry: 2 }, CALL)).toEqual({
    kind: 'pending',
    id: expect.any(String),
    expiresAt: expect.any(String),
  })
})

test('an unreadable state body is unreadable', async () => {
  const port = await startStub(reply(200, '{"id":"x","state":"pending"}'))
  expect(await caller(port).waitFor('x', { ...CALL, waitSeconds: 0 })).toEqual(
    failed('unreadable', 'jaypost service sent an unreadable answer: {"id":"x","state":"pending"}'),
  )
  expect(await caller(port).askInBackground(ASK, CALL)).toEqual(
    failed('unreadable', 'jaypost service sent an unreadable answer: {"id":"x","state":"pending"}'),
  )
  expect(await caller(port).cancel('x', CALL)).toEqual(
    failed('unreadable', 'jaypost service sent an unreadable answer: {"id":"x","state":"pending"}'),
  )
})

test('an unusable token makes no background request', async () => {
  const { port, seen } = await startRecordingStub('{"paired":true}')
  const unusable = caller(port, { kind: 'unusable', message: 'bad token' })
  const expected = failed('unusableToken', 'bad token')
  expect(await unusable.askInBackground(ASK, CALL)).toEqual(expected)
  expect(await unusable.waitFor('x', CALL)).toEqual(expected)
  expect(await unusable.cancel('x', CALL)).toEqual(expected)
  expect(seen).toEqual([])
})
