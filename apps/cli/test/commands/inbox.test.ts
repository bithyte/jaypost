import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vite-plus/test'
import { readInbox, writeInbox } from '@jaypost/store'
import type { Inbox } from '@jaypost/store'
import {
  runInboxDefault,
  runInboxList,
  runInboxRemove,
  runInboxRename,
} from '../../src/commands/index.ts'
import type { InboxDeps } from '../../src/commands/index.ts'

const KEY_ONE = 'jp_fixtureKeyOne1234567890abcdefghijklmnopqrs'
const KEY_TWO = 'jp_fixtureKeyTwo1234567890abcdefghijklmnopqrs'
const KEY_THREE = 'jp_fixtureKeyThree234567890abcdefghijklmnopqr'
const INBOX: Inbox = {
  version: 1,
  default: 'alpha',
  remotes: [],
  bots: [
    { alias: 'alpha', url: 'http://one.example:8080/', key: KEY_ONE },
    { alias: 'beta', url: 'https://two.example/', key: KEY_TWO },
    { alias: 'gamma', url: 'http://three.example:9/', key: KEY_THREE },
  ],
}

let inboxPath: string
let out: string[]
let errors: string[]
let confirmed: string[]
let selected: string[]
let answer: boolean
let pick: string | undefined

beforeEach(() => {
  inboxPath = join(mkdtempSync(join(tmpdir(), 'bots-')), 'inbox.json')
  out = []
  errors = []
  confirmed = []
  selected = []
  answer = true
  pick = undefined
})

function deps(isInteractive = false): InboxDeps {
  return {
    inboxPath,
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

test('inbox lists aliases with the default marked and no keys', async () => {
  writeInbox(inboxPath, INBOX)
  expect(await runInboxList(deps())).toBe(0)
  const text = out.join('\n')
  const lines = text.split('\n')
  expect(lines[0]).toMatch(/^ {2,}ALIAS +SERVICE$/)
  expect(lines[1]).toMatch(/^\* +alpha +one\.example:8080$/)
  expect(lines[2]).toMatch(/^ +beta +https:\/\/two\.example$/)
  expect(text).not.toContain('jp_')
})

test('inbox on an empty inbox says how to add one', async () => {
  expect(await runInboxList(deps())).toBe(0)
  expect(out).toEqual(['No bots. Run "jaypost service install" or "jaypost inbox join".'])
})

test('inbox default switches the default', async () => {
  writeInbox(inboxPath, INBOX)
  expect(await runInboxDefault({ alias: 'BETA' }, deps())).toBe(0)
  expect(readInbox(inboxPath).default).toBe('beta')
  expect(out).toEqual(['Default bot is now "beta".'])
})

test('inbox rename keeps the default', async () => {
  writeInbox(inboxPath, INBOX)
  expect(await runInboxRename({ alias: 'alpha', newAlias: 'first' }, deps())).toBe(0)
  const inbox = readInbox(inboxPath)
  expect(inbox.default).toBe('first')
  expect(inbox.bots.map((bot) => bot.alias)).toEqual(['first', 'beta', 'gamma'])
  expect(out).toEqual(['Renamed "alpha" to "first".'])
})

test('inbox rename onto an existing alias fails and leaves the inbox', async () => {
  writeInbox(inboxPath, INBOX)
  expect(await runInboxRename({ alias: 'alpha', newAlias: 'beta' }, deps())).toBe(1)
  expect(errors).toEqual(['a bot is already named "beta"'])
  expect(readInbox(inboxPath)).toEqual(INBOX)
})

test('inbox default, rename and remove of an unknown alias fail', async () => {
  writeInbox(inboxPath, INBOX)
  expect(await runInboxDefault({ alias: 'nope' }, deps())).toBe(1)
  expect(await runInboxRename({ alias: 'nope', newAlias: 'x' }, deps())).toBe(1)
  expect(await runInboxRemove({ alias: 'nope', yes: true }, deps())).toBe(1)
  expect(errors).toEqual(Array(3).fill('no bot "nope" in your inbox'))
  expect(readInbox(inboxPath)).toEqual(INBOX)
})

test('inbox remove asks first and a decline leaves the inbox unchanged', async () => {
  writeInbox(inboxPath, INBOX)
  answer = false
  expect(await runInboxRemove({ alias: 'beta' }, deps())).toBe(1)
  expect(confirmed).toEqual(['Remove "beta" from your inbox?'])
  expect(errors).toEqual(['Cancelled.'])
  expect(readInbox(inboxPath)).toEqual(INBOX)
})

test('inbox remove asks first and removes on yes', async () => {
  writeInbox(inboxPath, INBOX)
  expect(await runInboxRemove({ alias: 'beta' }, deps())).toBe(0)
  expect(readInbox(inboxPath).bots.map((bot) => bot.alias)).toEqual(['alpha', 'gamma'])
  expect(out).toEqual(['Removed "beta".'])
})

test('inbox remove --yes skips the question', async () => {
  writeInbox(inboxPath, INBOX)
  expect(await runInboxRemove({ alias: 'beta', yes: true }, deps())).toBe(0)
  expect(confirmed).toEqual([])
  expect(readInbox(inboxPath).bots).toHaveLength(2)
})

test('inbox remove of the default off a terminal picks the first remaining bot and says so', async () => {
  writeInbox(inboxPath, INBOX)
  expect(await runInboxRemove({ alias: 'alpha', yes: true }, deps())).toBe(0)
  expect(readInbox(inboxPath).default).toBe('beta')
  expect(selected).toEqual([])
  expect(out).toEqual(['Removed "alpha".', 'Default bot is now "beta".'])
})

test('inbox remove of the default on a terminal asks which bot is next', async () => {
  writeInbox(inboxPath, INBOX)
  pick = 'gamma'
  expect(await runInboxRemove({ alias: 'alpha', yes: true }, deps(true))).toBe(0)
  expect(selected).toHaveLength(1)
  expect(readInbox(inboxPath).default).toBe('gamma')
  expect(out).toEqual(['Removed "alpha".', 'Default bot is now "gamma".'])
})

test('inbox remove of the last bot clears the default without a pick', async () => {
  writeInbox(inboxPath, { ...INBOX, bots: [INBOX.bots[0]!] })
  expect(await runInboxRemove({ alias: 'alpha', yes: true }, deps(true))).toBe(0)
  expect(selected).toEqual([])
  expect(readInbox(inboxPath).default).toBeUndefined()
  expect(out).toEqual(['Removed "alpha".'])
})

test('inbox commands report a corrupt inbox by file and never overwrite it', async () => {
  const corrupt = `{ "version": 1, "bots": [ { "key": "${KEY_ONE}" `
  writeFileSync(inboxPath, corrupt)
  expect(await runInboxList(deps())).toBe(1)
  expect(await runInboxDefault({ alias: 'a' }, deps())).toBe(1)
  expect(await runInboxRename({ alias: 'a', newAlias: 'b' }, deps())).toBe(1)
  expect(await runInboxRemove({ alias: 'a', yes: true }, deps())).toBe(1)
  expect(errors).toHaveLength(4)
  for (const message of errors) {
    expect(message).toContain(inboxPath)
    expect(message).not.toContain(KEY_ONE)
  }
  expect(readFileSync(inboxPath, 'utf8')).toBe(corrupt)
})
