import { expect, test } from 'vite-plus/test'
import {
  EMPTY_INBOX,
  findRemote,
  removeBot,
  removeLocal,
  renameBot,
  saveBot,
  saveRemote,
  setDefaultBot,
  setLocal,
  toServiceUrl,
} from '../../src/inbox/index.ts'
import type { Inbox, InboxBot, InboxChange } from '../../src/inbox/index.ts'

const KEY_A = `jpk_${'a'.repeat(43)}`
const KEY_B = `jpk_${'b'.repeat(43)}`
const BOT_A: InboxBot = { alias: 'NeveuBot', url: 'http://203.0.113.7:8787/', key: KEY_A }
const BOT_B: InboxBot = { alias: 'Other', url: 'https://other.example/', key: KEY_B }

function changed(change: InboxChange): Inbox {
  if (change.kind !== 'changed') {
    throw new Error(`expected changed, got ${change.message}`)
  }
  return change.inbox
}

test('saveBot on an empty inbox makes it the default', () => {
  expect(saveBot(EMPTY_INBOX, BOT_A)).toEqual({
    ...EMPTY_INBOX,
    default: 'NeveuBot',
    bots: [BOT_A],
  })
})

test('saveBot replaces an entry whose alias differs only by case', () => {
  const inbox = saveBot(saveBot(EMPTY_INBOX, BOT_A), { ...BOT_A, alias: 'neveubot', key: KEY_B })
  expect(inbox.bots).toEqual([{ ...BOT_A, alias: 'neveubot', key: KEY_B }])
})

test('removeBot of the default moves the default to the first remaining bot', () => {
  const inbox = saveBot(saveBot(EMPTY_INBOX, BOT_A), BOT_B)
  expect(changed(removeBot(inbox, 'neveubot')).default).toBe('Other')
})

test('removeBot of the last bot leaves no default', () => {
  const inbox = changed(removeBot(saveBot(EMPTY_INBOX, BOT_A), 'NeveuBot'))
  expect('default' in inbox).toBe(false)
  expect(inbox.bots).toEqual([])
})

test('renameBot keeps the default on the renamed entry', () => {
  const inbox = changed(renameBot(saveBot(EMPTY_INBOX, BOT_A), 'NeveuBot', 'home'))
  expect(inbox.default).toBe('home')
  expect(inbox.bots).toEqual([{ ...BOT_A, alias: 'home' }])
})

test("renameBot onto another entry's alias fails", () => {
  const inbox = saveBot(saveBot(EMPTY_INBOX, BOT_A), BOT_B)
  expect(renameBot(inbox, 'NeveuBot', 'other')).toEqual({
    kind: 'failed',
    message: 'a bot is already named "other"',
  })
})

test('setDefaultBot of an unknown alias fails with no bot "x" in your inbox', () => {
  expect(setDefaultBot(EMPTY_INBOX, 'x')).toEqual({
    kind: 'failed',
    message: 'no bot "x" in your inbox',
  })
})

test('setLocal on a reinstall updates the renamed seed in place', () => {
  const local = { url: 'http://127.0.0.1:8787/' }
  const seed: InboxBot = { alias: 'local', url: local.url, key: KEY_A }
  const first = setLocal(EMPTY_INBOX, local, seed)
  const renamed = changed(renameBot(first, 'local', 'home'))
  const again = setLocal(renamed, local, seed)
  expect(again.bots).toEqual([{ ...seed, alias: 'home' }])
  expect(again.default).toBe('home')
})

test('removeLocal drops local and its bots and fixes the default', () => {
  const local = { url: 'http://127.0.0.1:8787/' }
  const seed: InboxBot = { alias: 'local', url: local.url, key: KEY_A }
  const inbox = removeLocal(saveBot(setLocal(EMPTY_INBOX, local, seed), BOT_B))
  expect('local' in inbox).toBe(false)
  expect(inbox.bots).toEqual([BOT_B])
  expect(inbox.default).toBe('Other')
})

test('findRemote matches the name case-insensitively and the url host', () => {
  const remote = { name: 'Home', url: 'https://home.example:8443/', adminKey: KEY_A }
  const inbox = saveRemote(EMPTY_INBOX, remote)
  expect(findRemote(inbox, 'hOME')).toEqual(remote)
  expect(findRemote(inbox, 'home.example:8443')).toEqual(remote)
  expect(findRemote(inbox, 'nope')).toBeUndefined()
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
  const inbox: Inbox = {
    ...EMPTY_INBOX,
    default: 'neveubot',
    bots: [{ ...BOT_A, alias: 'neveubot' }],
  }
  expect(saveBot(inbox, BOT_A)).toEqual({ ...inbox, default: 'NeveuBot', bots: [BOT_A] })
})
