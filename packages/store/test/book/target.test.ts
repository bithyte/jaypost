import { expect, test } from 'vite-plus/test'
import { EMPTY_BOOK, resolveBotTarget, saveBot } from '../../src/book/index.ts'
import type { Book, BookBot } from '../../src/book/index.ts'

const ALPHA: BookBot = { alias: 'alpha', url: 'http://a.example/', key: `jpk_${'a'.repeat(43)}` }
const BETA: BookBot = { alias: 'beta', url: 'http://b.example/', key: `jpk_${'b'.repeat(43)}` }
const BOOK: Book = saveBot(saveBot(EMPTY_BOOK, ALPHA), BETA)

test('resolveBotTarget prefers the alias, then JAYPOST_BOT, then env mode, then the default', () => {
  const env = { JAYPOST_BOT: 'beta', JAYPOST_URL: 'http://x/' }
  expect(resolveBotTarget(env, BOOK, 'ALPHA')).toEqual({ kind: 'bot', bot: ALPHA })
  expect(resolveBotTarget(env, BOOK, undefined)).toEqual({ kind: 'bot', bot: BETA })
  expect(resolveBotTarget({ JAYPOST_URL: 'http://x/' }, BOOK, undefined)).toEqual({ kind: 'env' })
  expect(resolveBotTarget({ JAYPOST_TOKEN: 'x' }, BOOK, undefined)).toEqual({ kind: 'env' })
  expect(resolveBotTarget({}, BOOK, undefined)).toEqual({ kind: 'bot', bot: ALPHA })
})

test('resolveBotTarget with an alias ignores JAYPOST_URL and JAYPOST_TOKEN', () => {
  const env = { JAYPOST_URL: 'http://x/', JAYPOST_TOKEN: 'x' }
  expect(resolveBotTarget(env, BOOK, 'beta')).toEqual({ kind: 'bot', bot: BETA })
})

test('resolveBotTarget lists the known aliases for an unknown one', () => {
  expect(resolveBotTarget({}, BOOK, 'nope')).toEqual({
    kind: 'failed',
    message: 'no bot "nope" in your contacts; known: alpha, beta',
  })
  expect(resolveBotTarget({ JAYPOST_BOT: 'nope' }, EMPTY_BOOK, undefined)).toEqual({
    kind: 'failed',
    message: 'no bot "nope" in your contacts; it\'s empty',
  })
})

test('resolveBotTarget on an empty book with no env says how to add a bot', () => {
  expect(resolveBotTarget({}, EMPTY_BOOK, undefined)).toEqual({
    kind: 'failed',
    message: 'no bot to send to; run "jaypost service install" or "jaypost join"',
  })
})
