import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vite-plus/test'
import { resolveInboxPath, writeInbox } from '@jaypost/store'
import type { Inbox } from '@jaypost/store'
import { resolveBot } from '../src/index.ts'

const KEY = 'K'.repeat(43)
const ENV_TOKEN = 'E'.repeat(43)
let directory = ''

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jaypost-target-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

const envFor = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  XDG_CONFIG_HOME: directory,
  ...extra,
})

function saveInbox(inbox: Inbox): void {
  writeInbox(resolveInboxPath(envFor()), inbox)
}

const INBOX: Inbox = {
  version: 1,
  default: 'home',
  remotes: [],
  bots: [
    { alias: 'home', url: 'http://127.0.0.1:9000/', key: KEY },
    { alias: 'open', url: 'https://relay.example.com/team' },
  ],
}

test('resolveBot sends the named bot key to its url', () => {
  saveInbox(INBOX)
  const bot = resolveBot(envFor(), 'home')
  expect(bot).toEqual({
    endpoint: { kind: 'url', url: new URL('http://127.0.0.1:9000/') },
    token: { kind: 'token', token: KEY, source: 'inbox' },
    alias: 'home',
  })
})

test('resolveBot with a keyless bot sends no token', () => {
  saveInbox(INBOX)
  expect(resolveBot(envFor(), 'open').token).toEqual({ kind: 'none' })
})

test('resolveBot with -b never uses JAYPOST_TOKEN', () => {
  saveInbox(INBOX)
  const bot = resolveBot(envFor({ JAYPOST_TOKEN: ENV_TOKEN }), 'home')
  expect(bot.token).toEqual({ kind: 'token', token: KEY, source: 'inbox' })
})

test('resolveBot in env mode never reads the inbox', () => {
  saveInbox(INBOX)
  const bot = resolveBot(envFor({ JAYPOST_TOKEN: ENV_TOKEN }), undefined)
  expect(bot).toEqual({
    endpoint: { kind: 'url', url: new URL('http://127.0.0.1:8787/') },
    token: { kind: 'token', token: ENV_TOKEN, source: 'env' },
    alias: undefined,
  })
})

test('resolveBot in env mode uses JAYPOST_URL and a valid JAYPOST_PORT', () => {
  expect(resolveBot(envFor({ JAYPOST_URL: 'https://x.example.com/' }), undefined).endpoint).toEqual(
    { kind: 'url', url: new URL('https://x.example.com/') },
  )
  expect(
    resolveBot(envFor({ JAYPOST_TOKEN: ENV_TOKEN, JAYPOST_PORT: '9001' }), undefined).endpoint,
  ).toEqual({ kind: 'url', url: new URL('http://127.0.0.1:9001/') })
})

test('resolveBot turns an unknown alias into an invalid endpoint listing the known ones', () => {
  saveInbox(INBOX)
  const bot = resolveBot(envFor(), 'nope')
  expect(bot).toEqual({
    endpoint: {
      kind: 'invalid',
      message: 'no bot "nope" in your inbox; known: home, open',
    },
    token: { kind: 'none' },
    alias: undefined,
    failure: 'unresolvable',
  })
})

test('resolveBot prefers the alias, then JAYPOST_BOT, then env mode, then the default', () => {
  saveInbox(INBOX)
  const env = envFor({ JAYPOST_BOT: 'open', JAYPOST_URL: 'https://x.example.com/' })
  expect(resolveBot(env, 'HOME').alias).toBe('home')
  expect(resolveBot(env, undefined).alias).toBe('open')
  expect(resolveBot(envFor({ JAYPOST_URL: 'https://x.example.com/' }), undefined).alias).toBe(
    undefined,
  )
  expect(resolveBot(envFor(), undefined).alias).toBe('home')
})

test('resolveBot says an unknown JAYPOST_BOT has an empty inbox to pick from', () => {
  expect(resolveBot(envFor({ JAYPOST_BOT: 'nope' }), undefined).endpoint).toEqual({
    kind: 'invalid',
    message: 'no bot "nope" in your inbox; it\'s empty',
  })
})

test('resolveBot with no inbox and no env fails as no bot, saying how to add one', () => {
  expect(resolveBot(envFor(), undefined)).toEqual({
    endpoint: {
      kind: 'invalid',
      message: 'no bot to send to; run "jaypost service install" or "jaypost inbox join"',
    },
    token: { kind: 'none' },
    alias: undefined,
    failure: 'noBot',
  })
})

test('resolveBot marks an invalid JAYPOST_URL as unresolvable, not as no bot', () => {
  expect(resolveBot(envFor({ JAYPOST_URL: 'not a url' }), undefined).failure).toBe('unresolvable')
})

test('resolveBot reports an unreadable inbox by its path, not its contents', () => {
  const path = resolveInboxPath(envFor())
  mkdirSync(path, { recursive: true })
  const bot = resolveBot(envFor(), 'home')
  expect(bot.endpoint.kind).toBe('invalid')
  expect(bot.token).toEqual({ kind: 'none' })
  expect(bot.alias).toBeUndefined()
  expect(JSON.stringify(bot)).toContain(path)
})

test.each([
  ['truncated json', `{"version":1,"bots":[{"alias":"home","key":"${KEY}"`],
  ['garbage', `not json ${KEY}`],
  ['wrong version', JSON.stringify({ version: 2, remotes: [], bots: [], key: KEY })],
  [
    'bot missing url',
    JSON.stringify({ version: 1, remotes: [], bots: [{ alias: 'home', key: KEY }] }),
  ],
])('resolveBot reports a corrupt inbox (%s) by its path without its contents', (_name, text) => {
  const path = resolveInboxPath(envFor())
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  const bot = resolveBot(envFor(), 'home')
  expect(bot.endpoint.kind).toBe('invalid')
  expect(bot.token).toEqual({ kind: 'none' })
  expect(JSON.stringify(bot)).toContain(path)
  expect(JSON.stringify(bot)).not.toContain(KEY)
})

test('resolveBot turns a bad url in the inbox into an invalid endpoint naming the file, never throwing', () => {
  const path = resolveInboxPath(envFor())
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      remotes: [],
      bots: [{ alias: 'home', url: 'not a url' }],
    }),
  )
  const bot = resolveBot(envFor(), 'home')
  expect(bot.endpoint).toEqual({
    kind: 'invalid',
    message: `inbox ${JSON.stringify(path)} isn't valid: bots.0.url`,
  })
  expect(bot.token).toEqual({ kind: 'none' })
})
