import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { expect, test } from 'vite-plus/test'
import { validateToken } from '../../src/discord/index.ts'

async function withDiscordApi(
  respond: (url: string) => { status: number; body: unknown },
  run: (apiRoot: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((request, response) => {
    // discord.js encodes @me as %40me in some routes
    const { status, body } = respond(decodeURIComponent(request.url ?? ''))
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    await run(`http://127.0.0.1:${port}/api`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('validateToken returns the username', async () => {
  await withDiscordApi(
    (url) =>
      url === '/api/v10/users/@me'
        ? { status: 200, body: { id: '111', username: 'mybot' } }
        : { status: 200, body: { id: '222' } },
    async (apiRoot) => {
      expect(await validateToken('SECRET-TOKEN', apiRoot)).toBe('mybot')
    },
  )
})

test('validateToken returns undefined on 401 and on a closed port', async () => {
  await withDiscordApi(
    () => ({ status: 401, body: { message: '401: Unauthorized', code: 0 } }),
    async (apiRoot) => {
      expect(await validateToken('SECRET-TOKEN', apiRoot)).toBeUndefined()
    },
  )
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise((resolve) => server.close(resolve))
  expect(await validateToken('SECRET-TOKEN', `http://127.0.0.1:${port}/api`)).toBeUndefined()
})
