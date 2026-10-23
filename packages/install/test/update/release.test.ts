import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, test } from 'vite-plus/test'
import { fetchLatestNpmVersion, fetchLatestRelease } from '../../src/update/index.ts'

let server: Server | undefined

afterEach(() => {
  server?.close()
  server = undefined
})

async function serve(status: number, body: unknown): Promise<string> {
  server = createServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
}

test('maps a github release to version and assets', async () => {
  const url = await serve(200, {
    tag_name: 'v0.5.0',
    assets: [{ name: 'SHA256SUMS', browser_download_url: 'https://example.test/SHA256SUMS' }],
  })
  expect(await fetchLatestRelease(url)).toEqual({
    version: '0.5.0',
    assets: { SHA256SUMS: 'https://example.test/SHA256SUMS' },
  })
})

test('rejects a rate limited release lookup', async () => {
  const url = await serve(403, { message: 'rate limit' })
  await expect(fetchLatestRelease(url)).rejects.toThrow('403')
})

test('rejects a release body without a tag', async () => {
  const url = await serve(200, { assets: [] })
  await expect(fetchLatestRelease(url)).rejects.toThrow()
})

test('reads the latest npm version', async () => {
  const url = await serve(200, { version: '0.5.0' })
  expect(await fetchLatestNpmVersion(url)).toBe('0.5.0')
})

test('rejects when npm answers 404', async () => {
  const url = await serve(404, {})
  await expect(fetchLatestNpmVersion(url)).rejects.toThrow('404')
})
