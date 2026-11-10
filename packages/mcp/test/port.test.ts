import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vite-plus/test'
import { writeInstall } from '@jaypost/install'
import { resolveMcpPort } from '../src/index.ts'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tab-mcp-port-'))
  file = join(dir, 'install.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function writePort(port: number): void {
  writeInstall(file, {
    target: 'systemd',
    port,
    version: '1.0.0',
    cliPath: '/x/cli',
  })
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
