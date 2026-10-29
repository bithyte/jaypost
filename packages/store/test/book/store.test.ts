import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vite-plus/test'
import {
  EMPTY_BOOK,
  findLocalSeedBot,
  readBook,
  removeLocal,
  writeBook,
} from '../../src/book/index.ts'
import type { Book } from '../../src/book/index.ts'

const KEY = `jpk_${'a'.repeat(43)}`
const BOOK: Book = {
  version: 1,
  default: 'NeveuBot',
  local: { url: 'http://127.0.0.1:8787/' },
  remotes: [{ name: 'home', url: 'https://home.example/', adminKey: `jpa_${'b'.repeat(43)}` }],
  bots: [{ alias: 'NeveuBot', url: 'http://203.0.113.7:8787/', key: KEY }],
}

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jaypost-book-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('readBook returns an empty book when the file is missing', () => {
  expect(readBook(join(dir, 'bots.json'))).toEqual(EMPTY_BOOK)
})

test('writeBook then readBook round-trips and the file is mode 0600', () => {
  const path = join(dir, 'bots.json')
  writeBook(path, BOOK)
  expect(readBook(path)).toEqual(BOOK)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(BOOK, null, 2)}\n`)
})

test('writeBook tightens a file that was 0644', () => {
  const path = join(dir, 'bots.json')
  writeFileSync(path, '{}')
  chmodSync(path, 0o644)
  writeBook(path, BOOK)
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test('readBook rejects bad json, a wrong version and a bot without url, naming the file and no key', () => {
  const path = join(dir, 'bots.json')
  const bad = [
    '{not json',
    JSON.stringify({ ...BOOK, version: 2 }),
    JSON.stringify({ ...BOOK, bots: [{ alias: 'x', key: KEY }] }),
  ]
  for (const text of bad) {
    writeFileSync(path, text)
    expect(() => readBook(path)).toThrow(/contact book ".*bots\.json" isn't valid/)
    expect(() => readBook(path)).not.toThrow(KEY)
  }
})

test('readBook rejects a bad url in local, remotes and bots by path, never quoting the value', () => {
  const path = join(dir, 'bots.json')
  const cases = [
    { book: { ...BOOK, local: { url: 'not a url' } }, field: 'local.url' },
    {
      book: { ...BOOK, remotes: [{ ...BOOK.remotes[0], url: 'not a url' }] },
      field: 'remotes.0.url',
    },
    {
      book: { ...BOOK, bots: [{ ...BOOK.bots[0], url: 'not a url' }] },
      field: 'bots.0.url',
    },
    {
      book: { ...BOOK, bots: [{ ...BOOK.bots[0], url: 'ftp://host/' }] },
      field: 'bots.0.url',
    },
  ]
  for (const { book, field } of cases) {
    writeFileSync(path, JSON.stringify(book))
    expect(() => readBook(path)).toThrow(`isn't valid: ${field}`)
    expect(() => readBook(path)).not.toThrow('not a url')
    expect(() => readBook(path)).not.toThrow('ftp')
    expect(() => readBook(path)).toThrow(path)
  }
})

test('readBook normalizes a hand-written url so it matches the CLI-written one', () => {
  const path = join(dir, 'bots.json')
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      local: { url: 'http://127.0.0.1:8787' },
      remotes: [],
      bots: [{ alias: 'a', url: 'http://127.0.0.1:8787' }],
    }),
  )
  const book = readBook(path)
  expect(book.local?.url).toBe('http://127.0.0.1:8787/')
  expect(findLocalSeedBot(book)?.alias).toBe('a')
  expect(removeLocal(book).bots).toEqual([])
})
