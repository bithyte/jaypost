import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vite-plus/test'
import { readBook, writeBook } from '@jaypost/store'
import { runRemoteAdd, runRemoteList, runRemoteRemove } from '../../src/commands/index.ts'
import type { BookDeps } from '../../src/commands/index.ts'

const ADMIN_KEY = 'jpa_fixtureAdminKey1234567890abcdefghijklmnop'

let server: Server
let baseUrl: string
let status: number
let bookPath: string
let out: string[]
let errors: string[]
let confirmed: string[]
let answer: boolean

beforeEach(async () => {
  status = 200
  bookPath = join(mkdtempSync(join(tmpdir(), 'remote-')), 'bots.json')
  out = []
  errors = []
  confirmed = []
  answer = true
  server = createServer((request, response) => {
    if (request.url === '/admin/bots' && status === 200) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ bots: [] }))
      return
    }
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'unauthorized' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
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
      select: async (_message, _options, initialValue) => initialValue,
    },
    print: (text) => out.push(text),
    printError: (text) => errors.push(text),
  }
}

test('remote add checks the admin key and saves the remote', async () => {
  expect(await runRemoteAdd({ name: 'home', url: baseUrl, adminKey: ADMIN_KEY }, deps())).toBe(0)
  expect(readBook(bookPath).remotes).toEqual([{ name: 'home', url: baseUrl, adminKey: ADMIN_KEY }])
  expect(out).toEqual([`Added remote "home" (${new URL(baseUrl).host}).`])
})

test('remote add saves nothing when the service rejects the admin key', async () => {
  status = 401
  expect(await runRemoteAdd({ name: 'home', url: baseUrl, adminKey: ADMIN_KEY }, deps())).toBe(1)
  expect(existsSync(bookPath)).toBe(false)
  expect(errors).toHaveLength(1)
  expect(errors.join('\n')).not.toContain(ADMIN_KEY)
})

test('remote add rejects a bad url and a bad key without echoing the key', async () => {
  expect(await runRemoteAdd({ name: 'a', url: 'ftp://x', adminKey: ADMIN_KEY }, deps())).toBe(1)
  expect(await runRemoteAdd({ name: 'a', url: baseUrl, adminKey: 'not a key!' }, deps())).toBe(1)
  expect(errors).toEqual(['"ftp://x" isn\'t an http or https URL', "that isn't a valid admin key"])
  expect(existsSync(bookPath)).toBe(false)
})

test('remote add of an existing name fails off a terminal', async () => {
  const first = { name: 'home', url: baseUrl, adminKey: ADMIN_KEY }
  expect(await runRemoteAdd(first, deps())).toBe(0)
  expect(await runRemoteAdd({ ...first, url: 'http://other.example/' }, deps())).toBe(1)
  expect(errors).toEqual(['a remote is already named "home"'])
  expect(readBook(bookPath).remotes[0]?.url).toBe(baseUrl)
})

test('remote add of an existing name asks on a terminal and replaces on yes', async () => {
  const first = { name: 'home', url: 'http://other.example/', adminKey: ADMIN_KEY }
  writeBook(bookPath, { version: 1, remotes: [first], bots: [] })
  answer = false
  expect(await runRemoteAdd({ ...first, url: baseUrl }, deps(true))).toBe(1)
  expect(confirmed).toEqual(['Replace remote "home"?'])
  expect(readBook(bookPath).remotes[0]?.url).toBe('http://other.example/')
  answer = true
  expect(await runRemoteAdd({ ...first, url: baseUrl }, deps(true))).toBe(0)
  expect(readBook(bookPath).remotes[0]?.url).toBe(baseUrl)
})

test('remote list shows names and urls but no admin key', async () => {
  expect(await runRemoteList(deps())).toBe(0)
  expect(out).toEqual(['No remotes.'])
  out.length = 0
  await runRemoteAdd({ name: 'home', url: baseUrl, adminKey: ADMIN_KEY }, deps())
  out.length = 0
  expect(await runRemoteList(deps())).toBe(0)
  const text = out.join('\n')
  expect(text).toContain('NAME')
  expect(text).toContain('home')
  expect(text).toContain(baseUrl)
  expect(text).not.toContain(ADMIN_KEY)
})

test('remote remove drops the remote', async () => {
  await runRemoteAdd({ name: 'home', url: baseUrl, adminKey: ADMIN_KEY }, deps())
  out.length = 0
  expect(await runRemoteRemove({ name: 'home' }, deps())).toBe(0)
  expect(readBook(bookPath).remotes).toEqual([])
  expect(out).toEqual(['Removed remote "home".'])
  expect(readFileSync(bookPath, 'utf8')).not.toContain(ADMIN_KEY)
})

test('remote remove of an unknown name fails', async () => {
  expect(await runRemoteRemove({ name: 'nope' }, deps())).toBe(1)
  expect(errors).toEqual(['no remote "nope"'])
})
