import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type {
  Attachment,
  FormattedText,
  MessageEnding,
  MessageReference,
  Messenger,
  Notifier,
} from '@jaypost/core'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { afterEach, expect, test, vi } from 'vite-plus/test'
import { ApprovalService, MAX_ATTACHMENT_BYTES, NotificationService } from '@jaypost/core'
import { formatWaitTitle, runSendNotify, runSendRequest } from '../../src/commands/index.ts'
import type { SendDeps } from '../../src/commands/index.ts'
import { NO_AUTH, NO_CLIENT_TOKEN } from '@jaypost/store'
import type { ApiAuth, ClientToken } from '@jaypost/store'
import { TOKEN_REJECTED_MESSAGE, toLocalEndpoint } from '@jaypost/client'
import { SILENT_PROGRESS } from '../../src/progress/index.ts'
import type { Progress } from '../../src/progress/index.ts'
import { PROVIDERS, telegramProvider } from '@jaypost/providers'
import { createApiServer, createSingleBotRouter } from '@jaypost/service'
import { createRecordingProgress } from '../progress/recording.ts'

const TEST_VERSION = '1.2.3'

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
const REFERENCE: MessageReference = { chatId: 1, messageId: 2 }

class RecordingMessenger implements Messenger {
  sent: { id: string; text: string }[] = []
  recipients: (string | undefined)[] = []
  messages: FormattedText[] = []
  attachments: (Attachment | undefined)[] = []
  finalized: MessageEnding[] = []
  failSend = false
  /** When set, `sendRequest` waits for it before resolving. */
  gate: Promise<void> | undefined

  async sendRequest(
    id: string,
    message: FormattedText,
    _options: readonly string[],
    _allowText: boolean,
    attachment: Attachment | undefined,
    recipient: string | undefined,
  ): Promise<MessageReference> {
    if (this.failSend) {
      throw new Error('telegram down')
    }
    this.sent.push({ id, text: message.text })
    this.recipients.push(recipient)
    this.attachments.push(attachment)
    this.messages.push(message)
    await this.gate
    return REFERENCE
  }

  async finalize(
    _reference: MessageReference,
    _message: FormattedText,
    settlement: MessageEnding,
  ): Promise<void> {
    this.finalized.push(settlement)
  }
}

class RecordingNotifier implements Notifier {
  sent: string[] = []
  messages: FormattedText[] = []
  attachments: (Attachment | undefined)[] = []

  sendNotification = async (
    _id: string,
    message: FormattedText,
    _options: unknown,
    attachment?: Attachment,
  ): Promise<MessageReference> => {
    this.sent.push(message.text)
    this.attachments.push(attachment)
    this.messages.push(message)
    return REFERENCE
  }
}

const servers: FastifyInstance[] = []
const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function startApi(
  options: {
    readonly notifications?: boolean
    readonly auth?: ApiAuth
    readonly maxAttachmentBytes?: number
    readonly provider?: string
  } = {},
) {
  const messenger = new RecordingMessenger()
  const notifier = new RecordingNotifier()
  const service = new ApprovalService(messenger)
  const server = createApiServer(
    createSingleBotRouter({
      version: TEST_VERSION,
      recipient: () => undefined,
      service,
      status: () => ({
        paired: true,
        bot: 'b',
        ...(options.provider === undefined ? {} : { provider: options.provider }),
      }),
      maxTextLength: 3900,
      maxAttachmentBytes: options.maxAttachmentBytes ?? MAX_ATTACHMENT_BYTES,
      providerName: 'test',
      resolveVoters: (voters) => ({ kind: 'voters', voters: voters ?? ['owner'] }),
      describe: () => ({ provider: 'test', displayName: 'test' }),
      rejectForKeys: () => undefined,
      auth: options.auth ?? NO_AUTH,
      ...(options.notifications === false
        ? {}
        : { notifications: new NotificationService(notifier) }),
    }),
  )
  servers.push(server)
  await server.listen({ port: 0, host: '127.0.0.1' })
  const { port } = server.server.address() as AddressInfo
  return { port, service, messenger, notifier }
}

function createDeps(
  port: number,
  signal = new AbortController().signal,
  token: ClientToken = NO_CLIENT_TOKEN,
  extra: Partial<SendDeps> = {},
) {
  const out: string[] = []
  const errors: string[] = []
  const deps: SendDeps = {
    endpoint: toLocalEndpoint(port),
    signal,
    token,
    print: (text) => out.push(text),
    printError: (text) => errors.push(text),
    progress: SILENT_PROGRESS,
    providers: PROVIDERS,
    ...extra,
  }
  return { deps, out, errors }
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met within 5 s')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

const ASK = { text: 'Deploy?', options: ['Approve', 'Decline'], timeoutOption: 'Decline' }

/** A service that answers every call with `status` and `body`, as an older jaypost would. */
async function startFakeService(status: number, body: unknown): Promise<number> {
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  fakeServers.push(server)
  return (server.address() as AddressInfo).port
}

/** A service that records each request body and answers `{"ok":true}`. */
async function startRecordingService(): Promise<{ port: number; bodies: unknown[] }> {
  const bodies: unknown[] = []
  const server = createServer((request, response) => {
    let text = ''
    request.on('data', (chunk) => (text += chunk))
    request.on('end', () => {
      if (text !== '') {
        bodies.push(JSON.parse(text))
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  fakeServers.push(server)
  return { port: (server.address() as AddressInfo).port, bodies }
}

const fakeServers: Server[] = []
afterEach(async () => {
  await Promise.all(
    fakeServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

test('request prints the tapped answer', async () => {
  const { port, service, messenger } = await startApi()
  const { deps, out, errors } = createDeps(port)
  const pending = runSendRequest({ ...ASK, project: 'api' }, deps)
  await waitFor(() => messenger.sent.length === 1)
  const [sent] = messenger.sent
  expect(sent?.text).toBe('[api]\n\nDeploy?')
  service.tap(sent?.id ?? '', 0)
  expect(await pending).toBe(0)
  expect(out).toEqual(['Approve'])
  expect(errors).toEqual([])
})

test('request --allow-text prints the typed reply', async () => {
  const { port, service, messenger } = await startApi()
  const { deps, out, errors } = createDeps(port)
  const pending = runSendRequest(
    { text: 'Which branch?', allowText: true, timeoutOption: 'main' },
    deps,
  )
  await waitFor(() => messenger.sent.length === 1)
  expect(service.reply(messenger.sent[0]?.id ?? '', 'feature/x')).toBe('accepted')
  expect(await pending).toBe(0)
  expect(out).toEqual(['feature/x'])
  expect(errors).toEqual([])
})

test('request on timeout prints the timeout option', async () => {
  const { port } = await startApi()
  const { deps, out } = createDeps(port)
  expect(await runSendRequest({ ...ASK, timeout: 0.2 }, deps)).toBe(0)
  expect(out).toEqual(['Decline'])
})

test('request --json prints answer and timedOut', async () => {
  const { port } = await startApi()
  const { deps, out } = createDeps(port)
  expect(await runSendRequest({ ...ASK, timeout: 0.2, json: true }, deps)).toBe(0)
  expect(out).toEqual(['{"answer":"Decline","timedOut":true}'])
})

test('request abort cancels the telegram message', async () => {
  const { port, messenger } = await startApi()
  const controller = new AbortController()
  const { deps, errors } = createDeps(port, controller.signal)
  const pending = runSendRequest(ASK, deps)
  await waitFor(() => messenger.sent.length === 1)
  controller.abort()
  expect(await pending).toBe(1)
  expect(errors).toEqual(['jaypost: cancelled'])
  await waitFor(() => messenger.finalized.length === 1)
  expect(messenger.finalized).toEqual([{ kind: 'cancelled' }])
})

test('request validation error goes to stderr', async () => {
  const { port } = await startApi()
  const { deps, out, errors } = createDeps(port)
  expect(await runSendRequest({ ...ASK, timeoutOption: 'Maybe' }, deps)).toBe(1)
  expect(out).toEqual([])
  expect(errors).toHaveLength(1)
  expect(errors[0]).toMatch(/^jaypost: .*timeoutOption/)
})

test('notify forwards deleteAfter as given', async () => {
  const { port, bodies } = await startRecordingService()
  const { deps } = createDeps(port)
  expect(await runSendNotify({ text: 'hi', deleteAfter: '300' }, deps)).toBe(0)
  expect(bodies).toEqual([{ text: 'hi', deleteAfter: '300' }])
})

test('notify exits 1 with the service message on a bad deleteAfter', async () => {
  const { port } = await startApi()
  const { deps, errors } = createDeps(port)
  expect(await runSendNotify({ text: 'hi', deleteAfter: '5m' }, deps)).toBe(1)
  expect(errors.join('\n')).toContain(
    'deleteAfter must be a positive number of seconds or an ISO 8601 timestamp with a timezone',
  )
})

test('notify sends and prints nothing', async () => {
  const { port, notifier } = await startApi()
  const { deps, out, errors } = createDeps(port)
  expect(await runSendNotify({ text: 'done', project: 'api' }, deps)).toBe(0)
  expect(notifier.sent).toEqual(['[api]\n\ndone'])
  expect(out).toEqual([])
  expect(errors).toEqual([])
})

test('a live send notify says it was sent', async () => {
  const { port } = await startApi({ provider: 'telegram' })
  const { progress, events } = createRecordingProgress()
  const { deps, out, errors } = createDeps(port, undefined, undefined, { progress })
  expect(await runSendNotify({ text: 'done' }, deps)).toBe(0)
  expect(events).toEqual(['done:Sent to Telegram'])
  expect(out).toEqual([])
  expect(errors).toEqual([])
})

test('send notify off a terminal prints nothing', async () => {
  const { port } = await startApi()
  const { progress, events } = createRecordingProgress('silent')
  const { deps, out, errors } = createDeps(port, undefined, undefined, { progress })
  expect(await runSendNotify({ text: 'done' }, deps)).toBe(0)
  expect(events).toEqual([])
  expect(out).toEqual([])
  expect(errors).toEqual([])
})

test('notify without provider support fails', async () => {
  const { port } = await startApi({ notifications: false })
  const { deps, errors } = createDeps(port)
  expect(await runSendNotify({ text: 'done' }, deps)).toBe(1)
  expect(errors).toEqual(['jaypost: notifications not supported by this provider'])
})

test('service down fails with a hint', async () => {
  const port = await freePort()
  const { deps, errors } = createDeps(port)
  expect(await runSendNotify({ text: 'done' }, deps)).toBe(1)
  expect(errors).toEqual([
    `jaypost: jaypost service not reachable on 127.0.0.1:${port} (run jaypost status)`,
  ])
})

test('request sends the token', async () => {
  const { port, service, messenger } = await startApi({ auth: { kind: 'token', token: TOKEN } })
  const { deps, out, errors } = createDeps(port, undefined, {
    kind: 'token',
    token: TOKEN,
    source: 'env',
  })
  const pending = runSendRequest(ASK, deps)
  await waitFor(() => messenger.sent.length === 1)
  service.tap(messenger.sent[0]?.id ?? '', 0)
  expect(await pending).toBe(0)
  expect(out).toEqual(['Approve'])
  expect(errors).toEqual([])
})

test('an unusable token fails without calling the service', async () => {
  const { port, messenger } = await startApi()
  const { deps, out, errors } = createDeps(port, undefined, {
    kind: 'unusable',
    message: 'bad token here',
  })
  expect(await runSendRequest(ASK, deps)).toBe(1)
  expect(await runSendNotify({ text: 'hi' }, deps)).toBe(1)
  expect(out).toEqual([])
  expect(errors).toEqual(['jaypost: bad token here', 'jaypost: bad token here'])
  expect(messenger.sent).toEqual([])
})

test('a wrong token prints the rejected message', async () => {
  const { port, messenger } = await startApi({ auth: { kind: 'token', token: TOKEN } })
  const { deps, errors } = createDeps(port, undefined, {
    kind: 'token',
    token: `${TOKEN}x`,
    source: 'file',
  })
  expect(await runSendRequest(ASK, deps)).toBe(1)
  expect(errors).toEqual([`jaypost: ${TOKEN_REJECTED_MESSAGE}`])
  expect(messenger.sent).toEqual([])
})

test('request --format markdown reaches the provider as spans', async () => {
  const { port, service, messenger } = await startApi()
  const { deps } = createDeps(port)
  const pending = runSendRequest({ ...ASK, text: 'Run `ls`?', format: 'markdown' }, deps)
  await waitFor(() => messenger.sent.length === 1)
  expect(messenger.messages[0]).toEqual({
    text: 'Run ls?',
    spans: [{ kind: 'code', offset: 4, length: 2 }],
  })
  service.tap(messenger.sent[0]?.id ?? '', 0)
  expect(await pending).toBe(0)
})

test('notify passes format', async () => {
  const { port, notifier } = await startApi()
  const { deps } = createDeps(port)
  expect(await runSendNotify({ text: 'Run `ls`?', format: 'markdown' }, deps)).toBe(0)
  expect(notifier.messages).toEqual([
    { text: 'Run ls?', spans: [{ kind: 'code', offset: 4, length: 2 }] },
  ])
})

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'jaypost-send-'))
  directories.push(directory)
  return directory
}

test('request with a file attachment delivers it', async () => {
  const { port, service, messenger } = await startApi()
  const path = join(createTempDirectory(), 'report.txt')
  writeFileSync(path, 'all green')
  const { deps, out, errors } = createDeps(port)
  const pending = runSendRequest({ ...ASK, attachment: { path } }, deps)
  await waitFor(() => messenger.sent.length === 1)
  service.tap(messenger.sent[0]?.id ?? '', 0)
  expect(await pending).toBe(0)
  expect(out).toEqual(['Approve'])
  expect(errors).toEqual([])
  const [attachment] = messenger.attachments
  expect(attachment?.name).toBe('report.txt')
  expect(Buffer.from(attachment?.content ?? []).toString()).toBe('all green')
})

test('notify with a stdin attachment delivers it', async () => {
  const { port, notifier } = await startApi()
  const { deps, errors } = createDeps(port)
  const attachment = {
    stream: Readable.from(['log line\n']),
    name: 'attachment.txt',
  }
  expect(await runSendNotify({ text: 'done', attachment }, deps)).toBe(0)
  expect(errors).toEqual([])
  const [sent] = notifier.attachments
  expect(sent?.name).toBe('attachment.txt')
  expect(Buffer.from(sent?.content ?? []).toString()).toBe('log line\n')
})

test('a missing attachment prints the reason and exits 1', async () => {
  const { port, messenger, notifier } = await startApi()
  const path = join(createTempDirectory(), 'missing.txt')
  const { deps, errors } = createDeps(port)
  expect(await runSendNotify({ text: 'done', attachment: { path } }, deps)).toBe(1)
  expect(await runSendRequest({ ...ASK, attachment: { path } }, deps)).toBe(1)
  expect(errors).toEqual([
    `jaypost: attachment ${JSON.stringify(path)} not found`,
    `jaypost: attachment ${JSON.stringify(path)} not found`,
  ])
  expect(notifier.sent).toEqual([])
  expect(messenger.sent).toEqual([])
})

const ROOT = new URL('../../../..', import.meta.url).pathname

type Cli = {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

// Async spawn: the API server runs in this process, so a blocking spawnSync would deadlock.
function runCli(args: readonly string[], port: number, stdin?: Readable | string): Promise<Cli> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['apps/cli/src/cli.ts', ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: createTempDirectory(),
        JAYPOST_URL: `http://127.0.0.1:${port}`,
        JAYPOST_TOKEN: '',
        JAYPOST_BOT: '',
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    // the child may exit before reading everything (size cap)
    child.stdin.on('error', () => {})
    if (typeof stdin === 'string') {
      child.stdin.end(stdin)
    } else if (stdin === undefined) {
      child.stdin.end()
    } else {
      stdin.pipe(child.stdin)
    }
  })
}

test('request --attach sends the file', async () => {
  const { port, service, messenger } = await startApi()
  const path = join(createTempDirectory(), 'notes.md')
  writeFileSync(path, '# notes')
  const pending = runCli(['request', 'Deploy?', '-o', 'Yes', '-d', 'No', '--attach', path], port)
  await waitFor(() => messenger.sent.length === 1)
  service.tap(messenger.sent[0]?.id ?? '', 0)
  expect(await pending).toEqual({ code: 0, stdout: 'Yes\n', stderr: '' })
  expect(messenger.attachments[0]?.name).toBe('notes.md')
  expect(Buffer.from(messenger.attachments[0]?.content ?? []).toString()).toBe('# notes')
})

test('notify --attach - reads stdin with the default name', async () => {
  const { port, notifier } = await startApi()
  const result = await runCli(['notify', 'done', '--attach', '-'], port, 'hello')
  expect(result).toEqual({ code: 0, stdout: '', stderr: '' })
  expect(notifier.attachments[0]?.name).toBe('attachment.txt')
  expect(Buffer.from(notifier.attachments[0]?.content ?? []).toString()).toBe('hello')
})

test('notify --attach - --attach-name uses the name', async () => {
  const { port, notifier } = await startApi()
  const args = ['notify', 'done', '--attach', '-', '--attach-name', 'changes.diff']
  const result = await runCli(args, port, 'diff')
  expect(result.code).toBe(0)
  expect(notifier.attachments[0]?.name).toBe('changes.diff')
})

test('notify --attach - stops at the size cap on an endless stdin', async () => {
  const { port, notifier } = await startApi()
  const endless = Readable.from(
    (function* () {
      while (true) {
        yield Buffer.alloc(65_536)
      }
    })(),
  )
  const result = await runCli(['notify', 'done', '--attach', '-'], port, endless)
  endless.destroy()
  expect(result.code).toBe(1)
  expect(result.stderr).toBe(
    `jaypost: attachment from stdin is over ${MAX_ATTACHMENT_BYTES} bytes\n`,
  )
  expect(notifier.sent).toEqual([])
})

test('a vote goes through the service and exits 0 when approved', async () => {
  const { port, service, messenger } = await startApi()
  const { deps, out, errors } = createDeps(port)
  const pending = runSendRequest({ ...ASK, voters: ['1', '2'], rule: 'majority', json: true }, deps)
  await waitFor(() => messenger.sent.length === 2)
  expect(messenger.recipients).toEqual(['1', '2'])
  for (const sent of messenger.sent) {
    service.tap(sent.id, 0)
  }
  expect(await pending).toBe(0)
  expect(out).toEqual([
    '{"answer":"Approve","timedOut":false,"approved":true,"require":"majority","votes":{"1":"Approve","2":"Approve"},"rounds":1}',
  ])
  expect(errors).toEqual([])
})

test('a rejected vote through the service exits 3 and prints the reject answer', async () => {
  const { port, service, messenger } = await startApi()
  const { deps, out } = createDeps(port)
  const pending = runSendRequest({ ...ASK, rule: 'all' }, deps)
  await waitFor(() => messenger.sent.length === 1)
  expect(messenger.recipients).toEqual(['owner'])
  service.tap(messenger.sent[0]?.id ?? '', 1)
  expect(await pending).toBe(3)
  expect(out).toEqual(['Decline'])
})

test('a vote names the voter the service could not reach', async () => {
  const { port, messenger } = await startApi()
  messenger.failSend = true
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const { deps, errors } = createDeps(port)
  expect(await runSendRequest({ ...ASK, voters: ['7'] }, deps)).toBe(1)
  error.mockRestore()
  expect(errors).toEqual(["jaypost: couldn't send the message to 7"])
})

test('a vote against a service without /vote says it is too old', async () => {
  const port = await startFakeService(404, { error: 'not found' })
  const { deps, errors } = createDeps(port)
  expect(await runSendRequest({ ...ASK, voters: ['1'] }, deps)).toBe(1)
  expect(errors).toEqual([
    'jaypost: jaypost service is too old for votes (run jaypost service install to upgrade)',
  ])
})

test('retry re-asks through the service', async () => {
  const { port, messenger } = await startApi()
  const { deps, out } = createDeps(port)
  expect(await runSendRequest({ ...ASK, timeout: 0.1, retryCount: 1 }, deps)).toBe(0)
  expect(out).toEqual(['Decline'])
  expect(messenger.finalized.map((ending) => ending.kind)).toEqual(['reasked', 'timedOut'])
})

test('retry against a service that ignores it says it is too old once it times out', async () => {
  const port = await startFakeService(200, { answer: 'Decline', timedOut: true })
  const { deps, errors } = createDeps(port)
  expect(await runSendRequest({ ...ASK, retryCount: 1 }, deps)).toBe(1)
  expect(errors).toEqual([
    'jaypost: jaypost service is too old to re-ask after a timeout (run jaypost service install to upgrade)',
  ])
})

test('retry against a service that ignores it keeps an answer that came in time', async () => {
  const port = await startFakeService(200, { answer: 'Approve', timedOut: false })
  const { deps, out } = createDeps(port)
  expect(await runSendRequest({ ...ASK, retryCount: 1 }, deps)).toBe(0)
  expect(out).toEqual(['Approve'])
})

function createLiveDeps(port: number, signal = new AbortController().signal, mode?: 'silent') {
  const { progress, events } = createRecordingProgress(mode ?? 'live')
  const created = createDeps(port, signal, NO_CLIENT_TOKEN, {
    progress: progress as Progress,
    providers: [telegramProvider],
    now: () => 0,
    wallNow: () => Date.now() - 500,
  })
  return { ...created, events }
}

test('a live send request shows sent and the countdown, and prints only the answer', async () => {
  const { port, service, messenger } = await startApi({ provider: 'telegram' })
  const { deps, out, errors, events } = createLiveDeps(port)
  const pending = runSendRequest(ASK, deps)
  await waitFor(() => messenger.sent.length === 1)
  await waitFor(() => events.length >= 3)
  service.tap(messenger.sent[0]?.id ?? '', 0)
  expect(await pending).toBe(0)
  expect(out).toEqual(['Approve'])
  expect(errors).toEqual([])
  expect(events).toEqual([
    'start:Sending',
    'succeed:Sent to Telegram',
    'start:Waiting for your answer 5:00 left, then Decline',
    'succeed:Answered after 0:00',
  ])
})

test('a live send request that times out shows the timeout answer', async () => {
  const { port } = await startApi({ provider: 'telegram' })
  const { deps, out, events } = createLiveDeps(port)
  expect(await runSendRequest({ ...ASK, timeout: 1 }, deps)).toBe(0)
  expect(events.at(-1)).toBe('succeed:Timed out, answered Decline')
  expect(out).toEqual(['Decline'])
})

test('a live send request --json prints the same object as before', async () => {
  const { port } = await startApi({ provider: 'telegram' })
  const { deps, out } = createLiveDeps(port)
  expect(await runSendRequest({ ...ASK, timeout: 1, json: true }, deps)).toBe(0)
  expect(out).toEqual(['{"answer":"Decline","timedOut":true}'])
})

test('aborting a live send request cancels the question on the service', async () => {
  const { port, messenger } = await startApi({ provider: 'telegram' })
  const controller = new AbortController()
  const { deps, out, errors, events } = createLiveDeps(port, controller.signal)
  const pending = runSendRequest(ASK, deps)
  await waitFor(() => events.length >= 3)
  controller.abort()
  expect(await pending).toBe(1)
  expect(out).toEqual([])
  expect(errors).toEqual(['jaypost: cancelled'])
  expect(events.at(-1)).toBe('cancel:Cancelled, the question was withdrawn')
  await waitFor(() => messenger.finalized.length === 1)
  expect(messenger.finalized).toEqual([{ kind: 'cancelled' }])
})

test('aborting a live send request while it is still sending cancels it once sent', async () => {
  const { port, messenger } = await startApi({ provider: 'telegram' })
  let open: () => void = () => {}
  messenger.gate = new Promise<void>((resolve) => {
    open = resolve
  })
  const controller = new AbortController()
  const { deps, errors, events } = createLiveDeps(port, controller.signal)
  const pending = runSendRequest(ASK, deps)
  await waitFor(() => messenger.sent.length === 1)
  controller.abort()
  open()
  expect(await pending).toBe(1)
  expect(errors).toEqual(['jaypost: cancelled'])
  await waitFor(() => messenger.finalized.length === 1)
  expect(messenger.finalized).toEqual([{ kind: 'cancelled' }])
  expect(events.some((event) => event.startsWith('succeed:Sent'))).toBe(false)
  expect(events.at(-1)).toBe('cancel:Cancelled, the question was withdrawn')
})

test('a send request off a terminal writes no progress and prints the same answer', async () => {
  const { port, service, messenger } = await startApi({ provider: 'telegram' })
  const { deps, out, events } = createLiveDeps(port, undefined, 'silent')
  const pending = runSendRequest(ASK, deps)
  await waitFor(() => messenger.sent.length === 1)
  service.tap(messenger.sent[0]?.id ?? '', 0)
  expect(await pending).toBe(0)
  expect(events).toEqual([])
  expect(out).toEqual(['Approve'])
})

test('a live send request says Sent when the service does not report its provider', async () => {
  const { port, service, messenger } = await startApi()
  const { deps, events } = createLiveDeps(port)
  const pending = runSendRequest(ASK, deps)
  await waitFor(() => messenger.sent.length === 1)
  await waitFor(() => events.length >= 3)
  service.tap(messenger.sent[0]?.id ?? '', 0)
  expect(await pending).toBe(0)
  expect(events[1]).toBe('succeed:Sent')
})

test('a live send request that fails marks the step failed and prints the message', async () => {
  const { port } = await startApi({ provider: 'telegram' })
  const { deps, out, errors, events } = createLiveDeps(port)
  expect(await runSendRequest({ ...ASK, timeoutOption: 'Maybe' }, deps)).toBe(1)
  expect(out).toEqual([])
  expect(errors[0]).toMatch(/^jaypost: .*timeoutOption/)
  expect(events.at(-1)).toBe('fail:Sending')
})

test('formatWaitTitle counts down with the timeout answer', () => {
  expect(formatWaitTitle(288_000, 'Decline')).toBe(
    'Waiting for your answer 4:48 left, then Decline',
  )
})
