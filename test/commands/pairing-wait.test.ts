import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test, vi } from 'vite-plus/test'
import type { StatusInfo } from '../../src/server/index.ts'
import { defaultFetchStatus, waitForPairing } from '../../src/commands/index.ts'
import type { StatusFetch } from '../../src/commands/index.ts'
import { UNAUTHORIZED_STATUS, UNREACHABLE_STATUS } from '../../src/commands/constants.ts'

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
  const print = vi.fn()
  const r = await waitForPairing({
    ...base,
    fetchStatus: async () => seq.shift() ?? UNREACHABLE_STATUS,
    print,
  })
  expect(r).toBe('paired')
  const hits = print.mock.calls.filter(([s]) => s.includes('K7QM-4XPD'))
  expect(hits).toHaveLength(1)
  expect(print.mock.calls.flat().join('\n')).toContain('https://t.me/b?start=K7QM4XPD')
})

test('abort returns interrupted and says the service is still running', async () => {
  const ac = new AbortController()
  ac.abort()
  const print = vi.fn()
  const r = await waitForPairing({
    ...base,
    signal: ac.signal,
    fetchStatus: async () => UNREACHABLE_STATUS,
    print,
  })
  expect(r).toBe('interrupted')
  expect(print.mock.calls.flat().join('\n')).toBe(
    'Service is still running and waiting for pairing. Run "jaypost status" to see the code again.',
  )
})

test('abort during the wait (after code shown) returns interrupted', async () => {
  const ac = new AbortController()
  const print = vi.fn()
  const r = await waitForPairing({
    ...base,
    signal: ac.signal,
    fetchStatus: async () => answered({ paired: false, code: 'AAAA-BBBB', bot: 'b' }),
    sleep: async () => ac.abort(),
    print,
  })
  expect(r).toBe('interrupted')
  expect(print.mock.calls.flat().join('\n')).toMatch(/jaypost status/)
})

test('abort interrupts a real sleep promptly', async () => {
  const ac = new AbortController()
  const print = vi.fn()
  setTimeout(() => ac.abort(), 20)
  const t = Date.now()
  const r = await waitForPairing({
    port: 1,
    isRunning: async () => true,
    logsHint: 'L',
    signal: ac.signal,
    fetchStatus: async () => answered({ paired: false, code: 'AAAA-BBBB', bot: 'b' }),
    print,
  })
  expect(r).toBe('interrupted')
  expect(Date.now() - t).toBeLessThan(500)
})

test('service died returns stopped', async () => {
  const print = vi.fn()
  const r = await waitForPairing({
    ...base,
    isRunning: async () => false,
    fetchStatus: async () => UNREACHABLE_STATUS,
    print,
  })
  expect(r).toBe('stopped')
  expect(print.mock.calls.flat().join('\n')).toContain('L')
})

test('never answers returns not-started', async () => {
  const r = await waitForPairing({
    ...base,
    startTimeoutMs: 0,
    fetchStatus: async () => UNREACHABLE_STATUS,
    print: () => {},
  })
  expect(r).toBe('notStarted')
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
  const print = vi.fn()
  try {
    const result = await waitForPairing({
      ...base,
      port,
      fetchStatus: defaultFetchStatus,
      print,
    })
    return { result, printed: print.mock.calls.flat().join('\n') }
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
  expect(printed).toBe('Pairing code: K7QM-4XPD\nSay K7QM4XPD to fake')
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
  expect(await waitForPairing({ ...base, token: TOKEN, fetchStatus })).toBe('unauthorized')
  expect(fetchStatus.mock.calls).toEqual([[1, TOKEN]])
})
