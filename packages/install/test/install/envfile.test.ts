import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vite-plus/test'
import { readEnvFile, removeEnvKey, writeEnvFile } from '../../src/install/index.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'env-'))

test('roundtrip with mode 0600', () => {
  const f = join(dir(), '.env')
  writeEnvFile(f, 'JAYPOST_BOT_TOKEN=a=b\nJAYPOST_PORT=1\n')
  expect(readEnvFile(f)).toEqual({ JAYPOST_BOT_TOKEN: 'a=b', JAYPOST_PORT: '1' })
  expect(statSync(f).mode & 0o777).toBe(0o600)
})

test('missing file reads as empty', () => {
  expect(readEnvFile(join(dir(), 'nope'))).toEqual({})
})

test('removeEnvKey keeps other lines and mode', () => {
  const f = join(dir(), '.env')
  writeEnvFile(f, 'JAYPOST_BOT_TOKEN=t\nJAYPOST_OWNER_ID=5\nJAYPOST_PORT=1\n')
  removeEnvKey(f, 'JAYPOST_OWNER_ID')
  expect(readFileSync(f, 'utf8')).toBe('JAYPOST_BOT_TOKEN=t\nJAYPOST_PORT=1\n')
  expect(statSync(f).mode & 0o777).toBe(0o600)
})

test('removeEnvKey on a missing file writes nothing', () => {
  const f = join(dir(), 'nope')
  removeEnvKey(f, 'X')
  expect(existsSync(f)).toBe(false)
})

test('readEnvFile rethrows read errors other than a missing file', () => {
  expect(() => readEnvFile(dir())).toThrow(/EISDIR/)
})

test('ignores comments and blanks', () => {
  const f = join(dir(), '.env')
  writeFileSync(f, '# c\n\nA=1\n')
  expect(readEnvFile(f)).toEqual({ A: '1' })
})
