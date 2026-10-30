import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vite-plus/test'
import { encodeInvite, readBook, writeBook } from '@jaypost/store'
import type { Book } from '@jaypost/store'
import { runJoin } from '../../src/commands/index.ts'
import type { JoinDeps, StatusFetch, WaitOptions, WaitResult } from '../../src/commands/index.ts'
import { UNAUTHORIZED_STATUS, UNREACHABLE_STATUS } from '../../src/commands/constants.ts'
import { createRecordingProgress } from '../progress/recording.ts'

const KEY = 'K'.repeat(43)
const URL_TEXT = 'https://bots.example.com/'
const INVITE = encodeInvite({ url: URL_TEXT, key: KEY })

let bookPath: string
let out: string[]
let errors: string[]
let confirmed: string[]
let answer: boolean
let fetched: StatusFetch
let waited: WaitOptions[]
let waitResult: WaitResult

beforeEach(() => {
  bookPath = join(mkdtempSync(join(tmpdir(), 'join-')), 'bots.json')
  out = []
  errors = []
  confirmed = []
  answer = true
  fetched = { kind: 'answered', status: { paired: true, displayName: '@fixture_bot' } }
  waited = []
  waitResult = 'paired'
})

function deps(isInteractive = false): JoinDeps {
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
      select: async (_message, _options, initialValue) => initialValue,
    },
    print: (text) => out.push(text),
    printError: (text) => errors.push(text),
    fetchStatus: async () => fetched,
    wait: async (options) => {
      waited.push(options)
      return waitResult
    },
    progress: createRecordingProgress().progress,
  }
}

function emptyBook(): Book {
  return { version: 1, remotes: [], bots: [] }
}

test('join saves the bot under its display name and makes it the default on an empty book', async () => {
  expect(await runJoin({ invite: INVITE }, deps())).toBe(0)
  expect(readBook(bookPath)).toEqual({
    version: 1,
    default: 'fixture_bot',
    remotes: [],
    bots: [{ alias: 'fixture_bot', url: URL_TEXT, key: KEY }],
  })
  expect(out).toEqual([
    'Added fixture_bot (https://bots.example.com) to your contacts, set as default.',
    'Try: jaypost ping',
  ])
  expect(errors).toEqual([])
})

test('join accepts a pasted join command with whitespace', async () => {
  expect(await runJoin({ invite: `  jaypost bots join ${INVITE}\n` }, deps())).toBe(0)
  expect(readBook(bookPath).bots).toHaveLength(1)
})

test('join falls back to the url host without a display name', async () => {
  fetched = { kind: 'answered', status: { paired: true } }
  expect(await runJoin({ invite: INVITE }, deps())).toBe(0)
  expect(readBook(bookPath).bots[0]?.alias).toBe('bots.example.com')
})

test('join waits for pairing and ends with the try line', async () => {
  fetched = {
    kind: 'answered',
    status: { paired: false, code: 'K7QM-4XPD', displayName: 'fixture_bot' },
  }
  expect(await runJoin({ invite: INVITE }, deps())).toBe(0)
  expect(waited).toHaveLength(1)
  expect(waited[0]?.url.href).toBe(URL_TEXT)
  expect(waited[0]?.token).toBe(KEY)
  expect(out.at(-1)).toBe('Try: jaypost ping')
})

test('join with --as uses that alias and keeps the existing default', async () => {
  writeBook(bookPath, {
    version: 1,
    default: 'home',
    remotes: [],
    bots: [{ alias: 'home', url: 'http://127.0.0.1:8080/' }],
  })
  expect(await runJoin({ invite: INVITE, as: 'work' }, deps())).toBe(0)
  const book = readBook(bookPath)
  expect(book.default).toBe('home')
  expect(book.bots.map((bot) => bot.alias)).toEqual(['home', 'work'])
  expect(out).toEqual([
    'Added work (https://bots.example.com) to your contacts.',
    'Try: jaypost ping -b work',
  ])
})

test('join asks before replacing a taken alias on a terminal', async () => {
  writeBook(bookPath, {
    version: 1,
    default: 'fixture_bot',
    remotes: [],
    bots: [{ alias: 'fixture_bot', url: 'http://127.0.0.1:8080/', key: 'O'.repeat(43) }],
  })
  expect(await runJoin({ invite: INVITE }, deps(true))).toBe(0)
  expect(confirmed).toEqual(['Replace "fixture_bot" in your contacts?'])
  expect(readBook(bookPath).bots).toEqual([{ alias: 'fixture_bot', url: URL_TEXT, key: KEY }])
})

test('join keeps the old entry when the replace is declined', async () => {
  const original: Book = {
    version: 1,
    default: 'fixture_bot',
    remotes: [],
    bots: [{ alias: 'fixture_bot', url: 'http://127.0.0.1:8080/' }],
  }
  writeBook(bookPath, original)
  answer = false
  expect(await runJoin({ invite: INVITE }, deps(true))).toBe(1)
  expect(readBook(bookPath)).toEqual(original)
})

test('join fails with an --as hint for a taken alias off a terminal', async () => {
  const original: Book = {
    version: 1,
    default: 'fixture_bot',
    remotes: [],
    bots: [{ alias: 'fixture_bot', url: 'http://127.0.0.1:8080/' }],
  }
  writeBook(bookPath, original)
  expect(await runJoin({ invite: INVITE }, deps())).toBe(1)
  expect(errors.join('\n')).toContain('--as')
  expect(errors.join('\n')).toContain('fixture_bot')
  expect(readBook(bookPath)).toEqual(original)
})

test('join saves nothing when the service rejects the key', async () => {
  fetched = UNAUTHORIZED_STATUS
  expect(await runJoin({ invite: INVITE }, deps())).toBe(1)
  expect(errors).toEqual(['the service rejected the key in this invite'])
  expect(readBook(bookPath)).toEqual(emptyBook())
})

test('join saves nothing when the service is unreachable', async () => {
  fetched = UNREACHABLE_STATUS
  expect(await runJoin({ invite: INVITE }, deps())).toBe(1)
  expect(errors).toEqual(["couldn't reach https://bots.example.com"])
  expect(readBook(bookPath)).toEqual(emptyBook())
})

test('join rejects a truncated invite without echoing it', async () => {
  const truncated = INVITE.slice(0, 20)
  expect(await runJoin({ invite: truncated }, deps())).toBe(1)
  expect(errors).toEqual(["that isn't a valid invite; ask for a new one"])
  expect(errors.join('')).not.toContain(truncated)
  expect(waited).toEqual([])
})

test('join keeps the entry when interrupted while waiting', async () => {
  fetched = { kind: 'answered', status: { paired: false, code: 'K7QM-4XPD' } }
  waitResult = 'interrupted'
  expect(await runJoin({ invite: INVITE }, deps())).toBe(130)
  expect(readBook(bookPath).bots).toHaveLength(1)
})

test.each(['notStarted', 'stopped'] as const)('join reports a service that %s', async (result) => {
  fetched = { kind: 'answered', status: { paired: false, code: 'K7QM-4XPD' } }
  waitResult = result
  expect(await runJoin({ invite: INVITE }, deps())).toBe(1)
  expect(errors).toEqual(['the service stopped answering; the key works once you send the code'])
  expect(readBook(bookPath).bots).toHaveLength(1)
})

test('join reports a key rejected while waiting', async () => {
  fetched = { kind: 'answered', status: { paired: false, code: 'K7QM-4XPD' } }
  waitResult = 'unauthorized'
  expect(await runJoin({ invite: INVITE }, deps())).toBe(1)
  expect(errors).toEqual(['the service rejected the key in this invite'])
})

test('join fails naming the file on a corrupt book and leaves it alone', async () => {
  writeFileSync(bookPath, '{ not json')
  expect(await runJoin({ invite: INVITE }, deps())).toBe(1)
  expect(errors.join('\n')).toContain(bookPath)
  expect(errors.join('\n')).not.toContain(KEY)
})
