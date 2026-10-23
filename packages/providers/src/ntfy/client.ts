import { setTimeout as delay } from 'node:timers/promises'
import {
  FIRST_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  REJECTED_FATAL,
  REQUEST_TIMEOUT_MS,
  STREAM_STALL_MS,
} from './constants.ts'
import type {
  NtfyAccess,
  NtfyClient,
  NtfyClientOptions,
  NtfyConnection,
  NtfyIncoming,
  NtfyMessage,
  NtfyStreamEvents,
} from './types.ts'

/** How one stream attempt ended: refused, dropped after it opened, or never opened. */
type StreamEnd = 'rejected' | 'dropped' | 'failed'

/** A `message` event from ntfy's JSON stream; undefined for any other line. Never throws. */
export function parseStreamLine(line: string): NtfyIncoming | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('event' in parsed) ||
    parsed.event !== 'message' ||
    !('id' in parsed) ||
    typeof parsed.id !== 'string' ||
    !('message' in parsed) ||
    typeof parsed.message !== 'string'
  ) {
    return undefined
  }
  const title = 'title' in parsed && typeof parsed.title === 'string' ? parsed.title : undefined
  return { id: parsed.id, message: parsed.message, title }
}

/** An `NtfyClient` over `fetch`. The token only ever goes in the Authorization header. */
export function createNtfyClient(
  connection: NtfyConnection,
  options: NtfyClientOptions = {},
): NtfyClient {
  const { server, token } = connection
  const stallMs = options.stallMs ?? STREAM_STALL_MS
  const firstRetryDelayMs = options.firstRetryDelayMs ?? FIRST_RETRY_DELAY_MS
  const maxRetryDelayMs = options.maxRetryDelayMs ?? MAX_RETRY_DELAY_MS
  const now = options.now ?? Date.now
  const authorization: Record<string, string> =
    token === undefined ? {} : { authorization: `Bearer ${token}` }
  async function send(method: string, path: string, body?: unknown): Promise<void> {
    const response = await fetch(`${server}${path}`, {
      method,
      headers: {
        ...authorization,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    await response.body?.cancel()
    if (!response.ok) {
      throw new Error(`ntfy answered ${method} with ${response.status}`)
    }
  }
  async function readStream(
    topic: string,
    since: string,
    events: NtfyStreamEvents,
    onSeen: (id: string) => void,
    stopSignal: AbortSignal,
  ): Promise<StreamEnd> {
    const attempt = new AbortController()
    let timer = setTimeout(() => attempt.abort(), stallMs)
    const restartTimer = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => attempt.abort(), stallMs)
    }
    let isOpen = false
    try {
      const response = await fetch(`${server}/${topic}/json?since=${encodeURIComponent(since)}`, {
        headers: authorization,
        signal: AbortSignal.any([stopSignal, attempt.signal]),
      })
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel()
        return 'rejected'
      }
      if (!response.ok || response.body === null) {
        await response.body?.cancel()
        return 'failed'
      }
      isOpen = true
      let buffer = ''
      for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
        restartTimer()
        const lines = `${buffer}${chunk}`.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const incoming = parseStreamLine(line)
          if (incoming !== undefined) {
            onSeen(incoming.id)
            events.message(incoming)
          }
        }
      }
      return 'dropped'
    } catch {
      // A network error, a stall or a stop: all end this attempt the same way.
      return isOpen ? 'dropped' : 'failed'
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    async publish(message: NtfyMessage): Promise<void> {
      await send('POST', '/', {
        topic: message.topic,
        message: message.message,
        priority: message.priority,
        actions: message.actions,
        ...(message.sequenceId === undefined ? {} : { sequence_id: message.sequenceId }),
      })
    },
    async clear(topic: string, sequenceId: string): Promise<void> {
      await send('PUT', `/${topic}/${sequenceId}/clear`)
    },
    async remove(topic: string, sequenceId: string): Promise<void> {
      await send('DELETE', `/${topic}/${sequenceId}`)
    },
    async checkAccess(topic: string): Promise<NtfyAccess> {
      let response: Response
      try {
        response = await fetch(`${server}/${topic}/auth`, {
          headers: authorization,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        await response.body?.cancel()
      } catch {
        return { kind: 'unreachable' }
      }
      return response.ok ? { kind: 'ok' } : { kind: 'rejected', status: response.status }
    },
    subscribe(topic: string, events: NtfyStreamEvents): () => void {
      const stopper = new AbortController()
      // Only what is published from now on; a reopened stream resumes after the last message seen.
      let since = String(Math.floor(now() / 1000))
      const run = async (): Promise<void> => {
        let retryDelayMs = firstRetryDelayMs
        while (!stopper.signal.aborted) {
          const end = await readStream(
            topic,
            since,
            events,
            (id) => {
              since = id
            },
            stopper.signal,
          )
          if (stopper.signal.aborted) {
            return
          }
          if (end === 'rejected') {
            events.fatal(REJECTED_FATAL)
            return
          }
          if (end === 'dropped') {
            retryDelayMs = firstRetryDelayMs
          }
          try {
            await delay(retryDelayMs, undefined, { signal: stopper.signal })
          } catch {
            return
          }
          retryDelayMs = Math.min(retryDelayMs * 2, maxRetryDelayMs)
        }
      }
      void run()
      return () => stopper.abort()
    },
  }
}
