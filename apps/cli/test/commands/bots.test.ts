import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vite-plus/test'
import { readBook, writeBook } from '@jaypost/store'
import type { Book } from '@jaypost/store'
import {
  runBotsDefault,
  runBotsList,
  runBotsRemove,
  runBotsRename,
} from '../../src/commands/index.ts'
import type { BookDeps } from '../../src/commands/index.ts'

const KEY_ONE = 'jp_fixtureKeyOne1234567890abcdefghijklmnopqrs'
const KEY_TWO = 'jp_fixtureKeyTwo1234567890abcdefghijklmnopqrs'
const KEY_THREE = 'jp_fixtureKeyThree234567890abcdefghijklmnopqr'
const BOOK: Book = {
  version: 1,
  default: 'alpha',
  remotes: [],
  bots: [
    { alias: 'alpha', url: 'http://one.example:8080/', key: KEY_ONE },
    { alias: 'beta', url: 'https://two.example/', key: KEY_TWO },
    { alias: 'gamma', url: 'http://three.example:9/', key: KEY_THREE },
  ],
}

let bookPath: string
let out: string[]
let errors: string[]
let confirmed: string[]
let selected: string[]
let answer: boolean
let pick: string | undefined

beforeEach(() => {
  bookPath = join(mkdtempSync(join(tmpdir(), 'bots-')), 'bots.json')
  out = []
  errors = []
  confirmed = []
  selected = []
  answer = true
  pick = undefined
})

function deps(isInteractive = false): BookDeps {
  return {
    bookPath,
    isInteractive,
    prompt: {
      confirm: async (message) => {
        confirmed.push(message)
        return answer
      },
      password: async () => '',
      text: async () => '',
      select: async <T extends string>(
        message: string,
        options: readonly { readonly value: T }[],
        initialValue: T,
      ) => {
        selected.push(message)
        return (options.find((option) => option.value === pick)?.value ?? initialValue) as T
      },
    },
    print: (text) => out.push(text),
    printError: (text) => errors.push(text),
  }
}

test('bots lists aliases with the default marked and no keys', async () => {
  writeBook(bookPath, BOOK)
  expect(await runBotsList(deps())).toBe(0)
  const text = out.join('\n')
  const lines = text.split('\n')
  expect(lines[0]).toMatch(/^ {2,}ALIAS +SERVICE$/)
  expect(lines[1]).toMatch(/^\* +alpha +one\.example:8080$/)
  expect(lines[2]).toMatch(/^ +beta +https:\/\/two\.example$/)
  expect(text).not.toContain('jp_')
})

test('bots on an empty book says how to add one', async () => {
  expect(await runBotsList(deps())).toBe(0)
  expect(out).toEqual(['No bots. Run "jaypost service install" or "jaypost join".'])
})

test('bots default switches the default', async () => {
  writeBook(bookPath, BOOK)
  expect(await runBotsDefault({ alias: 'BETA' }, deps())).toBe(0)
  expect(readBook(bookPath).default).toBe('beta')
  expect(out).toEqual(['Default bot is now "beta".'])
})

test('bots rename keeps the default', async () => {
  writeBook(bookPath, BOOK)
  expect(await runBotsRename({ alias: 'alpha', newAlias: 'first' }, deps())).toBe(0)
  const book = readBook(bookPath)
  expect(book.default).toBe('first')
  expect(book.bots.map((bot) => bot.alias)).toEqual(['first', 'beta', 'gamma'])
  expect(out).toEqual(['Renamed "alpha" to "first".'])
})

test('bots rename onto an existing alias fails and leaves the book', async () => {
  writeBook(bookPath, BOOK)
  expect(await runBotsRename({ alias: 'alpha', newAlias: 'beta' }, deps())).toBe(1)
  expect(errors).toEqual(['a bot is already named "beta"'])
  expect(readBook(bookPath)).toEqual(BOOK)
})

test('bots default, rename and remove of an unknown alias fail', async () => {
  writeBook(bookPath, BOOK)
  expect(await runBotsDefault({ alias: 'nope' }, deps())).toBe(1)
  expect(await runBotsRename({ alias: 'nope', newAlias: 'x' }, deps())).toBe(1)
  expect(await runBotsRemove({ alias: 'nope', yes: true }, deps())).toBe(1)
  expect(errors).toEqual(Array(3).fill('no bot "nope" in your contacts'))
  expect(readBook(bookPath)).toEqual(BOOK)
})

test('bots remove asks first and a decline leaves the book unchanged', async () => {
  writeBook(bookPath, BOOK)
  answer = false
  expect(await runBotsRemove({ alias: 'beta' }, deps())).toBe(1)
  expect(confirmed).toEqual(['Remove "beta" from your contacts?'])
  expect(errors).toEqual(['Cancelled.'])
  expect(readBook(bookPath)).toEqual(BOOK)
})

test('bots remove asks first and removes on yes', async () => {
  writeBook(bookPath, BOOK)
  expect(await runBotsRemove({ alias: 'beta' }, deps())).toBe(0)
  expect(readBook(bookPath).bots.map((bot) => bot.alias)).toEqual(['alpha', 'gamma'])
  expect(out).toEqual(['Removed "beta".'])
})

test('bots remove --yes skips the question', async () => {
  writeBook(bookPath, BOOK)
  expect(await runBotsRemove({ alias: 'beta', yes: true }, deps())).toBe(0)
  expect(confirmed).toEqual([])
  expect(readBook(bookPath).bots).toHaveLength(2)
})

test('bots remove of the default off a terminal picks the first remaining bot and says so', async () => {
  writeBook(bookPath, BOOK)
  expect(await runBotsRemove({ alias: 'alpha', yes: true }, deps())).toBe(0)
  expect(readBook(bookPath).default).toBe('beta')
  expect(selected).toEqual([])
  expect(out).toEqual(['Removed "alpha".', 'Default bot is now "beta".'])
})

test('bots remove of the default on a terminal asks which bot is next', async () => {
  writeBook(bookPath, BOOK)
  pick = 'gamma'
  expect(await runBotsRemove({ alias: 'alpha', yes: true }, deps(true))).toBe(0)
  expect(selected).toHaveLength(1)
  expect(readBook(bookPath).default).toBe('gamma')
  expect(out).toEqual(['Removed "alpha".', 'Default bot is now "gamma".'])
})

test('bots remove of the last bot clears the default without a pick', async () => {
  writeBook(bookPath, { ...BOOK, bots: [BOOK.bots[0]!] })
  expect(await runBotsRemove({ alias: 'alpha', yes: true }, deps(true))).toBe(0)
  expect(selected).toEqual([])
  expect(readBook(bookPath).default).toBeUndefined()
  expect(out).toEqual(['Removed "alpha".'])
})

test('bots commands report a corrupt book by file and never overwrite it', async () => {
  const corrupt = `{ "version": 1, "bots": [ { "key": "${KEY_ONE}" `
  writeFileSync(bookPath, corrupt)
  expect(await runBotsList(deps())).toBe(1)
  expect(await runBotsDefault({ alias: 'a' }, deps())).toBe(1)
  expect(await runBotsRename({ alias: 'a', newAlias: 'b' }, deps())).toBe(1)
  expect(await runBotsRemove({ alias: 'a', yes: true }, deps())).toBe(1)
  expect(errors).toHaveLength(4)
  for (const message of errors) {
    expect(message).toContain(bookPath)
    expect(message).not.toContain(KEY_ONE)
  }
  expect(readFileSync(bookPath, 'utf8')).toBe(corrupt)
})
