import { spawn } from 'node:child_process'
import type {
  Attachment,
  FormattedText,
  MessageEnding,
  MessageReference,
  Messenger,
  Notifier,
} from '@jaypost/core'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Progress } from '@modelcontextprotocol/sdk/types.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, test } from 'vite-plus/test'
import { ApprovalService, MAX_ATTACHMENT_BYTES, NotificationService } from '@jaypost/core'
import { NO_AUTH, writeTokenFile } from '@jaypost/store'
import type { ApiAuth } from '@jaypost/store'
import {
  ATTACHMENT_TOO_OLD_MESSAGE,
  BACKGROUND_TOO_OLD_MESSAGE,
  Caller,
  TOKEN_REJECTED_MESSAGE,
  toLocalEndpoint,
} from '@jaypost/client'
import { createApiServer, createSingleBotRouter } from '@jaypost/service'
import { createMcpServer, OpenQuestions } from '../src/index.ts'
import type { OpenQuestion } from '../src/index.ts'

const TEST_VERSION = '1.2.3'

const ROOT = new URL('../../..', import.meta.url).pathname
const REFERENCE: MessageReference = { chatId: 1, messageId: 2 }

class RecordingMessenger implements Messenger {
  sent: { id: string; text: string; options: readonly string[]; allowText: boolean }[] = []
  messages: FormattedText[] = []
  attachments: (Attachment | undefined)[] = []
  finalized: { text: string; settlement: MessageEnding }[] = []

  async sendRequest(
    id: string,
    message: FormattedText,
    options: readonly string[],
    allowText: boolean,
    attachment?: Attachment,
  ): Promise<MessageReference> {
    this.sent.push({ id, text: message.text, options, allowText })
    this.attachments.push(attachment)
    this.messages.push(message)
    return REFERENCE
  }

  async finalize(
    _reference: MessageReference,
    message: FormattedText,
    settlement: MessageEnding,
  ): Promise<void> {
    this.finalized.push({ text: message.text, settlement })
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

const TOKEN = 'a'.repeat(43)
const FIRST = 'b'.repeat(43)
const SECOND = 'c'.repeat(43)
const NOTE = { project_name: 'api', text: 'done' }

const servers: FastifyInstance[] = []
const stubs: Server[] = []
const clients: Client[] = []
let directory = ''
let tokenFile = ''
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jaypost-mcp-'))
  mkdirSync(join(directory, 'jaypost'))
  tokenFile = join(directory, 'jaypost', 'token')
})
afterEach(async () => {
  rmSync(directory, { recursive: true, force: true })
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(
    stubs.splice(0).map((stub) => {
      stub.closeAllConnections()
      return new Promise<void>((resolve) => stub.close(() => resolve()))
    }),
  )
})

async function startRecordingStub() {
  const bodies: Record<string, unknown>[] = []
  const stub = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ answer: 'main', timedOut: false }))
    })
  })
  stubs.push(stub)
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const { port } = stub.address() as AddressInfo
  return { port, bodies }
}

async function startApi(
  options: {
    readonly notifications?: boolean
    readonly auth?: ApiAuth
    readonly maxAttachmentBytes?: number
  } = {},
) {
  const messenger = new RecordingMessenger()
  const notifier = new RecordingNotifier()
  const service = new ApprovalService(messenger)
  const server = createApiServer(
    createSingleBotRouter({
      version: TEST_VERSION,
      service,
      status: () => ({ paired: true, bot: 'b' }),
      maxTextLength: 3900,
      maxAttachmentBytes: options.maxAttachmentBytes ?? MAX_ATTACHMENT_BYTES,
      providerName: 'test',
      resolveVoters: () => ({ kind: 'noOwner' }),
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

async function connect(port: number, extraEnv: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' })
  clients.push(client)
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['apps/cli/src/cli.ts', 'mcp', '--port', String(port)],
      cwd: ROOT,
      env: { ...getDefaultEnvironment(), XDG_CONFIG_HOME: directory, ...extraEnv },
      stderr: 'pipe',
    }),
  )
  return client
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

async function startStub(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<number> {
  const stub = createServer(handler)
  stubs.push(stub)
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  return (stub.address() as AddressInfo).port
}

async function askInBackground(
  client: Client,
  extraArguments: Record<string, unknown> = {},
): Promise<string> {
  const result = await client.callTool({
    name: 'ask_for_permission_in_background',
    arguments: { ...ASK, ...extraArguments },
  })
  const id = (result.structuredContent as { request_id?: unknown } | undefined)?.request_id
  if (typeof id !== 'string') {
    throw new Error(`no request_id in ${JSON.stringify(result)}`)
  }
  return id
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

function toOpenQuestion(id: string): OpenQuestion {
  return { id, project: 'api', text: 'Deploy?', expiresAt: '2026-10-20T06:00:00.000Z' }
}

const ASK = {
  project_name: 'api',
  text: 'Deploy?',
  options: ['Approve', 'Decline'],
  timeout_option: 'Decline',
}

test('lists the six tools with their required inputs', async () => {
  const { port } = await startApi()
  const client = await connect(port)
  const { tools } = await client.listTools()
  const requiredByName = Object.fromEntries(
    tools.map((tool) => [tool.name, tool.inputSchema.required?.toSorted()]),
  )
  expect(requiredByName).toEqual({
    ask_for_permission: ['project_name', 'text', 'timeout_option'],
    ask_for_permission_in_background: ['project_name', 'text', 'timeout_option'],
    cancel_question: ['request_id'],
    list_questions: undefined,
    notify_user: ['project_name', 'text'],
    wait_for_answer: ['request_id'],
  })
  expect(tools.map((tool) => tool.name).toSorted()).toEqual([
    'ask_for_permission',
    'ask_for_permission_in_background',
    'cancel_question',
    'list_questions',
    'notify_user',
    'wait_for_answer',
  ])
})

function writeAttachmentFile(name: string, content: string): string {
  const path = join(directory, name)
  writeFileSync(path, content)
  return path
}

test('a path attachment reaches the service as the file bytes', async () => {
  const { port, service, messenger } = await startApi()
  const client = await connect(port)
  const path = writeAttachmentFile('report.diff', 'diff body')
  const pending = client.callTool({
    name: 'ask_for_permission',
    arguments: { ...ASK, attachment: { path } },
  })
  await waitFor(() => messenger.sent.length === 1)
  const [attachment] = messenger.attachments
  expect(attachment?.name).toBe('report.diff')
  expect(Buffer.from(attachment?.content ?? []).toString()).toBe('diff body')
  service.tap(messenger.sent[0]?.id ?? '', 0)
  expect((await pending).isError).toBeUndefined()
})

test('a text attachment defaults to attachment.txt', async () => {
  const { port, notifier } = await startApi()
  const client = await connect(port)
  const result = await client.callTool({
    name: 'notify_user',
    arguments: { ...NOTE, attachment: { text: 'log' } },
  })
  expect(result).toEqual({ content: [{ type: 'text', text: 'sent' }] })
  const [attachment] = notifier.attachments
  expect(attachment?.name).toBe('attachment.txt')
  expect(Buffer.from(attachment?.content ?? []).toString()).toBe('log')
})

test('a text attachment keeps its own name', async () => {
  const { port, notifier } = await startApi()
  const client = await connect(port)
  await client.callTool({
    name: 'notify_user',
    arguments: { ...NOTE, attachment: { text: 'log', name: 'build.log' } },
  })
  expect(notifier.attachments[0]?.name).toBe('build.log')
})

test('the background ask takes an attachment', async () => {
  const { port, messenger } = await startApi()
  const client = await connect(port)
  const path = writeAttachmentFile('notes.md', '# notes')
  await askInBackground(client, { attachment: { path, name: 'renamed.md' } })
  expect(messenger.attachments[0]?.name).toBe('renamed.md')
  expect(Buffer.from(messenger.attachments[0]?.content ?? []).toString()).toBe('# notes')
})

test('both or neither of path and text are refused', async () => {
  const { port, messenger } = await startApi()
  const client = await connect(port)
  const file = writeAttachmentFile('a.txt', 'x')
  for (const attachment of [{ path: file, text: 'x' }, { name: 'a.txt' }]) {
    const refused = await client
      .callTool({ name: 'ask_for_permission', arguments: { ...ASK, attachment } })
      .then(
        (result) => result.isError === true,
        () => true,
      )
    expect(refused).toBe(true)
  }
  expect(messenger.sent).toEqual([])
})

test('a missing file is a tool error with the reason', async () => {
  const { port, notifier } = await startApi()
  const client = await connect(port)
  const path = join(directory, 'missing.txt')
  const result = await client.callTool({
    name: 'notify_user',
    arguments: { ...NOTE, attachment: { path } },
  })
  expect(result).toEqual({
    isError: true,
    content: [{ type: 'text', text: `attachment ${JSON.stringify(path)} not found` }],
  })
  expect(notifier.sent).toEqual([])
})

test('an old service is a tool error with the upgrade message', async () => {
  const port = await startStub((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ paired: true, bot: 'b' }))
  })
  const client = await connect(port)
  const result = await client.callTool({
    name: 'notify_user',
    arguments: { ...NOTE, attachment: { text: 'log' } },
  })
  expect(result).toEqual({
    isError: true,
    content: [{ type: 'text', text: ATTACHMENT_TOO_OLD_MESSAGE }],
  })
})

test('ask returns the tapped answer', async () => {
  const { port, service, messenger } = await startApi()
  const client = await connect(port)
  const pending = client.callTool({ name: 'ask_for_permission', arguments: ASK })
  await waitFor(() => messenger.sent.length === 1)
  const [sent] = messenger.sent
  expect(sent?.text).toBe('[api]\n\nDeploy?')
  service.tap(sent?.id ?? '', 0)
  expect(await pending).toEqual({
    content: [{ type: 'text', text: 'Approve' }],
    structuredContent: { answer: 'Approve', timed_out: false },
  })
})

test('ask on timeout returns the timeout option', async () => {
  const { port } = await startApi()
  const client = await connect(port)
  const result = await client.callTool({
    name: 'ask_for_permission',
    arguments: { ...ASK, timeout_seconds: 0.2 },
  })
  expect(result).toEqual({
    content: [{ type: 'text', text: 'Decline (timed out, no answer from the user)' }],
    structuredContent: { answer: 'Decline', timed_out: true },
  })
})

test('service 400 text reaches the agent', async () => {
  const { port } = await startApi()
  const client = await connect(port)
  const result = await client.callTool({
    name: 'ask_for_permission',
    arguments: { ...ASK, project_name: '   ' },
  })
  expect(result).toEqual({
    isError: true,
    content: [{ type: 'text', text: 'project must be a non-empty string' }],
  })
})

test('notify sends and returns', async () => {
  const { port, notifier } = await startApi()
  const client = await connect(port)
  const result = await client.callTool({
    name: 'notify_user',
    arguments: { project_name: 'api', text: 'done' },
  })
  expect(result).toEqual({ content: [{ type: 'text', text: 'sent' }] })
  expect(notifier.sent).toEqual(['[api]\n\ndone'])
})

test('notify without provider support', async () => {
  const { port } = await startApi({ notifications: false })
  const client = await connect(port)
  const result = await client.callTool({
    name: 'notify_user',
    arguments: { project_name: 'api', text: 'done' },
  })
  expect(result).toEqual({
    isError: true,
    content: [{ type: 'text', text: 'notifications not supported by this provider' }],
  })
})

test('service down is a tool error and the server keeps going', async () => {
  const port = await freePort()
  const client = await connect(port)
  const expected = {
    isError: true,
    content: [
      {
        type: 'text',
        text: `jaypost service not reachable on 127.0.0.1:${port} (run jaypost status)`,
      },
    ],
  }
  const call = () =>
    client.callTool({ name: 'notify_user', arguments: { project_name: 'api', text: 'done' } })
  expect(await call()).toEqual(expected)
  expect(await call()).toEqual(expected)
})

test('cancelling an ask cancels the request', async () => {
  const { port, messenger } = await startApi()
  const client = await connect(port)
  const controller = new AbortController()
  const pending = client.callTool({ name: 'ask_for_permission', arguments: ASK }, undefined, {
    signal: controller.signal,
  })
  await waitFor(() => messenger.sent.length === 1)
  controller.abort()
  await expect(pending).rejects.toThrow()
  await waitFor(() => messenger.finalized[0]?.settlement.kind === 'cancelled')
})

test('closing stdin cancels a pending ask', async () => {
  const { port, messenger } = await startApi()
  const client = await connect(port)
  const pending = client.callTool({ name: 'ask_for_permission', arguments: ASK })
  // The call rejects once the connection closes; that's expected here.
  pending.catch(() => {})
  await waitFor(() => messenger.sent.length === 1)
  const startedAt = performance.now()
  await client.close()
  // The SDK sends SIGTERM only after waiting 2 s; finishing sooner means stdin's end stopped it.
  expect(performance.now() - startedAt).toBeLessThan(2000)
  await waitFor(() => messenger.finalized[0]?.settlement.kind === 'cancelled')
})

test('stdout carries only json-rpc', async () => {
  const { port } = await startApi()
  const child = spawn(process.execPath, ['apps/cli/src/cli.ts', 'mcp', '--port', String(port)], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => (stdout += chunk))
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve))
  const messages = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]
  child.stdin.end(messages.map((message) => `${JSON.stringify(message)}\n`).join(''))
  expect(await exited).toBe(0)
  const lines = stdout.split('\n').filter((line) => line.trim() !== '')
  expect(lines.map((line) => JSON.parse(line).id)).toEqual([1, 2])
  for (const line of lines) {
    expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' })
  }
})

test('tool calls send the token from the token file', async () => {
  writeTokenFile(tokenFile, TOKEN)
  const { port } = await startApi({ auth: { kind: 'token', token: TOKEN } })
  const client = await connect(port)
  expect(await client.callTool({ name: 'notify_user', arguments: NOTE })).toEqual({
    content: [{ type: 'text', text: 'sent' }],
  })
})

test('JAYPOST_TOKEN reaches the service', async () => {
  const { port } = await startApi({ auth: { kind: 'token', token: TOKEN } })
  const client = await connect(port, { JAYPOST_TOKEN: TOKEN })
  expect(await client.callTool({ name: 'notify_user', arguments: NOTE })).toEqual({
    content: [{ type: 'text', text: 'sent' }],
  })
})

test('the token is read again on every call', async () => {
  writeTokenFile(tokenFile, FIRST)
  const { port } = await startApi({ auth: { kind: 'token', token: SECOND } })
  const client = await connect(port)
  expect(await client.callTool({ name: 'notify_user', arguments: NOTE })).toEqual({
    isError: true,
    content: [{ type: 'text', text: TOKEN_REJECTED_MESSAGE }],
  })
  writeTokenFile(tokenFile, SECOND)
  expect(await client.callTool({ name: 'notify_user', arguments: NOTE })).toEqual({
    content: [{ type: 'text', text: 'sent' }],
  })
})

test('an unusable token fails only the call that hit it', async () => {
  writeTokenFile(tokenFile, 'short-secret')
  const { port } = await startApi({ auth: { kind: 'token', token: TOKEN } })
  const client = await connect(port)
  const unusable = {
    isError: true,
    content: [
      {
        type: 'text',
        text: `token file ${JSON.stringify(tokenFile)} isn't a valid jaypost token`,
      },
    ],
  }
  expect(await client.callTool({ name: 'notify_user', arguments: NOTE })).toEqual(unusable)
  expect(await client.callTool({ name: 'ask_for_permission', arguments: ASK })).toEqual(unusable)
  writeTokenFile(tokenFile, TOKEN)
  expect(await client.callTool({ name: 'notify_user', arguments: NOTE })).toEqual({
    content: [{ type: 'text', text: 'sent' }],
  })
})

const CODE_SPAN = { kind: 'code', offset: 11, length: 2 } as const

test('tool list shows format', async () => {
  const { port } = await startApi()
  const client = await connect(port)
  const { tools } = await client.listTools()
  const messageTools = ['ask_for_permission', 'ask_for_permission_in_background', 'notify_user']
  for (const tool of tools.filter((tool) => messageTools.includes(tool.name))) {
    expect(tool.inputSchema.properties?.format).toMatchObject({ enum: ['plain', 'markdown'] })
    expect(tool.inputSchema.required).not.toContain('format')
  }
})

test('ask_for_permission forwards format', async () => {
  const { port, service, messenger } = await startApi()
  const client = await connect(port)
  const pending = client.callTool({
    name: 'ask_for_permission',
    arguments: { ...ASK, text: 'Run `ls` now?', format: 'markdown' },
  })
  await waitFor(() => messenger.sent.length === 1)
  expect(messenger.messages[0]).toEqual({ text: '[api]\n\nRun ls now?', spans: [CODE_SPAN] })
  service.tap(messenger.sent[0]?.id ?? '', 0)
  await pending
})

test('ask format is omitted when not set', async () => {
  const { port, service, messenger } = await startApi()
  const client = await connect(port)
  const pending = client.callTool({
    name: 'ask_for_permission',
    arguments: { ...ASK, text: 'Run `ls` now?' },
  })
  await waitFor(() => messenger.sent.length === 1)
  expect(messenger.messages[0]).toEqual({ text: '[api]\n\nRun `ls` now?', spans: [] })
  service.tap(messenger.sent[0]?.id ?? '', 0)
  await pending
})

test('notify_user forwards format, and omits it when not set', async () => {
  const { port, notifier } = await startApi()
  const client = await connect(port)
  const text = 'Run `ls` now?'
  await client.callTool({
    name: 'notify_user',
    arguments: { project_name: 'api', text, format: 'markdown' },
  })
  await client.callTool({ name: 'notify_user', arguments: { project_name: 'api', text } })
  expect(notifier.messages).toEqual([
    { text: '[api]\n\nRun ls now?', spans: [CODE_SPAN] },
    { text: '[api]\n\nRun `ls` now?', spans: [] },
  ])
})

test('ask with allow_text and no options is answered by a typed reply', async () => {
  const { port, service, messenger } = await startApi()
  const client = await connect(port)
  const pending = client.callTool({
    name: 'ask_for_permission',
    arguments: {
      project_name: 'api',
      text: 'Which branch?',
      allow_text: true,
      timeout_option: 'main',
    },
  })
  await waitFor(() => messenger.sent.length === 1)
  expect(messenger.sent[0]).toMatchObject({ options: [], allowText: true })
  service.reply(messenger.sent[0]?.id ?? '', 'feature/x')
  expect(await pending).toEqual({
    content: [{ type: 'text', text: 'feature/x' }],
    structuredContent: { answer: 'feature/x', timed_out: false },
  })
})

test('allow_text is forwarded only when given', async () => {
  const { port, bodies } = await startRecordingStub()
  const client = await connect(port)
  await client.callTool({ name: 'ask_for_permission', arguments: ASK })
  await client.callTool({ name: 'ask_for_permission', arguments: { ...ASK, allow_text: false } })
  await client.callTool({
    name: 'ask_for_permission',
    arguments: { ...ASK, options: [], allow_text: true },
  })
  expect(Object.hasOwn(bodies[0] ?? {}, 'allowText')).toBe(false)
  expect(bodies[1]).toMatchObject({ allowText: false })
  expect(bodies[2]).toMatchObject({ allowText: true, options: [] })
})

test('empty options without allow_text is the service 400', async () => {
  const { port } = await startApi()
  const client = await connect(port)
  const result = await client.callTool({
    name: 'ask_for_permission',
    arguments: { ...ASK, options: [] },
  })
  expect(result).toEqual({
    isError: true,
    content: [{ type: 'text', text: 'options must be a non-empty array' }],
  })
})

test('the ask description mentions typed answers', async () => {
  const { port } = await startApi()
  const client = await connect(port)
  const { tools } = await client.listTools()
  const description = tools.find((tool) => tool.name === 'ask_for_permission')?.description
  expect(description).toContain('allow_text')
  expect(description).toContain('wait for their answer')
})

test('a long ask sends progress while it waits', async () => {
  const { port, service, messenger } = await startApi()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer(
    new Caller({ endpoint: toLocalEndpoint(port), readToken: () => ({ kind: 'none' }) }),
    new AbortController().signal,
    { version: TEST_VERSION, progressIntervalMs: 50 },
  )
  await server.connect(serverTransport)
  const client = new Client({ name: 'test', version: '0.0.0' })
  clients.push(client)
  await client.connect(clientTransport)
  const progress: Progress[] = []
  const pending = client.callTool(
    { name: 'ask_for_permission', arguments: { ...ASK, timeout_seconds: 3600 } },
    undefined,
    { onprogress: (event) => progress.push(event) },
  )
  await waitFor(() => progress.length >= 2)
  service.tap(messenger.sent[0]?.id ?? '', 0)
  await pending
  await server.close()
  expect(progress[0]).toEqual({
    progress: expect.any(Number),
    total: 3600,
    message: 'waiting for the user',
  })
})

test('ask in background returns an id at once', async () => {
  const { port, service, messenger } = await startApi()
  const client = await connect(port)
  const result = await client.callTool({
    name: 'ask_for_permission_in_background',
    arguments: ASK,
  })
  const id = messenger.sent[0]?.id ?? ''
  const state = service.get(id)
  const expiresAt = state?.kind === 'pending' ? state.expiresAt.toISOString() : ''
  expect(result).toEqual({
    content: [
      {
        type: 'text',
        text: `Asked. Call wait_for_answer with request_id ${id} when you need the answer (expires ${expiresAt}).`,
      },
    ],
    structuredContent: { request_id: id, expires_at: expiresAt },
  })
  expect(expiresAt).not.toBe('')
})

test('wait_for_answer returns the answer once the user taps', async () => {
  const { port, service } = await startApi()
  const client = await connect(port)
  const id = await askInBackground(client)
  const pending = client.callTool({ name: 'wait_for_answer', arguments: { request_id: id } })
  service.tap(id, 0)
  expect(await pending).toEqual({
    content: [{ type: 'text', text: 'Approve' }],
    structuredContent: { state: 'done', answer: 'Approve', timed_out: false },
  })
})

test('wait_for_answer reports a timeout like ask_for_permission', async () => {
  const { port } = await startApi()
  const client = await connect(port)
  const id = await askInBackground(client, { timeout_seconds: 0.2 })
  expect(await client.callTool({ name: 'wait_for_answer', arguments: { request_id: id } })).toEqual(
    {
      content: [{ type: 'text', text: 'Decline (timed out, no answer from the user)' }],
      structuredContent: { state: 'done', answer: 'Decline', timed_out: true },
    },
  )
})

test('wait_seconds 0 checks once', async () => {
  const { port } = await startApi()
  const client = await connect(port)
  const id = await askInBackground(client)
  expect(
    await client.callTool({
      name: 'wait_for_answer',
      arguments: { request_id: id, wait_seconds: 0 },
    }),
  ).toEqual({
    content: [{ type: 'text', text: 'still waiting for the user' }],
    structuredContent: { state: 'pending' },
  })
})

test('wait_seconds running out reports the question as pending', async () => {
  const { port } = await startApi()
  const client = await connect(port)
  const id = await askInBackground(client)
  const startedAt = performance.now()
  const result = await client.callTool({
    name: 'wait_for_answer',
    arguments: { request_id: id, wait_seconds: 0.3 },
  })
  expect(performance.now() - startedAt).toBeGreaterThanOrEqual(300)
  expect(result).toEqual({
    content: [{ type: 'text', text: 'still waiting for the user' }],
    structuredContent: { state: 'pending' },
  })
})

test('a cancelled question is a normal result', async () => {
  const { port, service } = await startApi()
  const client = await connect(port)
  const id = await askInBackground(client)
  await service.cancel(id)
  expect(await client.callTool({ name: 'wait_for_answer', arguments: { request_id: id } })).toEqual(
    {
      content: [{ type: 'text', text: 'the question was cancelled' }],
      structuredContent: { state: 'cancelled' },
    },
  )
})

test('an unknown id is a tool error', async () => {
  const { port } = await startApi()
  const client = await connect(port)
  expect(
    await client.callTool({ name: 'wait_for_answer', arguments: { request_id: 'nope' } }),
  ).toEqual({
    isError: true,
    content: [
      {
        type: 'text',
        text: "jaypost doesn't know request nope (the service restarted, or the answer expired after 24 h)",
      },
    ],
  })
})

test('an old service is reported for background asks', async () => {
  const port = await startStub((_request, response) => {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({ message: 'Route POST:/request/async not found', statusCode: 404 }),
    )
  })
  const client = await connect(port)
  expect(
    await client.callTool({ name: 'ask_for_permission_in_background', arguments: ASK }),
  ).toEqual({
    isError: true,
    content: [{ type: 'text', text: BACKGROUND_TOO_OLD_MESSAGE }],
  })
})

test('cancelling wait_for_answer leaves the question open', async () => {
  const { port, service } = await startApi()
  const originalWaitFor = service.waitFor.bind(service)
  let pollCount = 0
  service.waitFor = (...args) => {
    pollCount += 1
    return originalWaitFor(...args)
  }
  const client = await connect(port)
  const id = await askInBackground(client)
  const controller = new AbortController()
  const pending = client.callTool(
    { name: 'wait_for_answer', arguments: { request_id: id } },
    undefined,
    { signal: controller.signal },
  )
  await waitFor(() => pollCount === 1)
  controller.abort()
  await expect(pending).rejects.toThrow()
  expect(
    await client.callTool({
      name: 'wait_for_answer',
      arguments: { request_id: id, wait_seconds: 0 },
    }),
  ).toEqual({
    content: [{ type: 'text', text: 'still waiting for the user' }],
    structuredContent: { state: 'pending' },
  })
  expect(service.get(id)?.kind).toBe('pending')
})

test('closing stdin cancels unsettled background questions', async () => {
  const { port, service, messenger } = await startApi()
  const client = await connect(port)
  const answered = await askInBackground(client)
  const open = await askInBackground(client, { text: 'Migrate?' })
  service.tap(answered, 0)
  await waitFor(() => messenger.finalized.length === 1)
  await client.close()
  await waitFor(() => messenger.finalized.length === 2)
  expect(messenger.finalized.map(({ settlement }) => settlement.kind)).toEqual([
    'answered',
    'cancelled',
  ])
  expect(service.get(open)).toEqual({ kind: 'cancelled' })
})

test('cancel_question cancels a pending question', async () => {
  const { port, service, messenger } = await startApi()
  const client = await connect(port)
  const id = await askInBackground(client)
  expect(await client.callTool({ name: 'cancel_question', arguments: { request_id: id } })).toEqual(
    {
      content: [{ type: 'text', text: 'the question was cancelled' }],
      structuredContent: { state: 'cancelled' },
    },
  )
  expect(service.get(id)).toEqual({ kind: 'cancelled' })
  expect(messenger.finalized.map(({ settlement }) => settlement.kind)).toEqual(['cancelled'])
})

test('cancel_question on an answered question returns the answer', async () => {
  const { port, service } = await startApi()
  const client = await connect(port)
  const id = await askInBackground(client)
  service.tap(id, 0)
  expect(await client.callTool({ name: 'cancel_question', arguments: { request_id: id } })).toEqual(
    {
      content: [{ type: 'text', text: 'Approve' }],
      structuredContent: { state: 'done', answer: 'Approve', timed_out: false },
    },
  )
})

test('cancel_question with an unknown id is a tool error', async () => {
  const { port } = await startApi()
  const client = await connect(port)
  expect(
    await client.callTool({ name: 'cancel_question', arguments: { request_id: 'nope' } }),
  ).toEqual({
    isError: true,
    content: [
      {
        type: 'text',
        text: "jaypost doesn't know request nope (the service restarted, or the answer expired after 24 h)",
      },
    ],
  })
})

test('list_questions shows the questions not yet collected or cancelled', async () => {
  const { port, service } = await startApi()
  const client = await connect(port)
  const collected = await askInBackground(client)
  const cancelled = await askInBackground(client, { text: 'Migrate?' })
  const answered = await askInBackground(client, { project_name: 'web', text: 'Merge?' })
  const open = await askInBackground(client, { text: 'Release?' })
  const expiresAt = (id: string) => {
    const state = service.get(id)
    return state?.kind === 'pending' ? state.expiresAt.toISOString() : ''
  }
  const answeredExpiresAt = expiresAt(answered)
  const openExpiresAt = expiresAt(open)
  service.tap(collected, 0)
  await client.callTool({ name: 'wait_for_answer', arguments: { request_id: collected } })
  await client.callTool({ name: 'cancel_question', arguments: { request_id: cancelled } })
  service.tap(answered, 1)
  expect(await client.callTool({ name: 'list_questions', arguments: {} })).toEqual({
    content: [
      {
        type: 'text',
        text: [
          `${answered} [web] "Merge?" (expires ${answeredExpiresAt})`,
          `${open} [api] "Release?" (expires ${openExpiresAt})`,
        ].join('\n'),
      },
    ],
    structuredContent: {
      questions: [
        {
          request_id: answered,
          project_name: 'web',
          text: 'Merge?',
          expires_at: answeredExpiresAt,
        },
        { request_id: open, project_name: 'api', text: 'Release?', expires_at: openExpiresAt },
      ],
    },
  })
})

test('list_questions with nothing open says so', async () => {
  const { port } = await startApi()
  const client = await connect(port)
  expect(await client.callTool({ name: 'list_questions', arguments: {} })).toEqual({
    content: [{ type: 'text', text: 'no open questions' }],
    structuredContent: { questions: [] },
  })
})

test('wait_for_answer sends progress while it waits', async () => {
  const { port, service } = await startApi()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer(
    new Caller({ endpoint: toLocalEndpoint(port), readToken: () => ({ kind: 'none' }) }),
    new AbortController().signal,
    { version: TEST_VERSION, progressIntervalMs: 50 },
  )
  await server.connect(serverTransport)
  const client = new Client({ name: 'test', version: '0.0.0' })
  clients.push(client)
  await client.connect(clientTransport)
  const id = await askInBackground(client)
  const progress: Progress[] = []
  const pending = client.callTool(
    { name: 'wait_for_answer', arguments: { request_id: id } },
    undefined,
    { onprogress: (event) => progress.push(event) },
  )
  await waitFor(() => progress.length >= 2)
  service.tap(id, 0)
  await pending
  await server.close()
  expect(progress[0]).toStrictEqual({
    progress: expect.any(Number),
    message: 'waiting for the user',
  })
})

test('cancelAll gives up after its timeout', async () => {
  const paths: string[] = []
  const port = await startStub((request) => {
    // Never answers, like a hung service.
    paths.push(`${request.method} ${request.url}`)
  })
  const openQuestions = new OpenQuestions()
  openQuestions.add(toOpenQuestion('a'))
  openQuestions.add(toOpenQuestion('b'))
  openQuestions.settle('b')
  const startedAt = performance.now()
  await openQuestions.cancelAll(
    new Caller({ endpoint: toLocalEndpoint(port), readToken: () => ({ kind: 'none' }) }),
    100,
  )
  expect(performance.now() - startedAt).toBeLessThan(1000)
  expect(paths).toEqual(['DELETE /request/a'])
})

test('cancelAll resolves when the service is down', async () => {
  const openQuestions = new OpenQuestions()
  openQuestions.add(toOpenQuestion('a'))
  const port = await freePort()
  await expect(
    openQuestions.cancelAll(
      new Caller({ endpoint: toLocalEndpoint(port), readToken: () => ({ kind: 'none' }) }),
    ),
  ).resolves.toBeUndefined()
})

test('cancelAll skips an unusable token', async () => {
  const paths: string[] = []
  const port = await startStub((request, response) => {
    paths.push(`${request.method} ${request.url}`)
    response.end('{}')
  })
  const openQuestions = new OpenQuestions()
  openQuestions.add(toOpenQuestion('a'))
  await openQuestions.cancelAll(
    new Caller({
      endpoint: toLocalEndpoint(port),
      readToken: () => ({ kind: 'unusable', message: 'bad token' }),
    }),
  )
  expect(paths).toEqual([])
})

test('an unknown id settles the open question', async () => {
  const { port } = await startApi()
  const caller = new Caller({
    endpoint: toLocalEndpoint(port),
    readToken: () => ({ kind: 'none' }),
  })
  const openQuestions = new OpenQuestions()
  openQuestions.add(toOpenQuestion('nope'))
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer(caller, new AbortController().signal, {
    version: TEST_VERSION,
    openQuestions,
  })
  await server.connect(serverTransport)
  const client = new Client({ name: 'test', version: '0.0.0' })
  clients.push(client)
  await client.connect(clientTransport)
  const result = await client.callTool({
    name: 'wait_for_answer',
    arguments: { request_id: 'nope' },
  })
  expect(result.isError).toBe(true)
  const paths: string[] = []
  const stubPort = await startStub((request, response) => {
    paths.push(`${request.method} ${request.url}`)
    response.end('{}')
  })
  await openQuestions.cancelAll(
    new Caller({ endpoint: toLocalEndpoint(stubPort), readToken: () => ({ kind: 'none' }) }),
  )
  expect(paths).toEqual([])
})
