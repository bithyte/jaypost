import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vite-plus/test'
import { generateToken, parseToken, readTokenFile, resolveEnvToken } from '../../src/auth/index.ts'
import { resolveClientSecret } from '../../src/auth/token.ts'
import type { ClientToken } from '../../src/auth/index.ts'

const TOKEN = 'a'.repeat(43)
const HAND_SET = 'Ab+/._~-'.repeat(5)
const NAMES = { envVar: 'JAYPOST_TOKEN', fileName: 'token file', valueName: 'jaypost token' }
let directory: string
let file: string

function resolveTokenSecret(env: NodeJS.ProcessEnv, path: string): ClientToken {
  return resolveClientSecret(env, path, NAMES)
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jaypost-auth-'))
  file = join(directory, 'token')
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

test('generated tokens are 43 base64url characters and differ between calls', () => {
  const first = generateToken()
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(parseToken(first)).toBe(first)
  expect(generateToken()).not.toBe(first)
})

test('parseToken accepts 32 to 256 characters of the b64token alphabet', () => {
  for (const raw of ['a'.repeat(32), 'a'.repeat(256), HAND_SET]) {
    expect(parseToken(raw)).toBe(raw)
  }
})

test('parseToken trims surrounding whitespace', () => {
  expect(parseToken(`  ${TOKEN}\r\n`)).toBe(TOKEN)
})

test('parseToken rejects short, long, padded, split and non-ascii values', () => {
  for (const raw of [
    'a'.repeat(31),
    'a'.repeat(257),
    `${TOKEN}=`,
    `${'a'.repeat(20)} ${'a'.repeat(20)}`,
    `${TOKEN}é`,
    '',
  ]) {
    expect(parseToken(raw)).toBeUndefined()
  }
})

test('readTokenFile returns undefined for a missing file and the raw text otherwise', () => {
  expect(readTokenFile(file)).toBeUndefined()
  writeFileSync(file, `${TOKEN}\n`)
  expect(readTokenFile(file)).toBe(`${TOKEN}\n`)
})

test('resolveClientSecret prefers the env, then the file, then none', () => {
  writeFileSync(file, `${TOKEN}\n`)
  expect(resolveTokenSecret({ JAYPOST_TOKEN: HAND_SET }, file)).toEqual({
    kind: 'token',
    token: HAND_SET,
    source: 'env',
  })
  expect(resolveTokenSecret({ JAYPOST_TOKEN: '' }, file)).toEqual({
    kind: 'token',
    token: TOKEN,
    source: 'file',
  })
  expect(resolveTokenSecret({}, join(directory, 'none'))).toEqual({ kind: 'none' })
})

test('a token file with CRLF and spaces is read trimmed', () => {
  writeFileSync(file, `  ${TOKEN}  \r\n`)
  expect(resolveTokenSecret({}, file)).toEqual({ kind: 'token', token: TOKEN, source: 'file' })
})

test('an invalid env or file token is unusable and the message never quotes it', () => {
  expect(resolveTokenSecret({ JAYPOST_TOKEN: 'short-secret' }, file)).toEqual({
    kind: 'unusable',
    message: "JAYPOST_TOKEN isn't a valid jaypost token",
  })
  writeFileSync(file, `${TOKEN}=\n`)
  const result = resolveTokenSecret({}, file)
  expect(result).toEqual({
    kind: 'unusable',
    message: `token file ${JSON.stringify(file)} isn't a valid jaypost token`,
  })
  expect(JSON.stringify(result)).not.toContain(TOKEN)
})

test('an unreadable token file is unusable', () => {
  mkdirSync(file)
  const result = resolveTokenSecret({}, file)
  expect(result.kind).toBe('unusable')
  if (result.kind !== 'unusable') {
    return
  }
  expect(result.message.startsWith(`token file ${JSON.stringify(file)} couldn't be read: `)).toBe(
    true,
  )
})

test('resolveEnvToken reads only JAYPOST_TOKEN and reports a bad one without quoting it', () => {
  expect(resolveEnvToken({})).toEqual({ kind: 'none' })
  expect(resolveEnvToken({ JAYPOST_TOKEN: TOKEN })).toEqual({
    kind: 'token',
    token: TOKEN,
    source: 'env',
  })
  const bad = resolveEnvToken({ JAYPOST_TOKEN: 'secret value!' })
  expect(bad).toEqual({ kind: 'unusable', message: "JAYPOST_TOKEN isn't a valid jaypost token" })
  expect(JSON.stringify(bad)).not.toContain('secret value!')
})
