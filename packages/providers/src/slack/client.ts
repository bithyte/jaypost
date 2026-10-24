import { setTimeout as delay } from 'node:timers/promises'
import {
  FATAL_API_ERRORS,
  MAX_RETRY_AFTER_MS,
  MRKDWN_REFERENCE_PATTERN,
  RECONNECT_DELAYS_MS,
  REJECTED_APP_TOKEN_FATAL,
  REJECTED_BOT_TOKEN_FATAL,
  REQUEST_TIMEOUT_MS,
  REQUIRED_SCOPES,
  SEEN_EVENT_LIMIT,
  SLACK_API_ROOT,
  SOCKET_MODE_DISABLED_FATAL,
} from './constants.ts'
import type {
  IncomingAction,
  IncomingCommand,
  IncomingMessage,
  SlackClient,
  SlackClientOptions,
  SlackIdentity,
  SocketConnection,
  SocketEvents,
  SocketListeners,
} from './types.ts'

type Json = Readonly<Record<string, unknown>>

type ApiResult = { readonly body: Json; readonly scopes: string | null }

/** Internal: tests replace the real websocket and the reconnect waits; not exported from index.ts. */
type SocketOptions = {
  readonly createSocket?: (url: string, listeners: SocketListeners) => SocketConnection
  readonly reconnectDelaysMs?: { readonly first: number; readonly longest: number }
}

/** Slack answered `ok: false`; `code` is its error string, never a token. */
export class SlackApiError extends Error {
  public readonly method: string
  public readonly code: string

  public constructor(method: string, code: string) {
    super(`slack ${method} failed: ${code}`)
    this.name = 'SlackApiError'
    this.method = method
    this.code = code
  }
}

/** Message subtypes a person sends; every other subtype is an edit, a delete or a channel event. */
const USER_SUBTYPES: readonly (string | undefined)[] = [undefined, 'file_share', 'thread_broadcast']

/**
 * A `SlackClient` over `fetch` with the bot token, plus Socket Mode with the app-level token,
 * opened only in `connect`. A rate-limited request waits out `Retry-After` once. After `connect`, a
 * bot-token call that Slack refuses for auth is fatal. No token is ever put in an error or fatal
 * message.
 */
export function createSlackClient(
  botToken: string,
  appToken: string,
  options: SlackClientOptions & SocketOptions = {},
): SlackClient {
  const apiRoot = options.apiRoot ?? SLACK_API_ROOT
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const createSocket = options.createSocket ?? openWebSocket
  const delays = options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS
  let hasConnected = false
  let isDestroyed = false
  let fatal: ((message: string) => void) | undefined
  let active: SocketConnection | undefined
  let pending: SocketConnection | undefined
  let isOpening = false
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  async function call(
    method: string,
    token: string,
    params: Readonly<Record<string, string | undefined>>,
  ): Promise<ApiResult> {
    const body = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        body.set(key, value)
      }
    }
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${apiRoot}/${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.status === 429 && attempt === 0) {
        await response.body?.cancel()
        const retryAfterSeconds = Number(response.headers.get('retry-after') ?? 1)
        await delay(
          Number.isFinite(retryAfterSeconds)
            ? Math.min(retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS)
            : MAX_RETRY_AFTER_MS,
        )
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new SlackApiError(method, `http ${response.status}`)
      }
      const parsed: unknown = await response.json()
      if (!isJson(parsed)) {
        throw new SlackApiError(method, 'invalid response')
      }
      if (parsed.ok !== true) {
        throw new SlackApiError(method, typeof parsed.error === 'string' ? parsed.error : 'unknown')
      }
      return { body: parsed, scopes: response.headers.get('x-oauth-scopes') }
    }
  }
  async function callBot(
    method: string,
    params: Readonly<Record<string, string | undefined>>,
  ): Promise<Json> {
    try {
      return (await call(method, botToken, params)).body
    } catch (error) {
      if (error instanceof SlackApiError && FATAL_API_ERRORS.includes(error.code)) {
        fatal?.(REJECTED_BOT_TOKEN_FATAL)
      }
      throw error
    }
  }
  async function openSocketUrl(): Promise<string> {
    const { body } = await call('apps.connections.open', appToken, {})
    if (typeof body.url !== 'string') {
      throw new SlackApiError('apps.connections.open', 'no url')
    }
    return body.url
  }
  return {
    async getIdentity(): Promise<SlackIdentity> {
      let auth: ApiResult
      try {
        auth = await call('auth.test', botToken, {})
      } catch (error) {
        return error instanceof SlackApiError
          ? { kind: 'rejected', token: 'bot', error: error.code }
          : { kind: 'unreachable' }
      }
      const granted = auth.scopes?.split(',').map((scope) => scope.trim())
      const missing = REQUIRED_SCOPES.filter((scope) => granted?.includes(scope) === false)
      if (missing.length > 0) {
        return { kind: 'missingScopes', scopes: missing }
      }
      let appId: unknown
      try {
        const info = await call('bots.info', botToken, { bot: readString(auth.body, 'bot_id') })
        appId = isJson(info.body.bot) ? info.body.bot.app_id : undefined
        await openSocketUrl()
      } catch (error) {
        if (!(error instanceof SlackApiError)) {
          return { kind: 'unreachable' }
        }
        return {
          kind: 'rejected',
          token: error.method === 'apps.connections.open' ? 'app' : 'bot',
          error: error.code,
        }
      }
      return {
        kind: 'ok',
        userId: readString(auth.body, 'user_id') ?? '',
        botName: readString(auth.body, 'user') ?? '',
        teamId: readString(auth.body, 'team_id') ?? '',
        appId: typeof appId === 'string' ? appId : '',
      }
    },
    async openDirectChannel(userId) {
      const body = await callBot('conversations.open', { users: userId })
      const channelId = isJson(body.channel) ? body.channel.id : undefined
      if (typeof channelId !== 'string') {
        throw new SlackApiError('conversations.open', 'no channel')
      }
      return channelId
    },
    async postMessage(channelId, message) {
      const body = await callBot('chat.postMessage', {
        channel: channelId,
        text: message.text,
        blocks: JSON.stringify(message.blocks),
        unfurl_links: 'false',
        unfurl_media: 'false',
        thread_ts: message.threadTs,
      })
      const ts = readString(body, 'ts')
      if (ts === undefined) {
        throw new SlackApiError('chat.postMessage', 'no ts')
      }
      return { channelId: readString(body, 'channel') ?? channelId, ts }
    },
    async updateMessage(channelId, ts, message) {
      await callBot('chat.update', {
        channel: channelId,
        ts,
        text: message.text,
        blocks: JSON.stringify(message.blocks),
      })
    },
    async deleteMessage(channelId, ts) {
      await callBot('chat.delete', { channel: channelId, ts })
    },
    async postEphemeral(channelId, userId, text) {
      await callBot('chat.postEphemeral', { channel: channelId, user: userId, text })
    },
    async uploadFile(channelId, threadTs, file) {
      const target = await callBot('files.getUploadURLExternal', {
        filename: file.name,
        length: String(file.content.byteLength),
      })
      const uploadUrl = readString(target, 'upload_url')
      const fileId = readString(target, 'file_id')
      if (uploadUrl === undefined || fileId === undefined) {
        throw new SlackApiError('files.getUploadURLExternal', 'no upload url')
      }
      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from(file.content),
        signal: AbortSignal.timeout(timeoutMs),
      })
      await response.body?.cancel()
      if (!response.ok) {
        throw new SlackApiError('file upload', `http ${response.status}`)
      }
      await callBot('files.completeUploadExternal', {
        files: JSON.stringify([{ id: fileId, title: file.name }]),
        channel_id: channelId,
        thread_ts: threadTs,
      })
    },
    connect(events) {
      if (hasConnected) {
        throw new RangeError('slack client connect called twice')
      }
      hasConnected = true
      let isFatal = false
      let isReady = false
      let nextDelayMs = delays.first
      const seenEventIds: string[] = []
      fatal = (message) => {
        if (isFatal || isDestroyed) {
          return
        }
        isFatal = true
        events.fatal(message)
      }
      const schedule = (): void => {
        if (isDestroyed || isFatal) {
          return
        }
        clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(() => {
          void open(false)
        }, nextDelayMs)
        nextDelayMs = Math.min(nextDelayMs * 2, delays.longest)
      }
      // A replacement opens while the current connection still works; Slack asks for one before
      // it drops a connection, which it does every few hours
      const open = async (isReplacement: boolean): Promise<void> => {
        if (isDestroyed || isFatal || isOpening || (active !== undefined && !isReplacement)) {
          return
        }
        isOpening = true
        let url: string
        try {
          url = await openSocketUrl()
        } catch (error) {
          isOpening = false
          if (
            error instanceof SlackApiError &&
            [...FATAL_API_ERRORS, 'not_allowed_token_type'].includes(error.code)
          ) {
            fatal?.(REJECTED_APP_TOKEN_FATAL)
            return
          }
          if (active === undefined) {
            schedule()
          }
          return
        }
        if (isDestroyed) {
          isOpening = false
          return
        }
        const connection: SocketConnection = createSocket(url, {
          message: (data) => receive(connection, data),
          close: () => closed(connection),
        })
        pending = connection
      }
      const closed = (connection: SocketConnection): void => {
        if (connection === pending) {
          pending = undefined
          isOpening = false
          if (active === undefined) {
            schedule()
          }
          return
        }
        if (connection === active) {
          active = undefined
          if (!isOpening) {
            schedule()
          }
        }
      }
      const receive = (connection: SocketConnection, data: string): void => {
        if (isDestroyed) {
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(data)
        } catch {
          // Not JSON, so not a frame Slack documents; nothing to answer
          return
        }
        if (!isJson(parsed)) {
          return
        }
        if (parsed.type === 'hello') {
          if (connection === pending) {
            const previous = active
            active = connection
            pending = undefined
            isOpening = false
            previous?.close()
          }
          nextDelayMs = delays.first
          if (!isReady) {
            isReady = true
            events.ready()
          }
          return
        }
        if (parsed.type === 'disconnect') {
          if (parsed.reason === 'link_disabled') {
            fatal?.(SOCKET_MODE_DISABLED_FATAL)
            return
          }
          void open(true)
          return
        }
        const envelopeId = readString(parsed, 'envelope_id')
        if (envelopeId === undefined) {
          return
        }
        try {
          connection.send(JSON.stringify({ envelope_id: envelopeId }))
        } catch {
          // The socket is closing; Slack resends an unacknowledged event on the next connection
        }
        const eventId = isJson(parsed.payload) ? readString(parsed.payload, 'event_id') : undefined
        if (eventId !== undefined) {
          if (seenEventIds.includes(eventId)) {
            return
          }
          seenEventIds.push(eventId)
          if (seenEventIds.length > SEEN_EVENT_LIMIT) {
            seenEventIds.shift()
          }
        }
        dispatch(parsed, events)
      }
      void open(false)
    },
    async destroy() {
      isDestroyed = true
      clearTimeout(reconnectTimer)
      const connections = [active, pending]
      active = undefined
      pending = undefined
      for (const connection of connections) {
        connection?.close()
      }
    },
  }
}

/** A person's message (not an edit, delete or channel event), or undefined. Never throws. */
export function toIncomingMessage(event: unknown): IncomingMessage | undefined {
  if (!isJson(event) || event.type !== 'message') {
    return undefined
  }
  const subtype = readString(event, 'subtype')
  const channelId = readString(event, 'channel')
  const ts = readString(event, 'ts')
  if (channelId === undefined || ts === undefined) {
    return undefined
  }
  const fromBot = readString(event, 'bot_id') !== undefined || subtype === 'bot_message'
  if (!fromBot && !USER_SUBTYPES.includes(subtype)) {
    return undefined
  }
  const text = readString(event, 'text')
  const threadTs = readString(event, 'thread_ts')
  return {
    channelId,
    ts,
    fromId: readString(event, 'user'),
    fromBot,
    isDirect: event.channel_type === 'im',
    text: text === undefined || text === '' ? undefined : toPlainText(text),
    thread:
      threadTs === undefined || threadTs === ts
        ? undefined
        : { ts: threadTs, parentUserId: readString(event, 'parent_user_id') },
  }
}

/** The first button of a block_actions payload, or undefined. Never throws. */
export function toIncomingAction(payload: unknown): IncomingAction | undefined {
  if (!isJson(payload) || payload.type !== 'block_actions' || !Array.isArray(payload.actions)) {
    return undefined
  }
  const action: unknown = payload.actions[0]
  const container = isJson(payload.container) ? payload.container : {}
  const channelId =
    (isJson(payload.channel) ? readString(payload.channel, 'id') : undefined) ??
    readString(container, 'channel_id')
  const messageTs = readString(container, 'message_ts')
  if (
    !isJson(action) ||
    action.type !== 'button' ||
    channelId === undefined ||
    messageTs === undefined
  ) {
    return undefined
  }
  const actionId = readString(action, 'action_id')
  if (actionId === undefined) {
    return undefined
  }
  return {
    userId: isJson(payload.user) ? readString(payload.user, 'id') : undefined,
    channelId,
    messageTs,
    isDirect: channelId.startsWith('D'),
    actionId,
  }
}

/** A slash command with its text unescaped, or undefined. Never throws. */
export function toIncomingCommand(payload: unknown): IncomingCommand | undefined {
  if (!isJson(payload)) {
    return undefined
  }
  const channelId = readString(payload, 'channel_id')
  if (channelId === undefined) {
    return undefined
  }
  return {
    userId: readString(payload, 'user_id'),
    channelId,
    isDirect: channelId.startsWith('D') || payload.channel_name === 'directmessage',
    text: toPlainText(readString(payload, 'text') ?? ''),
  }
}

/**
 * Incoming mrkdwn as the person typed it: `<target|label>` is the label, `<target>` the target, and
 * `&amp;`, `&lt;` and `&gt;` the characters. Never throws.
 */
export function toPlainText(text: string): string {
  return text
    .replaceAll(MRKDWN_REFERENCE_PATTERN, (_match, target: string, label: string | undefined) =>
      label === undefined || label === '' ? target : label,
    )
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function dispatch(envelope: Json, events: SocketEvents): void {
  switch (envelope.type) {
    case 'events_api': {
      const message = isJson(envelope.payload)
        ? toIncomingMessage(envelope.payload.event)
        : undefined
      if (message !== undefined) {
        events.message(message)
      }
      return
    }
    case 'interactive': {
      const action = toIncomingAction(envelope.payload)
      if (action !== undefined) {
        events.action(action)
      }
      return
    }
    case 'slash_commands': {
      const command = toIncomingCommand(envelope.payload)
      if (command !== undefined) {
        events.command(command)
      }
      return
    }
    default:
      return
  }
}

function openWebSocket(url: string, listeners: SocketListeners): SocketConnection {
  const socket = new WebSocket(url)
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      listeners.message(event.data)
    }
  })
  // An 'error' is always followed by 'close', which is where reconnecting starts
  socket.addEventListener('error', () => {})
  socket.addEventListener('close', () => listeners.close())
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
  }
}

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Json, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}
