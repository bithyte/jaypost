import { expect, test } from 'vite-plus/test'
import {
  EMPTY_BOOK,
  findRemote,
  removeBot,
  removeLocal,
  renameBot,
  saveBot,
  saveRemote,
  setDefaultBot,
  setLocal,
  toServiceUrl,
} from '../../src/book/index.ts'
import type { Book, BookBot, BookChange } from '../../src/book/index.ts'

const KEY_A = `jpk_${'a'.repeat(43)}`
const KEY_B = `jpk_${'b'.repeat(43)}`
const BOT_A: BookBot = { alias: 'NeveuBot', url: 'http://203.0.113.7:8787/', key: KEY_A }
const BOT_B: BookBot = { alias: 'Other', url: 'https://other.example/', key: KEY_B }

function changed(change: BookChange): Book {
  if (change.kind !== 'changed') {
    throw new Error(`expected changed, got ${change.message}`)
  }
  return change.book
}

test('saveBot on an empty book makes it the default', () => {
  expect(saveBot(EMPTY_BOOK, BOT_A)).toEqual({ ...EMPTY_BOOK, default: 'NeveuBot', bots: [BOT_A] })
})

test('saveBot replaces an entry whose alias differs only by case', () => {
  const book = saveBot(saveBot(EMPTY_BOOK, BOT_A), { ...BOT_A, alias: 'neveubot', key: KEY_B })
  expect(book.bots).toEqual([{ ...BOT_A, alias: 'neveubot', key: KEY_B }])
})

test('removeBot of the default moves the default to the first remaining bot', () => {
  const book = saveBot(saveBot(EMPTY_BOOK, BOT_A), BOT_B)
  expect(changed(removeBot(book, 'neveubot')).default).toBe('Other')
})

test('removeBot of the last bot leaves no default', () => {
  const book = changed(removeBot(saveBot(EMPTY_BOOK, BOT_A), 'NeveuBot'))
  expect('default' in book).toBe(false)
  expect(book.bots).toEqual([])
})

test('renameBot keeps the default on the renamed entry', () => {
  const book = changed(renameBot(saveBot(EMPTY_BOOK, BOT_A), 'NeveuBot', 'home'))
  expect(book.default).toBe('home')
  expect(book.bots).toEqual([{ ...BOT_A, alias: 'home' }])
})

test("renameBot onto another entry's alias fails", () => {
  const book = saveBot(saveBot(EMPTY_BOOK, BOT_A), BOT_B)
  expect(renameBot(book, 'NeveuBot', 'other')).toEqual({
    kind: 'failed',
    message: 'a bot is already named "other"',
  })
})

test('setDefaultBot of an unknown alias fails with no bot "x" in your contacts', () => {
  expect(setDefaultBot(EMPTY_BOOK, 'x')).toEqual({
    kind: 'failed',
    message: 'no bot "x" in your contacts',
  })
})

test('setLocal on a reinstall updates the renamed seed in place', () => {
  const local = { url: 'http://127.0.0.1:8787/' }
  const seed: BookBot = { alias: 'local', url: local.url, key: KEY_A }
  const first = setLocal(EMPTY_BOOK, local, seed)
  const renamed = changed(renameBot(first, 'local', 'home'))
  const again = setLocal(renamed, local, seed)
  expect(again.bots).toEqual([{ ...seed, alias: 'home' }])
  expect(again.default).toBe('home')
})

test('removeLocal drops local and its bots and fixes the default', () => {
  const local = { url: 'http://127.0.0.1:8787/' }
  const seed: BookBot = { alias: 'local', url: local.url, key: KEY_A }
  const book = removeLocal(saveBot(setLocal(EMPTY_BOOK, local, seed), BOT_B))
  expect('local' in book).toBe(false)
  expect(book.bots).toEqual([BOT_B])
  expect(book.default).toBe('Other')
})

test('findRemote matches the name case-insensitively and the url host', () => {
  const remote = { name: 'Home', url: 'https://home.example:8443/', adminKey: KEY_A }
  const book = saveRemote(EMPTY_BOOK, remote)
  expect(findRemote(book, 'hOME')).toEqual(remote)
  expect(findRemote(book, 'home.example:8443')).toEqual(remote)
  expect(findRemote(book, 'nope')).toBeUndefined()
})

test('toServiceUrl rejects credentials, query, fragment and non-http schemes', () => {
  expect(toServiceUrl('http://203.0.113.7:8787')).toBe('http://203.0.113.7:8787/')
  for (const raw of [
    'http://user:pw@host/',
    'http://host/?a=1',
    'http://host/#x',
    'ftp://host/',
    'nonsense',
  ]) {
    expect(toServiceUrl(raw)).toBeUndefined()
  }
})

test('saveBot over the default with a different case moves the default to the new spelling', () => {
  const book: Book = { ...EMPTY_BOOK, default: 'neveubot', bots: [{ ...BOT_A, alias: 'neveubot' }] }
  expect(saveBot(book, BOT_A)).toEqual({ ...book, default: 'NeveuBot', bots: [BOT_A] })
})
