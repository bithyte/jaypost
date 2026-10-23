import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, test } from 'vite-plus/test'
import { NO_CLIENT_TOKEN } from '../../src/auth/index.ts'
import { runPing } from '../../src/commands/index.ts'
import type { PingDeps } from '../../src/commands/index.ts'
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

async function startFake(urls: (string | undefined)[]): Promise<number> {
  const server = createServer((request, response) => {
    urls.push(request.url)
    request.resume()
    request.on('end', () => {
      response.setHeader('content-type', 'application/json')
      response.end(
        request.url === '/status' ? JSON.stringify({ paired: true, provider: 'telegram' }) : '{}',
      )
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

function createDeps(port: number, progress: Progress) {
  const out: string[] = []
  const errors: string[] = []
  const deps: PingDeps = {
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

test('jaypost ping on a live terminal says where it was sent', async () => {
  const urls: (string | undefined)[] = []
  const port = await startFake(urls)
  const { progress, events } = createRecordingProgress('live')
  const { deps, out, errors } = createDeps(port, progress)
  expect(await runPing(deps)).toBe(0)
  expect(events).toEqual(['done:Sent to Telegram'])
  expect(out).toEqual([])
  expect(errors).toEqual([])
  expect(urls).toEqual(['/notify', '/status'])
})

test('jaypost ping off a terminal prints a sent line only', async () => {
  const urls: (string | undefined)[] = []
  const port = await startFake(urls)
  const { progress, events } = createRecordingProgress('silent')
  const { deps, out, errors } = createDeps(port, progress)
  expect(await runPing(deps)).toBe(0)
  expect(out).toEqual(['Sent. Check your chat app.'])
  expect(errors).toEqual([])
  expect(events).toEqual([])
  expect(urls).toEqual(['/notify'])
})

test('jaypost ping prints the failure message without a prefix', async () => {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  const { deps, out, errors } = createDeps(port, SILENT_PROGRESS)
  expect(await runPing(deps)).toBe(1)
  expect(out).toEqual([])
  expect(errors).toEqual([
    `jaypost service not reachable on 127.0.0.1:${port} (run jaypost status)`,
  ])
})
