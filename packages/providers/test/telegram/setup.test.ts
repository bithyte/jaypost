import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { expect, test } from 'vite-plus/test'
import { validateToken } from '../../src/telegram/index.ts'

async function withBotApi(
  respond: (url: string) => { status: number; body: unknown },
  run: (apiRoot: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((request, response) => {
    const { status, body } = respond(request.url ?? '')
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

test('validateToken returns username on ok', async () => {
  const urls: string[] = []
  await withBotApi(
    (url) => {
      urls.push(url)
      return {
        status: 200,
        body: { ok: true, result: { id: 1, is_bot: true, first_name: 'x', username: 'mybot' } },
      }
    },
    async (apiRoot) => {
      expect(await validateToken('123:abc', apiRoot)).toBe('mybot')
    },
  )
  expect(urls).toEqual(['/bot123:abc/getMe'])
})

test('validateToken returns undefined when telegram rejects the token', async () => {
  await withBotApi(
    () => ({ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } }),
    async (apiRoot) => {
      expect(await validateToken('123:abc', apiRoot)).toBeUndefined()
    },
  )
})

test('validateToken returns undefined when telegram is unreachable', async () => {
  const server = net.createServer()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  await new Promise((r) => server.close(r))
  expect(await validateToken('SECRET-TOKEN', `http://127.0.0.1:${port}`)).toBeUndefined()
})
