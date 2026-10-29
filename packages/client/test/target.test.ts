import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vite-plus/test'
import { resolveBookPath, writeBook } from '@jaypost/store'
import type { Book } from '@jaypost/store'
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

function saveBook(book: Book): void {
  writeBook(resolveBookPath(envFor()), book)
}

const BOOK: Book = {
  version: 1,
  default: 'home',
  remotes: [],
  bots: [
    { alias: 'home', url: 'http://127.0.0.1:9000/', key: KEY },
    { alias: 'open', url: 'https://relay.example.com/team' },
  ],
}

test('resolveBot sends the named bot key to its url', () => {
  saveBook(BOOK)
  const bot = resolveBot(envFor(), 'home')
  expect(bot).toEqual({
    endpoint: { kind: 'url', url: new URL('http://127.0.0.1:9000/') },
    token: { kind: 'token', token: KEY, source: 'book' },
    alias: 'home',
  })
})

test('resolveBot with a keyless bot sends no token', () => {
  saveBook(BOOK)
  expect(resolveBot(envFor(), 'open').token).toEqual({ kind: 'none' })
})

test('resolveBot with -b never uses JAYPOST_TOKEN', () => {
  saveBook(BOOK)
  const bot = resolveBot(envFor({ JAYPOST_TOKEN: ENV_TOKEN }), 'home')
  expect(bot.token).toEqual({ kind: 'token', token: KEY, source: 'book' })
})

test('resolveBot in env mode never reads the book', () => {
  saveBook(BOOK)
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
  saveBook(BOOK)
  const bot = resolveBot(envFor(), 'nope')
  expect(bot).toEqual({
    endpoint: {
      kind: 'invalid',
      message: 'no bot "nope" in your contacts; known: home, open',
    },
    token: { kind: 'none' },
    alias: undefined,
  })
})

test('resolveBot reports an unreadable book by its path, not its contents', () => {
  const path = resolveBookPath(envFor())
  mkdirSync(path, { recursive: true })
  const bot = resolveBot(envFor(), 'home')
  expect(bot.endpoint.kind).toBe('invalid')
  expect(bot.token).toEqual({ kind: 'none' })
  expect(bot.alias).toBeUndefined()
  expect(JSON.stringify(bot)).toContain(path)
})
