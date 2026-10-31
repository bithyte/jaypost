import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vite-plus/test'
import {
  EMPTY_INBOX,
  findLocalSeedBot,
  readInbox,
  removeLocal,
  writeInbox,
} from '../../src/inbox/index.ts'
import type { Inbox } from '../../src/inbox/index.ts'

const KEY = `jpk_${'a'.repeat(43)}`
const INBOX: Inbox = {
  version: 1,
  default: 'NeveuBot',
  local: { url: 'http://127.0.0.1:8787/' },
  remotes: [{ name: 'home', url: 'https://home.example/', adminKey: `jpa_${'b'.repeat(43)}` }],
  bots: [{ alias: 'NeveuBot', url: 'http://203.0.113.7:8787/', key: KEY }],
}

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jaypost-inbox-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('readInbox returns an empty inbox when the file is missing', () => {
  expect(readInbox(join(dir, 'inbox.json'))).toEqual(EMPTY_INBOX)
})

test('writeInbox then readInbox round-trips and the file is mode 0600', () => {
  const path = join(dir, 'inbox.json')
  writeInbox(path, INBOX)
  expect(readInbox(path)).toEqual(INBOX)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(INBOX, null, 2)}\n`)
})

test('writeInbox tightens a file that was 0644', () => {
  const path = join(dir, 'inbox.json')
  writeFileSync(path, '{}')
  chmodSync(path, 0o644)
  writeInbox(path, INBOX)
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test('readInbox rejects bad json, a wrong version and a bot without url, naming the file and no key', () => {
  const path = join(dir, 'inbox.json')
  const bad = [
    '{not json',
    JSON.stringify({ ...INBOX, version: 2 }),
    JSON.stringify({ ...INBOX, bots: [{ alias: 'x', key: KEY }] }),
  ]
  for (const text of bad) {
    writeFileSync(path, text)
    expect(() => readInbox(path)).toThrow(/inbox ".*inbox\.json" isn't valid/)
    expect(() => readInbox(path)).not.toThrow(KEY)
  }
})

test('readInbox rejects a bad url in local, remotes and bots by path, never quoting the value', () => {
  const path = join(dir, 'inbox.json')
  const cases = [
    { inbox: { ...INBOX, local: { url: 'not a url' } }, field: 'local.url' },
    {
      inbox: { ...INBOX, remotes: [{ ...INBOX.remotes[0], url: 'not a url' }] },
      field: 'remotes.0.url',
    },
    {
      inbox: { ...INBOX, bots: [{ ...INBOX.bots[0], url: 'not a url' }] },
      field: 'bots.0.url',
    },
    {
      inbox: { ...INBOX, bots: [{ ...INBOX.bots[0], url: 'ftp://host/' }] },
      field: 'bots.0.url',
    },
  ]
  for (const { inbox, field } of cases) {
    writeFileSync(path, JSON.stringify(inbox))
    expect(() => readInbox(path)).toThrow(`isn't valid: ${field}`)
    expect(() => readInbox(path)).not.toThrow('not a url')
    expect(() => readInbox(path)).not.toThrow('ftp')
    expect(() => readInbox(path)).toThrow(path)
  }
})

test('readInbox normalizes a hand-written url so it matches the CLI-written one', () => {
  const path = join(dir, 'inbox.json')
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      local: { url: 'http://127.0.0.1:8787' },
      remotes: [],
      bots: [{ alias: 'a', url: 'http://127.0.0.1:8787' }],
    }),
  )
  const inbox = readInbox(path)
  expect(inbox.local?.url).toBe('http://127.0.0.1:8787/')
  expect(findLocalSeedBot(inbox)?.alias).toBe('a')
  expect(removeLocal(inbox).bots).toEqual([])
})
