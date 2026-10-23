import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, test } from 'vite-plus/test'
import { NO_CLIENT_TOKEN } from '../../src/auth/index.ts'
import { runTest } from '../../src/commands/index.ts'
import type { TestDeps } from '../../src/commands/index.ts'
import { SILENT_PROGRESS } from '../../src/progress/index.ts'
import type { Progress } from '../../src/progress/index.ts'
import { telegramProvider } from '../../src/telegram/index.ts'
import { createRecordingProgress } from '../progress/recording.ts'

const servers: ReturnType<typeof createServer>[] = []
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close()
  }
})

type Seen = { method: string | undefined; url: string | undefined }

async function startFake(seen: Seen[]): Promise<number> {
  const server = createServer((request, response) => {
    seen.push({ method: request.method, url: request.url?.split('?')[0] })
    request.resume()
    request.on('end', () => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/status') {
        response.end(JSON.stringify({ paired: true, provider: 'telegram' }))
      } else if (request.url === '/request/async') {
        response.statusCode = 202
        response.end(
          JSON.stringify({ id: 'q1', state: 'pending', expiresAt: new Date(Date.now() + 300_000) }),
        )
      } else if (request.url?.startsWith('/request/q1')) {
        response.end(
          JSON.stringify({ id: 'q1', state: 'done', answer: 'Approve', timedOut: false }),
        )
      } else {
        response.end(JSON.stringify({ answer: 'Approve', timedOut: false }))
      }
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

function createDeps(port: number, progress: Progress) {
  const out: string[] = []
  const errors: string[] = []
  const deps: TestDeps = {
    port,
    token: NO_CLIENT_TOKEN,
    progress,
    providers: [telegramProvider],
    signal: new AbortController().signal,
    print: (text) => out.push(text),
    printError: (text) => errors.push(text),
  }
  return { deps, out, errors }
}

test('jaypost test on a live terminal shows progress and prints the answer', async () => {
  const seen: Seen[] = []
  const port = await startFake(seen)
  const { progress, events } = createRecordingProgress('live')
  const { deps, out, errors } = createDeps(port, progress)
  expect(await runTest(deps)).toBe(0)
  expect(out).toEqual(['Approve'])
  expect(errors).toEqual([])
  expect(events[0]).toBe('start:Sending')
  expect(events[1]).toBe('succeed:Sent to Telegram')
  expect(events.at(-1)).toMatch(/^succeed:Answered after /)
})

test('jaypost test off a terminal prints the answer only', async () => {
  const seen: Seen[] = []
  const port = await startFake(seen)
  const { progress, events } = createRecordingProgress('silent')
  const { deps, out, errors } = createDeps(port, progress)
  expect(await runTest(deps)).toBe(0)
  expect(out).toEqual(['Approve'])
  expect(errors).toEqual([])
  expect(events).toEqual([])
  expect(seen.map((entry) => entry.url)).toEqual(['/request'])
})

test('jaypost test prints the failure message without a prefix', async () => {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  const { deps, out, errors } = createDeps(port, SILENT_PROGRESS)
  expect(await runTest(deps)).toBe(1)
  expect(out).toEqual([])
  expect(errors).toEqual([
    `jaypost service not reachable on 127.0.0.1:${port} (run jaypost status)`,
  ])
})
