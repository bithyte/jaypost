import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vite-plus/test'
import { writeInstall } from '@jaypost/install'
import { resolveMcpEndpoint, resolveMcpPort } from '../src/index.ts'
import { INVALID_URL_MESSAGE } from '@jaypost/client'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tab-mcp-port-'))
  file = join(dir, 'install.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function writePort(port: number): void {
  writeInstall(file, { target: 'systemd', port, version: '1.0.0', cliPath: '/x/cli' })
}

test('flag wins', () => {
  writePort(9002)
  expect(resolveMcpPort(9000, { JAYPOST_PORT: '9001' }, file)).toBe(9000)
})

test('JAYPOST_PORT env next', () => {
  writePort(9002)
  expect(resolveMcpPort(undefined, { JAYPOST_PORT: '9001' }, file)).toBe(9001)
})

test.each(['abc', '0', '70000', ''])('bad JAYPOST_PORT %s falls through', (value) => {
  writePort(9002)
  expect(resolveMcpPort(undefined, { JAYPOST_PORT: value }, file)).toBe(9002)
})

test('install.json next', () => {
  writePort(9002)
  expect(resolveMcpPort(undefined, {}, file)).toBe(9002)
})

test('default', () => {
  expect(resolveMcpPort(undefined, {}, join(dir, 'missing.json'))).toBe(8787)
})

function toHref(endpoint: ReturnType<typeof resolveMcpEndpoint>): string {
  return endpoint.kind === 'url' ? endpoint.url.href : endpoint.message
}

test('endpoint: flag port wins over JAYPOST_URL', () => {
  const env = { JAYPOST_URL: 'https://relay.example.com/team' }
  expect(toHref(resolveMcpEndpoint(9000, env, file))).toBe('http://127.0.0.1:9000/')
})

test('endpoint: JAYPOST_URL wins over JAYPOST_PORT and the install', () => {
  writePort(9002)
  const env = { JAYPOST_URL: 'https://relay.example.com/team', JAYPOST_PORT: '9001' }
  expect(toHref(resolveMcpEndpoint(undefined, env, file))).toBe('https://relay.example.com/team')
})

test('endpoint: empty JAYPOST_URL falls back to the local port', () => {
  writePort(9002)
  expect(toHref(resolveMcpEndpoint(undefined, { JAYPOST_URL: '' }, file))).toBe(
    'http://127.0.0.1:9002/',
  )
})

test('endpoint: bad JAYPOST_URL is invalid', () => {
  expect(resolveMcpEndpoint(undefined, { JAYPOST_URL: 'relay' }, file)).toEqual({
    kind: 'invalid',
    message: INVALID_URL_MESSAGE,
  })
})
