import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FormattedText } from '../../src/format/index.ts'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { afterEach, expect, test } from 'vite-plus/test'
import { ApprovalService } from '../../src/approval/index.ts'
import type { MessageEnding, MessageReference, Messenger } from '../../src/approval/index.ts'
import { NO_AUTH, NO_CLIENT_TOKEN } from '../../src/auth/index.ts'
import type { ApiAuth, ClientToken } from '../../src/auth/index.ts'
import { TOKEN_REJECTED_MESSAGE } from '../../src/client/index.ts'
import { readHookInput, runHook } from '../../src/hook/index.ts'
import type { HookDeps } from '../../src/hook/index.ts'
import { NotificationService } from '../../src/notify/index.ts'
import type { Notifier } from '../../src/notify/index.ts'
import { createApiServer } from '../../src/server/index.ts'

const ROOT = new URL('../..', import.meta.url).pathname
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
const REFERENCE: MessageReference = { chatId: 1, messageId: 2 }

class RecordingMessenger implements Messenger {
  sent: { id: string; text: string; options: readonly string[] }[] = []
  finalized: MessageEnding[] = []

  async sendRequest(
    id: string,
    message: FormattedText,
    options: readonly string[],
  ): Promise<MessageReference> {
    this.sent.push({ id, text: message.text, options })
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

  sendNotification = async (_id: string, message: FormattedText): Promise<MessageReference> => {
    this.sent.push(message.text)
    return REFERENCE
  }
}

const servers: FastifyInstance[] = []
const stubs: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(
    stubs.splice(0).map((stub) => new Promise<void>((resolve) => stub.close(() => resolve()))),
  )
})

async function startApi(
  options: { readonly auth?: ApiAuth; readonly maxTextLength?: number } = {},
) {
  const messenger = new RecordingMessenger()
  const notifier = new RecordingNotifier()
  const service = new ApprovalService(messenger)
  const server = createApiServer(service, () => ({ paired: true, bot: 'b' }), {
    maxTextLength: options.maxTextLength ?? 3900,
    providerName: 'test',
    auth: options.auth ?? NO_AUTH,
    notifications: new NotificationService(notifier),
  })
  servers.push(server)
  await server.listen({ port: 0, host: '127.0.0.1' })
  const { port } = server.server.address() as AddressInfo
  return { port, service, messenger, notifier }
}

function createDeps(
  port: number,
  input: string,
  options: {
    readonly signal?: AbortSignal
    readonly env?: NodeJS.ProcessEnv
    readonly token?: ClientToken
  } = {},
) {
  const out: string[] = []
  const errors: string[] = []
  const deps: HookDeps = {
    port,
    token: options.token ?? NO_CLIENT_TOKEN,
    signal: options.signal ?? new AbortController().signal,
    readInput: async () => input,
    print: (text) => out.push(text),
    printError: (text) => errors.push(text),
    env: options.env ?? {},
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

/** A service stand-in that answers every request with `body` as JSON. */
async function startStub(body: unknown): Promise<number> {
  const stub = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    })
  })
  stubs.push(stub)
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  return (stub.address() as AddressInfo).port
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

function spawnHook(port: number, input: string | undefined, env?: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['src/cli.ts', 'hook', '--port', String(port)], {
    cwd: ROOT,
    ...(env === undefined ? {} : { env }),
  })
  const output = { stdout: '', stderr: '' }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => (output.stdout += chunk))
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => (output.stderr += chunk))
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve))
  if (input !== undefined) {
    child.stdin.end(input)
  }
  return { child, output, exited }
}

const ADD_RULES = {
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
  behavior: 'allow',
  destination: 'localSettings',
}

const BASH_EVENT = JSON.stringify({
  session_id: 's1',
  hook_event_name: 'PermissionRequest',
  cwd: '/work/api',
  tool_name: 'Bash',
  tool_input: { command: 'npm test', description: 'Run tests' },
  permission_suggestions: [ADD_RULES],
})

const NOTIFICATION_EVENT = JSON.stringify({
  session_id: 's1',
  hook_event_name: 'Notification',
  cwd: '/work/api',
  message: 'Claude is waiting for your input',
  title: 'Claude Code',
  notification_type: 'idle_prompt',
})

const BASH_TEXT =
  'Claude wants to run Bash:\nnpm test\nRun tests\n\nAlways allow adds: Bash(npm test:*)'

test('allow tap prints the allow decision', async () => {
  const { port, service, messenger } = await startApi()
  const { deps, out, errors } = createDeps(port, BASH_EVENT)
  const pending = runHook({}, deps)
  await waitFor(() => messenger.sent.length === 1)
  service.tap(messenger.sent[0]?.id ?? '', 0)
  expect(await pending).toBe(0)
  expect(out).toEqual([
    '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}',
  ])
  expect(errors).toEqual([])
})

test('sends project, text and buttons to /request', async () => {
  const { port, service, messenger } = await startApi()
  const { deps } = createDeps(port, BASH_EVENT)
  const pending = runHook({}, deps)
  await waitFor(() => messenger.sent.length === 1)
  expect(messenger.sent[0]).toEqual({
    id: expect.any(String),
    text: `[api]\n\n${BASH_TEXT}`,
    options: ['Allow', 'Always allow', 'Deny', 'Ask in terminal'],
  })
  service.tap(messenger.sent[0]?.id ?? '', 3)
  expect(await pending).toBe(0)
})

test('always allow tap passes the suggestions through', async () => {
  const { port, service, messenger } = await startApi()
  const { deps, out, errors } = createDeps(port, BASH_EVENT)
  const pending = runHook({}, deps)
  await waitFor(() => messenger.sent.length === 1)
  service.tap(messenger.sent[0]?.id ?? '', 1)
  expect(await pending).toBe(0)
  expect(out).toHaveLength(1)
  expect(JSON.parse(out[0] ?? '')).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedPermissions: [ADD_RULES] },
    },
  })
  expect(errors).toEqual([])
})

test('deny tap prints the deny decision', async () => {
  const { port, service, messenger } = await startApi()
  const { deps, out, errors } = createDeps(port, BASH_EVENT)
  const pending = runHook({}, deps)
  await waitFor(() => messenger.sent.length === 1)
  service.tap(messenger.sent[0]?.id ?? '', 2)
  expect(await pending).toBe(0)
  expect(out).toEqual([
    '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"the user denied this from jaypost"}}}',
  ])
  expect(errors).toEqual([])
})

test('ask in terminal tap prints nothing', async () => {
  const { port, service, messenger } = await startApi()
  const { deps, out, errors } = createDeps(port, BASH_EVENT)
  const pending = runHook({}, deps)
  await waitFor(() => messenger.sent.length === 1)
  service.tap(messenger.sent[0]?.id ?? '', 3)
  expect(await pending).toBe(0)
  expect(out).toEqual([])
  expect(errors).toEqual([])
})

test('a timeout prints nothing', async () => {
  const { port, messenger } = await startApi()
  const { deps, out, errors } = createDeps(port, BASH_EVENT)
  expect(await runHook({ timeout: 0.2 }, deps)).toBe(0)
  expect(out).toEqual([])
  expect(errors).toEqual([])
  await waitFor(() => messenger.finalized.length === 1)
  expect(messenger.finalized).toEqual([{ kind: 'timedOut', answer: 'Ask in terminal' }])
})

test('without --timeout the hook asks for 300 s', async () => {
  let posted: { timeout?: number } = {}
  const stub = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => (raw += chunk))
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      if (request.method === 'GET') {
        response.end(JSON.stringify({ paired: true }))
        return
      }
      posted = JSON.parse(raw)
      response.end(JSON.stringify({ ok: true, answer: 'Deny', kind: 'answered' }))
    })
  })
  stubs.push(stub)
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const { port } = stub.address() as AddressInfo
  const { deps } = createDeps(port, BASH_EVENT)
  await runHook({}, deps)
  expect(posted.timeout).toBe(300)
})

test('uses claude project dir for the project', async () => {
  const { port, service, messenger } = await startApi()
  const { deps } = createDeps(port, BASH_EVENT, {
    env: { CLAUDE_PROJECT_DIR: '/p/web' },
  })
  const pending = runHook({}, deps)
  await waitFor(() => messenger.sent.length === 1)
  expect(messenger.sent[0]?.text).toBe(`[web]\n\n${BASH_TEXT}`)
  service.tap(messenger.sent[0]?.id ?? '', 3)
  expect(await pending).toBe(0)
})

test('flag project wins', async () => {
  const { port, service, messenger } = await startApi()
  const { deps } = createDeps(port, BASH_EVENT, {
    env: { CLAUDE_PROJECT_DIR: '/p/web' },
  })
  const pending = runHook({ project: 'cli' }, deps)
  await waitFor(() => messenger.sent.length === 1)
  expect(messenger.sent[0]?.text).toBe(`[cli]\n\n${BASH_TEXT}`)
  service.tap(messenger.sent[0]?.id ?? '', 3)
  expect(await pending).toBe(0)
})

test('ask user question sends nothing', async () => {
  const { port, messenger, notifier } = await startApi()
  const input = JSON.stringify({
    hook_event_name: 'PermissionRequest',
    cwd: '/work/api',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [] },
  })
  const { deps, out, errors } = createDeps(port, input)
  expect(await runHook({}, deps)).toBe(0)
  expect(messenger.sent).toEqual([])
  expect(notifier.sent).toEqual([])
  expect(out).toEqual([])
  expect(errors).toEqual([])
})

test('notification goes to /notify', async () => {
  const { port, messenger, notifier } = await startApi()
  const { deps, out, errors } = createDeps(port, NOTIFICATION_EVENT)
  expect(await runHook({}, deps)).toBe(0)
  expect(notifier.sent).toEqual(['[api]\n\nClaude Code\n\nClaude is waiting for your input'])
  expect(messenger.sent).toEqual([])
  expect(out).toEqual([])
  expect(errors).toEqual([])
})

test('caps the question to the service text limit minus the project line', async () => {
  const { port, service, messenger } = await startApi({ maxTextLength: 400 })
  const input = JSON.stringify({
    hook_event_name: 'PermissionRequest',
    cwd: '/work/api',
    tool_name: 'Bash',
    tool_input: { command: 'x'.repeat(5000) },
  })
  const { deps } = createDeps(port, input)
  const pending = runHook({ project: 'proj' }, deps)
  await waitFor(() => messenger.sent.length === 1)
  const sent = messenger.sent[0]
  expect(sent?.text.startsWith('[proj]\n\n')).toBe(true)
  expect(sent?.text.length).toBe(400)
  expect(sent?.options).toEqual(['Deny', 'Ask in terminal'])
  service.tap(sent?.id ?? '', 1)
  expect(await pending).toBe(0)
})

test('notification text follows the service text limit', async () => {
  const { port, notifier } = await startApi({ maxTextLength: 400 })
  const input = JSON.stringify({
    hook_event_name: 'Notification',
    cwd: '/work/api',
    message: 'm'.repeat(5000),
  })
  const { deps, errors } = createDeps(port, input)
  expect(await runHook({ project: 'proj' }, deps)).toBe(0)
  expect(notifier.sent).toHaveLength(1)
  expect(notifier.sent[0]?.length).toBe(400)
  expect(errors).toEqual([])
})

test('keeps 3000 when /status has no maxTextLength', async () => {
  let posted: { text?: string } = {}
  const stub = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => (raw += chunk))
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      if (request.method === 'GET') {
        response.end(JSON.stringify({ paired: true }))
        return
      }
      posted = JSON.parse(raw)
      response.end(JSON.stringify({ answer: 'Ask in terminal', timedOut: false }))
    })
  })
  stubs.push(stub)
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const { port } = stub.address() as AddressInfo
  const input = JSON.stringify({
    hook_event_name: 'PermissionRequest',
    cwd: '/work/api',
    tool_name: 'Bash',
    tool_input: { command: 'x'.repeat(5000) },
  })
  const { deps } = createDeps(port, input)
  expect(await runHook({}, deps)).toBe(0)
  expect(posted.text?.length).toBe(3000)
})

test('an old status without maxTextLength keeps the default cap for notifications', async () => {
  let posted: { text?: string } = {}
  const stub = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => (raw += chunk))
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      if (request.method === 'GET') {
        response.end(JSON.stringify({ paired: true }))
        return
      }
      posted = JSON.parse(raw)
      response.end('{}')
    })
  })
  stubs.push(stub)
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const { port } = stub.address() as AddressInfo
  const input = JSON.stringify({
    hook_event_name: 'Notification',
    cwd: '/work/api',
    message: 'x'.repeat(5000),
  })
  const { deps } = createDeps(port, input)
  expect(await runHook({}, deps)).toBe(0)
  expect(posted.text?.length).toBe(3000)
})

test('service down exits 1 with the reachability message', async () => {
  const port = await freePort()
  const { deps, out, errors } = createDeps(port, BASH_EVENT)
  expect(await runHook({}, deps)).toBe(1)
  expect(out).toEqual([])
  expect(errors).toEqual([
    `jaypost: jaypost service not reachable on 127.0.0.1:${port} (run jaypost status)`,
  ])
})

test('notification with the service down exits 1 with the reachability message', async () => {
  const port = await freePort()
  const { deps, out, errors } = createDeps(port, NOTIFICATION_EVENT)
  expect(await runHook({}, deps)).toBe(1)
  expect(out).toEqual([])
  expect(errors).toEqual([
    `jaypost: jaypost service not reachable on 127.0.0.1:${port} (run jaypost status)`,
  ])
})

test('an answer that was not offered exits 1 with the answer', async () => {
  const port = await startStub({ answer: 'Maybe', timedOut: false })
  const { deps, out, errors } = createDeps(port, BASH_EVENT)
  expect(await runHook({}, deps)).toBe(1)
  expect(out).toEqual([])
  expect(errors).toEqual(['jaypost: unexpected answer "Maybe"'])
})

test('an unreadable answer exits 1 with the body', async () => {
  const port = await startStub({ ok: true })
  const { deps, out, errors } = createDeps(port, BASH_EVENT)
  expect(await runHook({}, deps)).toBe(1)
  expect(out).toEqual([])
  expect(errors).toEqual(['jaypost: jaypost service sent an unreadable answer: {"ok":true}'])
})

test('abort cancels the question quietly', async () => {
  const { port, messenger } = await startApi()
  const controller = new AbortController()
  const { deps, out, errors } = createDeps(port, BASH_EVENT, {
    signal: controller.signal,
  })
  const pending = runHook({}, deps)
  await waitFor(() => messenger.sent.length === 1)
  controller.abort()
  expect(await pending).toBe(1)
  expect(out).toEqual([])
  expect(errors).toEqual([])
  await waitFor(() => messenger.finalized.length === 1)
  expect(messenger.finalized).toEqual([{ kind: 'cancelled' }])
})

test('sends the token to /request and /notify', async () => {
  const { port, service, messenger, notifier } = await startApi({
    auth: { kind: 'token', token: TOKEN },
  })
  const token: ClientToken = { kind: 'token', token: TOKEN, source: 'file' }
  const asked = createDeps(port, BASH_EVENT, { token })
  const pending = runHook({}, asked.deps)
  await waitFor(() => messenger.sent.length === 1)
  service.tap(messenger.sent[0]?.id ?? '', 0)
  expect(await pending).toBe(0)
  expect(asked.out).toEqual([
    '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}',
  ])
  expect(asked.errors).toEqual([])
  const notified = createDeps(port, NOTIFICATION_EVENT, { token })
  expect(await runHook({}, notified.deps)).toBe(0)
  expect(notifier.sent).toHaveLength(1)
  expect(notified.errors).toEqual([])
})

test('a wrong token prints the rejected message', async () => {
  const { port, messenger } = await startApi({ auth: { kind: 'token', token: TOKEN } })
  const { deps, out, errors } = createDeps(port, BASH_EVENT, {
    token: { kind: 'token', token: `${TOKEN}x`, source: 'env' },
  })
  expect(await runHook({}, deps)).toBe(1)
  expect(out).toEqual([])
  expect(errors).toEqual([`jaypost: ${TOKEN_REJECTED_MESSAGE}`])
  expect(messenger.sent).toEqual([])
})

test('an unusable token fails without calling the service', async () => {
  const { port, messenger, notifier } = await startApi()
  const { deps, out, errors } = createDeps(port, BASH_EVENT, {
    token: { kind: 'unusable', message: 'bad token here' },
  })
  expect(await runHook({}, deps)).toBe(1)
  expect(out).toEqual([])
  expect(errors).toEqual(['jaypost: bad token here'])
  expect(messenger.sent).toEqual([])
  expect(notifier.sent).toEqual([])
})

test('invalid input exits 1 with the reason', async () => {
  const { port, messenger } = await startApi()
  const { deps, out, errors } = createDeps(port, 'nope')
  expect(await runHook({}, deps)).toBe(1)
  expect(out).toEqual([])
  expect(errors).toEqual(['jaypost: hook input is not valid JSON'])
  expect(messenger.sent).toEqual([])
})

test('empty input exits 1', async () => {
  const { port } = await startApi()
  const { deps, out, errors } = createDeps(port, '')
  expect(await runHook({}, deps)).toBe(1)
  expect(out).toEqual([])
  expect(errors).toEqual(['jaypost: hook input is not valid JSON'])
})

test('failed stdin read exits 1 with the reason', async () => {
  const { port } = await startApi()
  const { deps, out, errors } = createDeps(port, '')
  const failing: HookDeps = {
    ...deps,
    readInput: async () => {
      throw new Error('EIO')
    },
  }
  expect(await runHook({}, failing)).toBe(1)
  expect(out).toEqual([])
  expect(errors).toEqual(["jaypost: couldn't read the hook input: EIO"])
})

test('aborted stdin read exits 1 quietly', async () => {
  const { port, messenger } = await startApi()
  const controller = new AbortController()
  const { deps, out, errors } = createDeps(port, '', {
    signal: controller.signal,
  })
  const aborted: HookDeps = {
    ...deps,
    readInput: async () => {
      controller.abort()
      throw new Error('The operation was aborted')
    },
  }
  expect(await runHook({}, aborted)).toBe(1)
  expect(out).toEqual([])
  expect(errors).toEqual([])
  expect(messenger.sent).toEqual([])
})

test('unknown event exits 1', async () => {
  const { port } = await startApi()
  const { deps, out, errors } = createDeps(port, JSON.stringify({ hook_event_name: 'Stop' }))
  expect(await runHook({}, deps)).toBe(1)
  expect(out).toEqual([])
  expect(errors).toEqual(['jaypost: unsupported hook event "Stop"'])
})

test('the cli writes exactly one json line on allow', async () => {
  const { port, service, messenger } = await startApi()
  const { output, exited } = spawnHook(port, BASH_EVENT)
  await waitFor(() => messenger.sent.length === 1)
  service.tap(messenger.sent[0]?.id ?? '', 0)
  expect(await exited).toBe(0)
  expect(output.stdout).toBe(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })}\n`,
  )
  expect(output.stderr).toBe('')
})

test('sigterm cancels the question and exits 1 silently', async () => {
  const { port, messenger } = await startApi()
  const { child, output, exited } = spawnHook(port, BASH_EVENT)
  await waitFor(() => messenger.sent.length === 1)
  child.kill('SIGTERM')
  expect(await exited).toBe(1)
  expect(output.stdout).toBe('')
  expect(output.stderr).toBe('')
  await waitFor(() => messenger.finalized.length === 1)
  expect(messenger.finalized).toEqual([{ kind: 'cancelled' }])
})

test('reads the whole input stream', async () => {
  const stream = new PassThrough()
  const pending = readHookInput(stream, new AbortController().signal)
  stream.write('{"hook_event_name":')
  stream.end('"Stop"}')
  expect(await pending).toBe('{"hook_event_name":"Stop"}')
})

test('aborting mid-read rejects instead of waiting for the end of input', async () => {
  const stream = new PassThrough()
  const controller = new AbortController()
  const pending = readHookInput(stream, controller.signal)
  stream.write('{"hook_event_name":')
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(stream.destroyed).toBe(true)
})

const SESSION_START_EVENT = JSON.stringify({
  session_id: 's1',
  hook_event_name: 'SessionStart',
  source: 'startup',
  cwd: '/work/api',
})

async function createEmptyHome(): Promise<NodeJS.ProcessEnv> {
  return { HOME: await mkdtemp(join(tmpdir(), 'jaypost-hook-home-')) }
}

function unreachableLine(port: number): string {
  return `jaypost isn't running on 127.0.0.1:${port}, so permission prompts stay in the terminal. Run \`jaypost init\` to set it up, or \`jaypost status\` to check an existing install.`
}

function tokenLine(message: string): string {
  return `jaypost can't use its API token (${message}), so permission prompts stay in the terminal. Run \`jaypost init\`, or set JAYPOST_TOKEN in a container.`
}

test('session start with a paired service prints nothing', async () => {
  const { port, messenger, notifier } = await startApi()
  const { deps, out, errors } = createDeps(port, SESSION_START_EVENT, {
    env: await createEmptyHome(),
  })
  expect(await runHook({}, deps)).toBe(0)
  expect(out).toEqual([])
  expect(errors).toEqual([])
  expect(messenger.sent).toEqual([])
  expect(notifier.sent).toEqual([])
})

test('session start with the service down reports it', async () => {
  const port = await freePort()
  const { deps, out, errors } = createDeps(port, SESSION_START_EVENT, {
    env: await createEmptyHome(),
  })
  expect(await runHook({}, deps)).toBe(0)
  expect(out).toEqual([JSON.stringify({ systemMessage: unreachableLine(port) })])
  expect(errors).toEqual([])
})

test('session start when not paired says to pair', async () => {
  const port = await startStub({
    paired: false,
    code: 'ABCD-EFGH',
    maxTextLength: 3900,
    maxAttachmentBytes: 1,
  })
  const { deps, out } = createDeps(port, SESSION_START_EVENT, { env: await createEmptyHome() })
  expect(await runHook({}, deps)).toBe(0)
  expect(out).toEqual([
    JSON.stringify({
      systemMessage:
        "jaypost isn't paired with your phone yet, so permission prompts stay in the terminal. Run `jaypost init` to pair.",
    }),
  ])
})

test('session start with a rejected token reports the token', async () => {
  const { port } = await startApi({ auth: { kind: 'token', token: TOKEN } })
  const { deps, out } = createDeps(port, SESSION_START_EVENT, {
    env: await createEmptyHome(),
    token: { kind: 'token', token: 'x'.repeat(43), source: 'env' },
  })
  expect(await runHook({}, deps)).toBe(0)
  expect(out).toEqual([JSON.stringify({ systemMessage: tokenLine(TOKEN_REJECTED_MESSAGE) })])
})

test('session start with an unusable token reports it without calling the service', async () => {
  const { port, messenger } = await startApi()
  const { deps, out, errors } = createDeps(port, SESSION_START_EVENT, {
    env: await createEmptyHome(),
    token: { kind: 'unusable', message: 'bad token here' },
  })
  expect(await runHook({}, deps)).toBe(0)
  expect(out).toEqual([JSON.stringify({ systemMessage: tokenLine('bad token here') })])
  expect(errors).toEqual([])
  expect(messenger.sent).toEqual([])
})

test('session start aborted prints nothing', async () => {
  const { port } = await startApi()
  const controller = new AbortController()
  controller.abort()
  const { deps, out, errors } = createDeps(port, SESSION_START_EVENT, {
    env: await createEmptyHome(),
    signal: controller.signal,
  })
  expect(await runHook({}, deps)).toBe(0)
  expect(out).toEqual([])
  expect(errors).toEqual([])
})

test('the cli prints the session start check as one json line', async () => {
  const port = await freePort()
  const { output, exited } = spawnHook(port, SESSION_START_EVENT, {
    ...process.env,
    ...(await createEmptyHome()),
  })
  expect(await exited).toBe(0)
  expect(output.stderr).toBe('')
  expect(output.stdout.endsWith('\n')).toBe(true)
  expect(output.stdout.trimEnd().split('\n')).toHaveLength(1)
  expect(JSON.parse(output.stdout)).toEqual({ systemMessage: unreachableLine(port) })
})
