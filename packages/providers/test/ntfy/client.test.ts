import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { expect, test, vi } from 'vite-plus/test'
import { createNtfyClient, parseStreamLine, REJECTED_FATAL } from '../../src/ntfy/index.ts'
import type { NtfyIncoming } from '../../src/ntfy/index.ts'

type Received = {
  readonly method: string
  readonly url: string
  readonly authorization: string | undefined
  readonly body: string
}

type FakeNtfy = {
  readonly server: string
  readonly received: Received[]
  /** Open streams, oldest first; write NDJSON lines to them or end them. */
  readonly streams: http.ServerResponse[]
  readonly close: () => Promise<void>
}

/** A local ntfy stand-in: `respond` answers everything but streams, which stay open. */
async function startFakeNtfy(
  respond: (request: Received) => number = () => 200,
  streamStatus: () => number = () => 200,
): Promise<FakeNtfy> {
  const received: Received[] = []
  const streams: http.ServerResponse[] = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })
    request.on('end', () => {
      const entry = {
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body,
      }
      received.push(entry)
      if (entry.url.includes('/json?')) {
        const status = streamStatus()
        response.writeHead(status, { 'content-type': 'application/x-ndjson' })
        if (status !== 200) {
          response.end()
          return
        }
        response.write(`${JSON.stringify({ id: 'open1', event: 'open', topic: 't' })}\n`)
        streams.push(response)
        return
      }
      response.writeHead(respond(entry), { 'content-type': 'application/json' })
      response.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    server: `http://127.0.0.1:${port}`,
    received,
    streams,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function message(id: string, text: string, title?: string): string {
  return `${JSON.stringify({ id, time: 1, event: 'message', topic: 't-replies', message: text, ...(title === undefined ? {} : { title }) })}\n`
}

test('publish posts json to the server root with the bearer token', async () => {
  const fake = await startFakeNtfy()
  try {
    const client = createNtfyClient({ server: fake.server, token: 'tk_secret' })
    await client.publish({
      topic: 't',
      message: 'Deploy?',
      priority: 4,
      sequenceId: 'r1',
      actions: [
        {
          action: 'http',
          label: 'Yes',
          url: `${fake.server}/t-replies`,
          method: 'POST',
          headers: { 'x-title': 'jaypost-tap' },
          body: 'r1:0',
          clear: true,
        },
      ],
    })
    expect(fake.received).toEqual([
      {
        method: 'POST',
        url: '/',
        authorization: 'Bearer tk_secret',
        body: JSON.stringify({
          topic: 't',
          message: 'Deploy?',
          priority: 4,
          actions: [
            {
              action: 'http',
              label: 'Yes',
              url: `${fake.server}/t-replies`,
              method: 'POST',
              headers: { 'x-title': 'jaypost-tap' },
              body: 'r1:0',
              clear: true,
            },
          ],
          sequence_id: 'r1',
        }),
      },
    ])
  } finally {
    await fake.close()
  }
})

test('publish without a sequence id or token sends neither', async () => {
  const fake = await startFakeNtfy()
  try {
    const client = createNtfyClient({ server: fake.server, token: undefined })
    await client.publish({ topic: 't', message: 'hi', priority: 2, actions: [] })
    expect(fake.received).toEqual([
      {
        method: 'POST',
        url: '/',
        authorization: undefined,
        body: JSON.stringify({ topic: 't', message: 'hi', priority: 2, actions: [] }),
      },
    ])
  } finally {
    await fake.close()
  }
})

test('clear and remove act on the sequence', async () => {
  const fake = await startFakeNtfy()
  try {
    const client = createNtfyClient({ server: fake.server, token: undefined })
    await client.clear('t', 'r1')
    await client.remove('t', 'n1')
    expect(fake.received.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      'PUT /t/r1/clear',
      'DELETE /t/n1',
    ])
  } finally {
    await fake.close()
  }
})

test('a refused publish rejects without the token in the error', async () => {
  const fake = await startFakeNtfy(() => 403)
  try {
    const client = createNtfyClient({ server: fake.server, token: 'tk_secret' })
    const error = await client
      .publish({ topic: 't', message: 'hi', priority: 3, actions: [] })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('403')
    expect(String(error)).not.toContain('tk_secret')
  } finally {
    await fake.close()
  }
})

test('checkAccess asks the topic auth endpoint', async () => {
  const fake = await startFakeNtfy((request) => (request.url === '/open/auth' ? 200 : 401))
  try {
    const client = createNtfyClient({ server: fake.server, token: 'tk_secret' })
    expect(await client.checkAccess('open')).toEqual({ kind: 'ok' })
    expect(await client.checkAccess('closed')).toEqual({ kind: 'rejected', status: 401 })
    expect(fake.received.map((entry) => entry.authorization)).toEqual([
      'Bearer tk_secret',
      'Bearer tk_secret',
    ])
  } finally {
    await fake.close()
  }
})

test('checkAccess is unreachable on a closed port', async () => {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise((resolve) => server.close(resolve))
  const client = createNtfyClient({ server: `http://127.0.0.1:${port}`, token: undefined })
  expect(await client.checkAccess('t')).toEqual({ kind: 'unreachable' })
})

test('subscribe streams messages from now and resumes after the last one seen', async () => {
  const fake = await startFakeNtfy()
  const client = createNtfyClient(
    { server: fake.server, token: 'tk_secret' },
    { now: () => 1_700_000_000_500, firstRetryDelayMs: 1 },
  )
  const seen: NtfyIncoming[] = []
  const fatal = vi.fn()
  const stop = client.subscribe('t-replies', {
    message: (incoming) => seen.push(incoming),
    fatal,
  })
  try {
    await vi.waitFor(() => expect(fake.streams).toHaveLength(1))
    const first = fake.streams[0]
    first?.write(message('m1', 'r1:0', 'jaypost-tap'))
    // Split across writes: the line only counts once it is complete.
    first?.write(message('m2', 'yes please').slice(0, 10))
    first?.write(message('m2', 'yes please').slice(10))
    first?.write(`${JSON.stringify({ id: 'k1', event: 'keepalive' })}\n`)
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    first?.end()
    await vi.waitFor(() => expect(fake.streams).toHaveLength(2))
    expect(seen).toEqual([
      { id: 'm1', message: 'r1:0', title: 'jaypost-tap' },
      { id: 'm2', message: 'yes please', title: undefined },
    ])
    const urls = fake.received.map((entry) => entry.url)
    expect(urls).toEqual(['/t-replies/json?since=1700000000', '/t-replies/json?since=m2'])
    expect(fake.received[0]?.authorization).toBe('Bearer tk_secret')
    expect(fatal).not.toHaveBeenCalled()
  } finally {
    stop()
    await fake.close()
  }
})

test('subscribe reopens a stream that goes silent', async () => {
  const fake = await startFakeNtfy()
  const client = createNtfyClient(
    { server: fake.server, token: undefined },
    { stallMs: 50, firstRetryDelayMs: 1 },
  )
  const stop = client.subscribe('t-replies', { message: () => {}, fatal: () => {} })
  try {
    await vi.waitFor(() => expect(fake.streams.length).toBeGreaterThanOrEqual(2))
  } finally {
    stop()
    await fake.close()
  }
})

test('subscribe retries a failed stream and reports a refused one as fatal', async () => {
  const statuses = [500, 403]
  const fake = await startFakeNtfy(undefined, () => statuses.shift() ?? 200)
  const client = createNtfyClient(
    { server: fake.server, token: 'tk_secret' },
    { firstRetryDelayMs: 1 },
  )
  const fatal = vi.fn()
  const stop = client.subscribe('t-replies', { message: () => {}, fatal })
  try {
    await vi.waitFor(() => expect(fatal).toHaveBeenCalledWith(REJECTED_FATAL))
    expect(fake.received).toHaveLength(2)
    expect(fatal.mock.calls.flat().join('')).not.toContain('tk_secret')
  } finally {
    stop()
    await fake.close()
  }
})

test('stopping a subscription closes its stream and stops retrying', async () => {
  const fake = await startFakeNtfy()
  const client = createNtfyClient(
    { server: fake.server, token: undefined },
    { firstRetryDelayMs: 1 },
  )
  const fatal = vi.fn()
  const stop = client.subscribe('t-replies', { message: () => {}, fatal })
  try {
    await vi.waitFor(() => expect(fake.streams).toHaveLength(1))
    const closed = new Promise((resolve) => fake.streams[0]?.on('close', resolve))
    stop()
    await closed
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fake.received).toHaveLength(1)
    expect(fatal).not.toHaveBeenCalled()
  } finally {
    await fake.close()
  }
})

test('parseStreamLine keeps message events only', () => {
  expect(parseStreamLine(message('m1', 'hi').trim())).toEqual({
    id: 'm1',
    message: 'hi',
    title: undefined,
  })
  expect(parseStreamLine('{"id":"o","event":"open"}')).toBeUndefined()
  expect(parseStreamLine('{"id":"x","event":"message"}')).toBeUndefined()
  expect(parseStreamLine('not json')).toBeUndefined()
  expect(parseStreamLine('null')).toBeUndefined()
})
