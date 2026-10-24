import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { expect, test, vi } from 'vite-plus/test'
import {
  REJECTED_APP_TOKEN_FATAL,
  REJECTED_BOT_TOKEN_FATAL,
  REQUIRED_SCOPES,
  SOCKET_MODE_DISABLED_FATAL,
  createSlackClient,
  toIncomingAction,
  toIncomingCommand,
  toIncomingMessage,
  toPlainText,
} from '../../src/slack/index.ts'
import type {
  SlackClient,
  SocketConnection,
  SocketEvents,
  SocketListeners,
} from '../../src/slack/index.ts'

const BOT_TOKEN = 'xoxb-secret-bot'
const APP_TOKEN = 'xapp-secret-app'

type Recorded = {
  readonly url: string
  readonly authorization: string | undefined
  readonly form: URLSearchParams
  readonly body: Buffer
}

type Reply = {
  readonly status?: number
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
}

type Route = (url: string, request: Recorded) => Reply

type FakeSocket = {
  readonly url: string
  readonly listeners: SocketListeners
  readonly sent: unknown[]
  closed: boolean
}

const ALL_SCOPES = { 'x-oauth-scopes': REQUIRED_SCOPES.join(',') }

/** Answers like Slack: identity calls succeed, everything else is `ok: true` with a ts. */
const SLACK_DEFAULTS: Route = (url) => {
  switch (url) {
    case '/api/auth.test':
      return {
        headers: ALL_SCOPES,
        body: { ok: true, user_id: 'UBOT', user: 'jaypost', team_id: 'T1', bot_id: 'B1' },
      }
    case '/api/bots.info':
      return { body: { ok: true, bot: { id: 'B1', app_id: 'A1' } } }
    case '/api/apps.connections.open':
      return { body: { ok: true, url: 'wss://socket.test/1' } }
    default:
      return { body: { ok: true, channel: 'D1', ts: '1.0' } }
  }
}

async function withSlackApi(
  route: Route,
  run: (context: {
    readonly client: SlackClient
    readonly requests: Recorded[]
    readonly sockets: FakeSocket[]
    readonly apiRoot: string
  }) => Promise<void>,
): Promise<void> {
  const requests: Recorded[] = []
  const sockets: FakeSocket[] = []
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      const recorded: Recorded = {
        url: request.url ?? '',
        authorization: request.headers.authorization,
        form: new URLSearchParams(body.toString('utf8')),
        body,
      }
      requests.push(recorded)
      const reply = route(recorded.url, recorded)
      response.writeHead(reply.status ?? 200, {
        'content-type': 'application/json',
        ...reply.headers,
      })
      response.end(reply.body === undefined ? '' : JSON.stringify(reply.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const apiRoot = `http://127.0.0.1:${port}/api`
  const client = createSlackClient(BOT_TOKEN, APP_TOKEN, {
    apiRoot,
    timeoutMs: 5000,
    reconnectDelaysMs: { first: 0, longest: 0 },
    createSocket: (url: string, listeners: SocketListeners): SocketConnection => {
      const socket: FakeSocket = { url, listeners, sent: [], closed: false }
      sockets.push(socket)
      return {
        send: (data) => socket.sent.push(JSON.parse(data)),
        close: () => {
          socket.closed = true
        },
      }
    },
  })
  try {
    await run({ client, requests, sockets, apiRoot })
  } finally {
    await client.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
}

function withDefaults(route: (url: string, request: Recorded) => Reply | undefined): Route {
  return (url, request) => route(url, request) ?? SLACK_DEFAULTS(url, request)
}

async function closedApiRoot(): Promise<string> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise((resolve) => server.close(resolve))
  return `http://127.0.0.1:${port}/api`
}

function socketEvents() {
  return {
    ready: vi.fn(),
    message: vi.fn(),
    action: vi.fn(),
    command: vi.fn(),
    fatal: vi.fn<(message: string) => void>(),
  } satisfies SocketEvents
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(condition()).toBe(true)
}

function deliver(socket: FakeSocket | undefined, frame: unknown): void {
  socket?.listeners.message(JSON.stringify(frame))
}

const DM_EVENT = {
  type: 'message',
  channel: 'D1',
  channel_type: 'im',
  user: 'U1',
  text: 'hello',
  ts: '5.0',
}

test('getIdentity reads the bot, its app, and checks the app-level token', async () => {
  await withSlackApi(SLACK_DEFAULTS, async ({ client, requests }) => {
    expect(await client.getIdentity()).toEqual({
      kind: 'ok',
      userId: 'UBOT',
      botName: 'jaypost',
      teamId: 'T1',
      appId: 'A1',
    })
    expect(requests.map((request) => [request.url, request.authorization])).toEqual([
      ['/api/auth.test', `Bearer ${BOT_TOKEN}`],
      ['/api/bots.info', `Bearer ${BOT_TOKEN}`],
      ['/api/apps.connections.open', `Bearer ${APP_TOKEN}`],
    ])
    expect(requests[1]?.form.get('bot')).toBe('B1')
  })
})

test('getIdentity names the scopes the bot token lacks', async () => {
  await withSlackApi(
    withDefaults((url) =>
      url === '/api/auth.test'
        ? {
            headers: { 'x-oauth-scopes': 'chat:write,commands' },
            body: { ok: true, user_id: 'UBOT', user: 'jaypost', team_id: 'T1', bot_id: 'B1' },
          }
        : undefined,
    ),
    async ({ client }) => {
      expect(await client.getIdentity()).toEqual({
        kind: 'missingScopes',
        scopes: ['files:write', 'im:history', 'im:write', 'users:read'],
      })
    },
  )
})

test('getIdentity tells a refused bot token from a refused app-level token', async () => {
  await withSlackApi(
    withDefaults((url) =>
      url === '/api/auth.test' ? { body: { ok: false, error: 'invalid_auth' } } : undefined,
    ),
    async ({ client }) => {
      expect(await client.getIdentity()).toEqual({
        kind: 'rejected',
        token: 'bot',
        error: 'invalid_auth',
      })
    },
  )
  await withSlackApi(
    withDefaults((url) =>
      url === '/api/apps.connections.open'
        ? { body: { ok: false, error: 'not_allowed_token_type' } }
        : undefined,
    ),
    async ({ client }) => {
      expect(await client.getIdentity()).toEqual({
        kind: 'rejected',
        token: 'app',
        error: 'not_allowed_token_type',
      })
    },
  )
})

test('getIdentity reports a closed port as unreachable', async () => {
  const client = createSlackClient(BOT_TOKEN, APP_TOKEN, {
    apiRoot: await closedApiRoot(),
    timeoutMs: 5000,
  })
  expect(await client.getIdentity()).toEqual({ kind: 'unreachable' })
})

test('postMessage sends text, blocks, a thread and no unfurls as a form', async () => {
  await withSlackApi(SLACK_DEFAULTS, async ({ client, requests }) => {
    const blocks = [
      {
        type: 'rich_text',
        elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'hi' }] }],
      },
    ] as const
    expect(await client.postMessage('D1', { text: 'hi', blocks, threadTs: '3.0' })).toEqual({
      channelId: 'D1',
      ts: '1.0',
    })
    const [request] = requests
    expect(request?.url).toBe('/api/chat.postMessage')
    expect(Object.fromEntries(request?.form ?? [])).toEqual({
      channel: 'D1',
      text: 'hi',
      blocks: JSON.stringify(blocks),
      unfurl_links: 'false',
      unfurl_media: 'false',
      thread_ts: '3.0',
    })
  })
})

test('updateMessage, deleteMessage, postEphemeral and openDirectChannel call their methods', async () => {
  await withSlackApi(
    withDefaults((url) =>
      url === '/api/conversations.open' ? { body: { ok: true, channel: { id: 'D9' } } } : undefined,
    ),
    async ({ client, requests }) => {
      expect(await client.openDirectChannel('U1')).toBe('D9')
      await client.updateMessage('D1', '1.0', { text: 'done', blocks: [] })
      await client.deleteMessage('D1', '2.0')
      await client.postEphemeral('D1', 'U1', 'Expired')
      expect(requests.map((request) => [request.url, Object.fromEntries(request.form)])).toEqual([
        ['/api/conversations.open', { users: 'U1' }],
        ['/api/chat.update', { channel: 'D1', ts: '1.0', text: 'done', blocks: '[]' }],
        ['/api/chat.delete', { channel: 'D1', ts: '2.0' }],
        ['/api/chat.postEphemeral', { channel: 'D1', user: 'U1', text: 'Expired' }],
      ])
    },
  )
})

test('ok false rejects with the slack error code and no token', async () => {
  await withSlackApi(
    () => ({ body: { ok: false, error: 'channel_not_found' } }),
    async ({ client }) => {
      const error: unknown = await client.deleteMessage('D1', '1.0').catch((caught) => caught)
      expect(error).toMatchObject({ code: 'channel_not_found', method: 'chat.delete' })
      expect(String(error)).not.toContain(BOT_TOKEN)
    },
  )
})

test('a rate-limited request waits out retry-after and is sent once more', async () => {
  let calls = 0
  await withSlackApi(
    () => {
      calls += 1
      return calls === 1
        ? {
            status: 429,
            headers: { 'retry-after': '0' },
            body: { ok: false, error: 'ratelimited' },
          }
        : { body: { ok: true } }
    },
    async ({ client, requests }) => {
      await client.deleteMessage('D1', '1.0')
      expect(requests).toHaveLength(2)
    },
  )
})

test('uploadFile gets an upload url, posts the bytes and shares the file in the thread', async () => {
  let uploadUrl = ''
  await withSlackApi(
    withDefaults((url) =>
      url === '/api/files.getUploadURLExternal'
        ? { body: { ok: true, upload_url: uploadUrl, file_id: 'F1' } }
        : url === '/upload'
          ? { body: { ok: true } }
          : undefined,
    ),
    async ({ client, requests, apiRoot }) => {
      uploadUrl = `${apiRoot.replace(/\/api$/, '')}/upload`
      await client.uploadFile('D1', '1.0', {
        name: 'diff.txt',
        content: new TextEncoder().encode('abc'),
      })
      expect(requests.map((request) => request.url)).toEqual([
        '/api/files.getUploadURLExternal',
        '/upload',
        '/api/files.completeUploadExternal',
      ])
      expect(Object.fromEntries(requests[0]?.form ?? [])).toEqual({
        filename: 'diff.txt',
        length: '3',
      })
      expect(requests[1]?.body.toString('utf8')).toBe('abc')
      expect(requests[1]?.authorization).toBeUndefined()
      expect(Object.fromEntries(requests[2]?.form ?? [])).toEqual({
        files: JSON.stringify([{ id: 'F1', title: 'diff.txt' }]),
        channel_id: 'D1',
        thread_ts: '1.0',
      })
    },
  )
})

test('after connect, a bot call refused for auth is fatal without the token', async () => {
  await withSlackApi(
    withDefaults((url) =>
      url === '/api/chat.delete' ? { body: { ok: false, error: 'token_revoked' } } : undefined,
    ),
    async ({ client }) => {
      const events = socketEvents()
      await expect(client.deleteMessage('D1', '1.0')).rejects.toThrow('token_revoked')
      client.connect(events)
      await expect(client.deleteMessage('D1', '1.0')).rejects.toThrow('token_revoked')
      expect(events.fatal.mock.calls).toEqual([[REJECTED_BOT_TOKEN_FATAL]])
    },
  )
})

test('connect opens a socket, reports ready on hello, and acknowledges every envelope', async () => {
  await withSlackApi(SLACK_DEFAULTS, async ({ client, sockets, requests }) => {
    const events = socketEvents()
    client.connect(events)
    await waitFor(() => sockets.length === 1)
    expect(sockets[0]?.url).toBe('wss://socket.test/1')
    expect(requests.at(-1)?.authorization).toBe(`Bearer ${APP_TOKEN}`)
    deliver(sockets[0], { type: 'hello', num_connections: 1 })
    expect(events.ready).toHaveBeenCalledTimes(1)
    deliver(sockets[0], {
      envelope_id: 'e1',
      type: 'events_api',
      payload: { event_id: 'Ev1', event: DM_EVENT },
    })
    deliver(sockets[0], {
      envelope_id: 'e2',
      type: 'interactive',
      payload: {
        type: 'block_actions',
        user: { id: 'U1' },
        channel: { id: 'D1' },
        container: { message_ts: '1.0', channel_id: 'D1' },
        actions: [{ type: 'button', action_id: 'r1:0', value: 'r1:0' }],
      },
    })
    deliver(sockets[0], {
      envelope_id: 'e3',
      type: 'slash_commands',
      payload: { user_id: 'U1', channel_id: 'D1', command: '/jaypost', text: 'history 3' },
    })
    expect(sockets[0]?.sent).toEqual([
      { envelope_id: 'e1' },
      { envelope_id: 'e2' },
      { envelope_id: 'e3' },
    ])
    expect(events.message.mock.calls).toEqual([[toIncomingMessage(DM_EVENT)]])
    expect(events.action.mock.calls).toEqual([
      [{ userId: 'U1', channelId: 'D1', messageTs: '1.0', isDirect: true, actionId: 'r1:0' }],
    ])
    expect(events.command.mock.calls).toEqual([
      [{ userId: 'U1', channelId: 'D1', isDirect: true, text: 'history 3' }],
    ])
  })
})

test('a retried event is acknowledged again but dispatched once', async () => {
  await withSlackApi(SLACK_DEFAULTS, async ({ client, sockets }) => {
    const events = socketEvents()
    client.connect(events)
    await waitFor(() => sockets.length === 1)
    deliver(sockets[0], { type: 'hello' })
    for (const envelopeId of ['e1', 'e2']) {
      deliver(sockets[0], {
        envelope_id: envelopeId,
        type: 'events_api',
        retry_attempt: envelopeId === 'e2' ? 1 : 0,
        payload: { event_id: 'Ev1', event: DM_EVENT },
      })
    }
    expect(sockets[0]?.sent).toHaveLength(2)
    expect(events.message).toHaveBeenCalledTimes(1)
  })
})

test('a refresh request opens a replacement and closes the old socket once it says hello', async () => {
  await withSlackApi(SLACK_DEFAULTS, async ({ client, sockets }) => {
    const events = socketEvents()
    client.connect(events)
    await waitFor(() => sockets.length === 1)
    deliver(sockets[0], { type: 'hello' })
    deliver(sockets[0], { type: 'disconnect', reason: 'refresh_requested' })
    await waitFor(() => sockets.length === 2)
    expect(sockets[0]?.closed).toBe(false)
    deliver(sockets[1], { type: 'hello' })
    expect(sockets[0]?.closed).toBe(true)
    sockets[0]?.listeners.close()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sockets).toHaveLength(2)
    expect(events.ready).toHaveBeenCalledTimes(1)
  })
})

test('a dropped socket reconnects', async () => {
  await withSlackApi(SLACK_DEFAULTS, async ({ client, sockets }) => {
    client.connect(socketEvents())
    await waitFor(() => sockets.length === 1)
    deliver(sockets[0], { type: 'hello' })
    sockets[0]?.listeners.close()
    await waitFor(() => sockets.length === 2)
  })
})

test('socket mode turned off is fatal', async () => {
  await withSlackApi(SLACK_DEFAULTS, async ({ client, sockets }) => {
    const events = socketEvents()
    client.connect(events)
    await waitFor(() => sockets.length === 1)
    deliver(sockets[0], { type: 'disconnect', reason: 'link_disabled' })
    expect(events.fatal.mock.calls).toEqual([[SOCKET_MODE_DISABLED_FATAL]])
  })
})

test('a refused app-level token on connect is fatal without the token', async () => {
  await withSlackApi(
    () => ({ body: { ok: false, error: 'invalid_auth' } }),
    async ({ client, sockets }) => {
      const events = socketEvents()
      client.connect(events)
      await waitFor(() => events.fatal.mock.calls.length === 1)
      expect(events.fatal.mock.calls).toEqual([[REJECTED_APP_TOKEN_FATAL]])
      expect(sockets).toHaveLength(0)
    },
  )
})

test('nothing reaches the events after destroy, and destroy closes the socket', async () => {
  await withSlackApi(SLACK_DEFAULTS, async ({ client, sockets }) => {
    const events = socketEvents()
    client.connect(events)
    await waitFor(() => sockets.length === 1)
    deliver(sockets[0], { type: 'hello' })
    await client.destroy()
    expect(sockets[0]?.closed).toBe(true)
    deliver(sockets[0], { envelope_id: 'e1', type: 'events_api', payload: { event: DM_EVENT } })
    sockets[0]?.listeners.close()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events.message).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(1)
  })
})

test('a second connect is a RangeError', async () => {
  await withSlackApi(SLACK_DEFAULTS, async ({ client }) => {
    client.connect(socketEvents())
    expect(() => client.connect(socketEvents())).toThrow(RangeError)
  })
})

test('toIncomingMessage reads a dm thread reply with its unescaped text', () => {
  expect(
    toIncomingMessage({
      ...DM_EVENT,
      text: 'a &lt;b&gt; &amp; <https://x.io|x.io> <https://y.io>',
      thread_ts: '1.0',
      parent_user_id: 'UBOT',
    }),
  ).toEqual({
    channelId: 'D1',
    ts: '5.0',
    fromId: 'U1',
    fromBot: false,
    isDirect: true,
    text: 'a <b> & x.io https://y.io',
    thread: { ts: '1.0', parentUserId: 'UBOT' },
  })
})

test('toIncomingMessage marks bot messages and drops edits and deletes', () => {
  expect(toIncomingMessage({ ...DM_EVENT, bot_id: 'B1' })?.fromBot).toBe(true)
  expect(toIncomingMessage({ ...DM_EVENT, subtype: 'message_changed' })).toBeUndefined()
  expect(toIncomingMessage({ ...DM_EVENT, subtype: 'message_deleted' })).toBeUndefined()
  expect(toIncomingMessage({ ...DM_EVENT, subtype: 'file_share', text: '' })).toMatchObject({
    fromBot: false,
    text: undefined,
  })
})

test('toIncomingMessage treats a thread parent as top level and a channel as not direct', () => {
  expect(toIncomingMessage({ ...DM_EVENT, thread_ts: '5.0' })?.thread).toBeUndefined()
  expect(toIncomingMessage({ ...DM_EVENT, channel: 'C1', channel_type: 'channel' })?.isDirect).toBe(
    false,
  )
  expect(toIncomingMessage({ type: 'reaction_added' })).toBeUndefined()
  expect(toIncomingMessage('nope')).toBeUndefined()
})

test('toIncomingAction reads the first button and drops other payloads', () => {
  expect(
    toIncomingAction({
      type: 'block_actions',
      user: { id: 'U1' },
      channel: { id: 'C1' },
      container: { message_ts: '1.0' },
      actions: [{ type: 'button', action_id: 'dismiss/n1' }],
    }),
  ).toEqual({
    userId: 'U1',
    channelId: 'C1',
    messageTs: '1.0',
    isDirect: false,
    actionId: 'dismiss/n1',
  })
  expect(toIncomingAction({ type: 'view_submission' })).toBeUndefined()
  expect(
    toIncomingAction({
      type: 'block_actions',
      channel: { id: 'D1' },
      container: { message_ts: '1.0' },
      actions: [{ type: 'static_select', action_id: 'x' }],
    }),
  ).toBeUndefined()
})

test('toIncomingCommand reads a slash command in a dm or a channel', () => {
  expect(
    toIncomingCommand({
      user_id: 'U1',
      channel_id: 'D1',
      text: 'mute 2h',
      channel_name: 'directmessage',
    }),
  ).toEqual({ userId: 'U1', channelId: 'D1', isDirect: true, text: 'mute 2h' })
  expect(toIncomingCommand({ user_id: 'U1', channel_id: 'C1', channel_name: 'general' })).toEqual({
    userId: 'U1',
    channelId: 'C1',
    isDirect: false,
    text: '',
  })
  expect(toIncomingCommand({})).toBeUndefined()
})

test('toPlainText keeps mentions as their target', () => {
  expect(toPlainText('<@U1> said &amp;')).toBe('@U1 said &')
})
