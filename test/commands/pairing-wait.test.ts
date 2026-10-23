import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test, vi } from 'vite-plus/test'
import type { StatusInfo } from '../../src/server/index.ts'
import { defaultFetchStatus, waitForPairing } from '../../src/commands/index.ts'
import type { StatusFetch } from '../../src/commands/index.ts'
import { UNAUTHORIZED_STATUS, UNREACHABLE_STATUS } from '../../src/commands/constants.ts'
import { formatPairingText } from '../../src/commands/pairing-text.ts'
import { createProgress } from '../../src/progress/index.ts'
import { createRecordingProgress } from '../progress/recording.ts'

const TOKEN = 'A'.repeat(43)

function answered(status: StatusInfo): StatusFetch {
  return { kind: 'answered', status }
}

const base = {
  port: 1,
  isRunning: async () => true,
  logsHint: 'L',
  sleep: async () => {},
}

test('prints code once, resolves paired', async () => {
  const seq: StatusFetch[] = [
    UNREACHABLE_STATUS,
    answered({ paired: false, code: 'K7QM-4XPD', bot: 'b' }),
    answered({ paired: false, code: 'K7QM-4XPD', bot: 'b' }),
    answered({ paired: true, bot: 'b' }),
  ]
  const { progress, events } = createRecordingProgress()
  const r = await waitForPairing({
    ...base,
    fetchStatus: async () => seq.shift() ?? UNREACHABLE_STATUS,
    progress,
  })
  expect(r).toBe('paired')
  const hits = events.filter((event) => event.startsWith('note:') && event.includes('K7QM-4XPD'))
  expect(hits).toHaveLength(1)
  expect(events.join('\n')).toContain('https://t.me/b?start=K7QM4XPD')
})

test('waitForPairing prints the whole pairing text in plain mode', async () => {
  const url = `https://discord.com/oauth2/authorize?client_id=${'1'.repeat(60)}`
  const unpaired = {
    paired: false,
    code: 'K7QM-4XPD',
    instructions: `Open ${url} then DM it`,
  } as const
  const seq: StatusFetch[] = [answered(unpaired), answered({ paired: true })]
  const chunks: string[] = []
  const progress = createProgress({
    stream: { write: (text: string) => chunks.push(text), columns: 40 },
    mode: 'plain',
  })
  const result = await waitForPairing({
    ...base,
    fetchStatus: async () => seq.shift() ?? UNREACHABLE_STATUS,
    progress,
  })
  expect(result).toBe('paired')
  expect(chunks.join('').replace(/ \d+:\d\d/g, '')).toBe(
    `◇ Service is up\n${formatPairingText(unpaired).replace(/^/gm, '│  ')}\n◇ Paired\n`,
  )
})

test('waitForPairing shows the service start, then notes the pairing code', async () => {
  const unpaired = { paired: false, code: 'K7QM-4XPD', bot: 'b' } as const
  const seq: StatusFetch[] = [
    UNREACHABLE_STATUS,
    answered(unpaired),
    answered({ paired: true, bot: 'b' }),
  ]
  const { progress, events } = createRecordingProgress()
  const result = await waitForPairing({
    ...base,
    fetchStatus: async () => seq.shift() ?? UNREACHABLE_STATUS,
    progress,
  })
  expect(result).toBe('paired')
  expect(events).toEqual([
    'start:Waiting for the service to start',
    'succeed:Service is up',
    'start:Waiting for pairing',
    `note:${formatPairingText(unpaired)}`,
    'succeed:Paired',
  ])
})

test('already paired at the first answer still closes the pairing step', async () => {
  const { progress, events } = createRecordingProgress()
  const result = await waitForPairing({
    ...base,
    fetchStatus: async () => answered({ paired: true, bot: 'b' }),
    progress,
  })
  expect(result).toBe('paired')
  expect(events).toEqual([
    'start:Waiting for the service to start',
    'succeed:Service is up',
    'start:Waiting for pairing',
    'succeed:Paired',
  ])
})

test('abort returns interrupted and says the service is still running', async () => {
  const ac = new AbortController()
  ac.abort()
  const { progress, events, notes } = createRecordingProgress()
  const r = await waitForPairing({
    ...base,
    signal: ac.signal,
    fetchStatus: async () => UNREACHABLE_STATUS,
    progress,
  })
  expect(r).toBe('interrupted')
  expect(notes()).toEqual([
    'Service is still running and waiting for pairing. Run "jaypost status" to see the code again.',
  ])
  expect(events.filter((event) => event.startsWith('start:'))).toEqual([
    'start:Waiting for the service to start',
  ])
  expect(events).toContain('cancel:Waiting for the service to start')
})

test('abort during the wait (after code shown) returns interrupted', async () => {
  const ac = new AbortController()
  const { progress, events, notes } = createRecordingProgress()
  const r = await waitForPairing({
    ...base,
    signal: ac.signal,
    fetchStatus: async () => answered({ paired: false, code: 'AAAA-BBBB', bot: 'b' }),
    sleep: async () => ac.abort(),
    progress,
  })
  expect(r).toBe('interrupted')
  expect(notes().join('\n')).toMatch(/jaypost status/)
  expect(events).toContain('cancel:Waiting for pairing')
})

test('abort interrupts a real sleep promptly', async () => {
  const ac = new AbortController()
  const { progress } = createRecordingProgress()
  setTimeout(() => ac.abort(), 20)
  const t = Date.now()
  const r = await waitForPairing({
    port: 1,
    isRunning: async () => true,
    logsHint: 'L',
    signal: ac.signal,
    fetchStatus: async () => answered({ paired: false, code: 'AAAA-BBBB', bot: 'b' }),
    progress,
  })
  expect(r).toBe('interrupted')
  expect(Date.now() - t).toBeLessThan(500)
})

test('service died returns stopped', async () => {
  const { progress, events, notes } = createRecordingProgress()
  const r = await waitForPairing({
    ...base,
    isRunning: async () => false,
    fetchStatus: async () => UNREACHABLE_STATUS,
    progress,
  })
  expect(r).toBe('stopped')
  expect(notes()).toEqual(['The service stopped. L'])
  expect(events).toEqual([
    'start:Waiting for the service to start',
    'fail:Waiting for the service to start',
    'note:The service stopped. L',
  ])
})

test('never answers returns not-started', async () => {
  const { progress, events } = createRecordingProgress()
  const r = await waitForPairing({
    ...base,
    startTimeoutMs: 0,
    fetchStatus: async () => UNREACHABLE_STATUS,
    progress,
  })
  expect(r).toBe('notStarted')
  expect(events).toEqual([
    'start:Waiting for the service to start',
    'fail:Waiting for the service to start',
  ])
})

async function pairViaHttp(
  bodies: readonly string[],
): Promise<{ result: string; printed: string }> {
  const queue = [...bodies]
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(queue.shift() ?? bodies[bodies.length - 1])
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const { progress, events } = createRecordingProgress()
  try {
    const result = await waitForPairing({
      ...base,
      port,
      fetchStatus: defaultFetchStatus,
      progress,
    })
    return { result, printed: events.filter((event) => event.startsWith('note:')).join('\n') }
  } finally {
    server.close()
  }
}

test('waitForPairing accepts the old status shape', async () => {
  const { result, printed } = await pairViaHttp([
    '{"paired":false,"code":"K7QM-4XPD","bot":"b"}',
    '{"paired":true,"bot":"b"}',
  ])
  expect(result).toBe('paired')
  expect(printed).toContain('https://t.me/b?start=K7QM4XPD')
})

test('waitForPairing accepts the new status shape', async () => {
  const { result, printed } = await pairViaHttp([
    '{"paired":false,"provider":"fake","displayName":"fake","code":"K7QM-4XPD","instructions":"Say K7QM4XPD to fake"}',
    '{"paired":true,"provider":"fake","displayName":"fake"}',
  ])
  expect(result).toBe('paired')
  expect(printed).toBe('note:Pairing code: K7QM-4XPD\nSay K7QM4XPD to fake')
})

test('defaultFetchStatus sends the token and reads a 401 as unauthorized', async () => {
  const headers: (string | undefined)[] = []
  const server = createServer((request, response) => {
    headers.push(request.headers.authorization)
    response.setHeader('content-type', 'application/json')
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.statusCode = 401
      response.end('{"error":"unauthorized"}')
      return
    }
    response.end('{"paired":true,"bot":"b"}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    expect(await defaultFetchStatus(port)).toEqual({ kind: 'unauthorized' })
    expect(await defaultFetchStatus(port, TOKEN)).toEqual({
      kind: 'answered',
      status: { paired: true, bot: 'b' },
    })
    expect(headers).toEqual([undefined, `Bearer ${TOKEN}`])
  } finally {
    server.close()
  }
})

test('defaultFetchStatus reads an unexpected body as unreachable', async () => {
  const server = createServer((_request, response) => {
    response.end('{"nope":1}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    expect(await defaultFetchStatus(port)).toEqual({ kind: 'unreachable' })
  } finally {
    server.close()
  }
})

test('waitForPairing stops at once on unauthorized and passes its token', async () => {
  const fetchStatus = vi.fn(async () => UNAUTHORIZED_STATUS)
  const { progress, events } = createRecordingProgress()
  expect(await waitForPairing({ ...base, token: TOKEN, fetchStatus, progress })).toBe(
    'unauthorized',
  )
  expect(events).toEqual([
    'start:Waiting for the service to start',
    'fail:Waiting for the service to start',
  ])
  expect(fetchStatus.mock.calls).toEqual([[1, TOKEN]])
})
