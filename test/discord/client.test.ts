import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { expect, test, vi } from 'vite-plus/test'
import {
  REJECTED_TOKEN_FATAL,
  createDiscordClient,
  toIncomingInteraction,
  toIncomingMessage,
} from '../../src/discord/index.ts'
import type { DiscordClient, GatewayEvents, OutgoingMessage } from '../../src/discord/index.ts'

const TOKEN = 'SECRET.BOT.TOKEN'

type Recorded = {
  readonly method: string
  readonly url: string
  readonly authorization: string | undefined
  readonly contentType: string
  readonly body: Buffer
}

type Route = (method: string, url: string) => { status: number; body?: unknown }

async function withDiscordApi(
  route: Route,
  run: (client: DiscordClient, requests: Recorded[], apiRoot: string) => Promise<void>,
): Promise<void> {
  const requests: Recorded[] = []
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const method = request.method ?? ''
      // discord.js encodes @me as %40me in some routes
      const url = decodeURIComponent(request.url ?? '')
      requests.push({
        method,
        url,
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'] ?? '',
        body: Buffer.concat(chunks),
      })
      const { status, body } = route(method, url)
      if (body === undefined) {
        response.writeHead(status)
        response.end()
        return
      }
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const apiRoot = `http://127.0.0.1:${port}/api`
  const client = createDiscordClient(TOKEN, { apiRoot, timeoutMs: 5000 })
  try {
    await run(client, requests, apiRoot)
  } finally {
    await client.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
}

async function closedApiRoot(): Promise<string> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise((resolve) => server.close(resolve))
  return `http://127.0.0.1:${port}/api`
}

async function readForm(request: Recorded): Promise<FormData> {
  const body = new Uint8Array(request.body)
  return new Response(body, { headers: { 'content-type': request.contentType } }).formData()
}

function readJson(request: Recorded): unknown {
  return JSON.parse(request.body.toString('utf8'))
}

const unauthorized = { status: 401, body: { message: '401: Unauthorized', code: 0 } }

const SENT = { id: '77', channel_id: '9' }

const PLAIN: OutgoingMessage = { content: 'hi', rows: [], silent: false, file: undefined }

test('getIdentity reads the bot user and application', async () => {
  await withDiscordApi(
    (_method, url) =>
      url === '/api/v10/users/@me'
        ? { status: 200, body: { id: '111', username: 'mybot' } }
        : { status: 200, body: { id: '222' } },
    async (client, requests) => {
      expect(await client.getIdentity()).toEqual({
        kind: 'ok',
        userId: '111',
        username: 'mybot',
        applicationId: '222',
      })
      expect(requests.map((request) => request.url).toSorted()).toEqual([
        '/api/v10/applications/@me',
        '/api/v10/users/@me',
      ])
      expect(requests.map((request) => request.authorization)).toEqual([
        `Bot ${TOKEN}`,
        `Bot ${TOKEN}`,
      ])
    },
  )
})

test('getIdentity reports a 401 as rejected', async () => {
  await withDiscordApi(
    () => unauthorized,
    async (client) => {
      expect(await client.getIdentity()).toEqual({ kind: 'rejected', status: 401 })
    },
  )
})

test('getIdentity reports a closed port as unreachable', async () => {
  const client = createDiscordClient(TOKEN, { apiRoot: await closedApiRoot(), timeoutMs: 5000 })
  expect(await client.getIdentity()).toEqual({ kind: 'unreachable' })
})

test('openDirectChannel creates a dm and returns its id', async () => {
  await withDiscordApi(
    () => ({ status: 200, body: { id: '9', type: 1 } }),
    async (client, requests) => {
      expect(await client.openDirectChannel('555')).toBe('9')
      expect(requests[0]?.method).toBe('POST')
      expect(requests[0]?.url).toBe('/api/v10/users/@me/channels')
      expect(readJson(requests[0] as Recorded)).toEqual({ recipient_id: '555' })
    },
  )
})

test('createMessage sends content, buttons, file and no mentions in one request', async () => {
  await withDiscordApi(
    () => ({ status: 200, body: SENT }),
    async (client, requests) => {
      const sent = await client.createMessage('9', {
        content: 'hi',
        rows: [[{ label: 'Yes', customId: 'r:0' }]],
        silent: false,
        file: { name: 'notes.txt', content: new TextEncoder().encode('file bytes') },
      })
      expect(sent).toEqual({ id: '77', channelId: '9' })
      expect(requests).toHaveLength(1)
      const request = requests[0] as Recorded
      expect(request.method).toBe('POST')
      expect(request.url).toBe('/api/v10/channels/9/messages')
      const form = await readForm(request)
      expect(JSON.parse(String(form.get('payload_json')))).toMatchObject({
        content: 'hi',
        allowed_mentions: { parse: [] },
        flags: 4,
        components: [
          { type: 1, components: [{ type: 2, style: 2, label: 'Yes', custom_id: 'r:0' }] },
        ],
      })
      const file = form.get('files[0]')
      expect(file).toBeInstanceOf(Blob)
      expect(await (file as Blob).text()).toBe('file bytes')
      expect((file as File).name).toBe('notes.txt')
    },
  )
})

test('createMessage without buttons or file sends plain json', async () => {
  await withDiscordApi(
    () => ({ status: 200, body: SENT }),
    async (client, requests) => {
      await client.createMessage('9', PLAIN)
      expect(readJson(requests[0] as Recorded)).toEqual({
        content: 'hi',
        allowed_mentions: { parse: [] },
        flags: 4,
        components: [],
      })
    },
  )
})

test('silent sets the suppress-notifications flag', async () => {
  await withDiscordApi(
    () => ({ status: 200, body: SENT }),
    async (client, requests) => {
      await client.createMessage('9', { ...PLAIN, silent: true })
      expect(readJson(requests[0] as Recorded)).toMatchObject({ flags: 4 | 4096 })
    },
  )
})

test('a reply references the message it answers', async () => {
  await withDiscordApi(
    () => ({ status: 200, body: SENT }),
    async (client, requests) => {
      await client.createMessage('9', { ...PLAIN, replyToMessageId: '42' })
      expect(readJson(requests[0] as Recorded)).toMatchObject({
        message_reference: { message_id: '42' },
      })
    },
  )
})

test('editMessage removes buttons only when asked', async () => {
  await withDiscordApi(
    () => ({ status: 200, body: SENT }),
    async (client, requests) => {
      await client.editMessage('9', '77', 'done', true)
      await client.editMessage('9', '77', 'again', false)
      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        'PATCH /api/v10/channels/9/messages/77',
        'PATCH /api/v10/channels/9/messages/77',
      ])
      expect(readJson(requests[0] as Recorded)).toEqual({
        content: 'done',
        allowed_mentions: { parse: [] },
        flags: 4,
        components: [],
      })
      expect(readJson(requests[1] as Recorded)).toEqual({
        content: 'again',
        allowed_mentions: { parse: [] },
        flags: 4,
      })
    },
  )
})

test('deleteMessage deletes the message', async () => {
  await withDiscordApi(
    () => ({ status: 204 }),
    async (client, requests) => {
      await client.deleteMessage('9', '77')
      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        'DELETE /api/v10/channels/9/messages/77',
      ])
    },
  )
})

test('respond acknowledges a tap with a deferred update', async () => {
  await withDiscordApi(
    () => ({ status: 204 }),
    async (client, requests) => {
      await client.respond({ id: '5', token: 'itoken' }, { kind: 'acknowledge' })
      expect(requests[0]?.url).toMatch(/^\/api\/v10\/interactions\/5\/itoken\/callback/)
      expect(readJson(requests[0] as Recorded)).toEqual({ type: 6 })
    },
  )
})

test('respond sends an ephemeral message without mentions', async () => {
  await withDiscordApi(
    () => ({ status: 204 }),
    async (client, requests) => {
      await client.respond(
        { id: '5', token: 'itoken' },
        { kind: 'message', content: 'Expired', ephemeral: true },
      )
      await client.respond(
        { id: '6', token: 'itoken' },
        { kind: 'message', content: 'Muted', ephemeral: false },
      )
      expect(readJson(requests[0] as Recorded)).toEqual({
        type: 4,
        data: { content: 'Expired', allowed_mentions: { parse: [] }, flags: 64 },
      })
      expect(readJson(requests[1] as Recorded)).toEqual({
        type: 4,
        data: { content: 'Muted', allowed_mentions: { parse: [] } },
      })
    },
  )
})

test('setCommands writes dm-only global commands', async () => {
  await withDiscordApi(
    () => ({ status: 200, body: [] }),
    async (client, requests) => {
      await client.setCommands('222', [
        { name: 'status', description: 'Show status' },
        {
          name: 'mute',
          description: 'Mute',
          option: { name: 'duration', description: 'How long' },
        },
        {
          name: 'history',
          description: 'Show recent answers',
          option: { name: 'count', description: 'How many answers to show (1-20)' },
        },
      ])
      expect(requests[0]?.method).toBe('PUT')
      expect(requests[0]?.url).toBe('/api/v10/applications/222/commands')
      const body = readJson(requests[0] as Recorded) as unknown[]
      expect(body[0]).toEqual({
        name: 'status',
        description: 'Show status',
        type: 1,
        contexts: [1],
        integration_types: [0],
      })
      expect(body[2]).toEqual({
        name: 'history',
        description: 'Show recent answers',
        type: 1,
        contexts: [1],
        integration_types: [0],
        options: [
          {
            type: 3,
            name: 'count',
            description: 'How many answers to show (1-20)',
            required: false,
          },
        ],
      })
    },
  )
})

test('connect with a rejected token calls fatal without the token', async () => {
  await withDiscordApi(
    () => unauthorized,
    async (client, requests) => {
      const fatal = vi.fn()
      const called = new Promise<void>((resolve) => {
        fatal.mockImplementation(() => resolve())
      })
      const events: GatewayEvents = {
        ready: vi.fn(),
        message: vi.fn(),
        interaction: vi.fn(),
        fatal,
      }
      expect(() => client.connect(events)).not.toThrow()
      await called
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(fatal.mock.calls).toEqual([[REJECTED_TOKEN_FATAL]])
      expect(String(fatal.mock.calls[0])).not.toContain(TOKEN)
      expect(requests[0]?.url).toBe('/api/v10/gateway/bot')
    },
  )
})

test('connect to an unreachable api calls fatal with the cause', async () => {
  const client = createDiscordClient(TOKEN, { apiRoot: await closedApiRoot(), timeoutMs: 5000 })
  const fatal = vi.fn()
  const called = new Promise<void>((resolve) => {
    fatal.mockImplementation(() => resolve())
  })
  client.connect({ ready: vi.fn(), message: vi.fn(), interaction: vi.fn(), fatal })
  await called
  await client.destroy()
  expect(fatal).toHaveBeenCalledOnce()
  expect(String(fatal.mock.calls[0]?.[0])).toMatch(/^could not connect to Discord: /)
  expect(String(fatal.mock.calls[0]?.[0])).not.toContain(TOKEN)
})

const DM_REPLY = {
  id: '30',
  channel_id: '9',
  content: 'sounds good',
  author: { id: '555', username: 'owner' },
  message_reference: { message_id: '77', channel_id: '9' },
  referenced_message: { id: '77', author: { id: '111', username: 'mybot', bot: true } },
} as Parameters<typeof toIncomingMessage>[0]

test('toIncomingMessage reads a dm reply to the bot', () => {
  expect(toIncomingMessage(DM_REPLY)).toEqual({
    id: '30',
    channelId: '9',
    fromId: '555',
    fromBot: false,
    isDirect: true,
    text: 'sounds good',
    replyTo: { messageId: '77', fromId: '111' },
  })
})

test('toIncomingMessage reads a guild message from a bot without a reply', () => {
  const message = {
    id: '31',
    channel_id: '8',
    guild_id: '1',
    content: 'beep',
    author: { id: '600', username: 'other', bot: true },
  } as Parameters<typeof toIncomingMessage>[0]
  expect(toIncomingMessage(message)).toEqual({
    id: '31',
    channelId: '8',
    fromId: '600',
    fromBot: true,
    isDirect: false,
    text: 'beep',
    replyTo: undefined,
  })
})

test('toIncomingMessage keeps a reply whose original was deleted', () => {
  const message = { ...DM_REPLY, referenced_message: null } as Parameters<
    typeof toIncomingMessage
  >[0]
  expect(toIncomingMessage(message).replyTo).toEqual({ messageId: '77', fromId: undefined })
})

test('toIncomingMessage maps empty content to undefined text', () => {
  expect(toIncomingMessage({ ...DM_REPLY, content: '' }).text).toBeUndefined()
})

test('toIncomingInteraction reads a button tap and a command with its argument', () => {
  const tap = {
    id: '5',
    token: 'itoken',
    type: 3,
    user: { id: '555', username: 'owner' },
    channel: { id: '9', type: 1 },
    channel_id: '9',
    message: { id: '77' },
    data: { component_type: 2, custom_id: 'r:0' },
  } as Parameters<typeof toIncomingInteraction>[0]
  expect(toIncomingInteraction(tap)).toEqual({
    kind: 'button',
    id: '5',
    token: 'itoken',
    userId: '555',
    isDirect: true,
    customId: 'r:0',
    channelId: '9',
    messageId: '77',
  })
  const command = {
    id: '6',
    token: 'ctoken',
    type: 2,
    guild_id: '1',
    member: { user: { id: '555', username: 'owner' } },
    data: { type: 1, name: 'mute', options: [{ type: 3, name: 'duration', value: '2h' }] },
  } as Parameters<typeof toIncomingInteraction>[0]
  expect(toIncomingInteraction(command)).toEqual({
    kind: 'command',
    id: '6',
    token: 'ctoken',
    userId: '555',
    isDirect: false,
    name: 'mute',
    argument: '2h',
  })
})

test('toIncomingInteraction gives a command without options an empty argument', () => {
  const command = {
    id: '6',
    token: 'ctoken',
    type: 2,
    user: { id: '555', username: 'owner' },
    data: { type: 1, name: 'status' },
  } as Parameters<typeof toIncomingInteraction>[0]
  expect(toIncomingInteraction(command)).toEqual({
    kind: 'command',
    id: '6',
    token: 'ctoken',
    userId: '555',
    isDirect: true,
    name: 'status',
    argument: '',
  })
})

test('toIncomingInteraction maps anything else to other', () => {
  const ping = { id: '7', token: 'ptoken', type: 1 } as Parameters<typeof toIncomingInteraction>[0]
  expect(toIncomingInteraction(ping)).toEqual({ kind: 'other', id: '7', token: 'ptoken' })
})
