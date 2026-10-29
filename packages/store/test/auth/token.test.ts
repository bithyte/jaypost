import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vite-plus/test'
import {
  generateToken,
  parseToken,
  readTokenFile,
  removeTokenFile,
  resolveClientToken,
  resolveEnvToken,
  resolveTokenFile,
  writeTokenFile,
} from '../../src/auth/index.ts'

const TOKEN = 'a'.repeat(43)
const HAND_SET = 'Ab+/._~-'.repeat(5)
let directory: string
let file: string

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

test('resolveTokenFile uses the install directory and ignores JAYPOST_CONFIG', () => {
  expect(
    resolveTokenFile({
      XDG_CONFIG_HOME: '/x',
      HOME: '/h',
      JAYPOST_CONFIG: '/c/config.json',
    }),
  ).toBe('/x/jaypost/service/token')
  expect(resolveTokenFile({ HOME: '/h' })).toBe('/h/.config/jaypost/service/token')
})

test('writeTokenFile writes 0600 with a trailing newline through a new inode', () => {
  writeFileSync(file, 'old', { mode: 0o644 })
  const before = statSync(file).ino
  writeTokenFile(file, TOKEN)
  const after = statSync(file)
  expect(readFileSync(file, 'utf8')).toBe(`${TOKEN}\n`)
  expect(after.mode & 0o777).toBe(0o600)
  expect(after.ino).not.toBe(before)
  expect(readdirSync(directory)).toEqual(['token'])
})

test('readTokenFile returns undefined for a missing file and removeTokenFile tolerates one', () => {
  expect(readTokenFile(file)).toBeUndefined()
  removeTokenFile(file)
  writeTokenFile(file, TOKEN)
  expect(readTokenFile(file)).toBe(`${TOKEN}\n`)
  removeTokenFile(file)
  expect(readdirSync(directory)).toEqual([])
})

test('resolveClientToken prefers the env, then the file, then none', () => {
  writeTokenFile(file, TOKEN)
  expect(resolveClientToken({ JAYPOST_TOKEN: HAND_SET }, file)).toEqual({
    kind: 'token',
    token: HAND_SET,
    source: 'env',
  })
  expect(resolveClientToken({ JAYPOST_TOKEN: '' }, file)).toEqual({
    kind: 'token',
    token: TOKEN,
    source: 'file',
  })
  expect(resolveClientToken({}, join(directory, 'none'))).toEqual({ kind: 'none' })
})

test('a token file with CRLF and spaces is read trimmed', () => {
  writeFileSync(file, `  ${TOKEN}  \r\n`)
  expect(resolveClientToken({}, file)).toEqual({ kind: 'token', token: TOKEN, source: 'file' })
})

test('an invalid env or file token is unusable and the message never quotes it', () => {
  expect(resolveClientToken({ JAYPOST_TOKEN: 'short-secret' }, file)).toEqual({
    kind: 'unusable',
    message: "JAYPOST_TOKEN isn't a valid jaypost token",
  })
  writeFileSync(file, `${TOKEN}=\n`)
  const result = resolveClientToken({}, file)
  expect(result).toEqual({
    kind: 'unusable',
    message: `token file ${JSON.stringify(file)} isn't a valid jaypost token`,
  })
  expect(JSON.stringify(result)).not.toContain(TOKEN)
})

test('an unreadable token file is unusable', () => {
  mkdirSync(file)
  const result = resolveClientToken({}, file)
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
