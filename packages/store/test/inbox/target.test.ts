import { expect, test } from 'vite-plus/test'
import { EMPTY_INBOX, resolveBotTarget, saveBot } from '../../src/inbox/index.ts'
import type { Inbox, InboxBot } from '../../src/inbox/index.ts'

const ALPHA: InboxBot = { alias: 'alpha', url: 'http://a.example/', key: `jpk_${'a'.repeat(43)}` }
const BETA: InboxBot = { alias: 'beta', url: 'http://b.example/', key: `jpk_${'b'.repeat(43)}` }
const INBOX: Inbox = saveBot(saveBot(EMPTY_INBOX, ALPHA), BETA)

test('resolveBotTarget prefers the alias, then JAYPOST_BOT, then env mode, then the default', () => {
  const env = { JAYPOST_BOT: 'beta', JAYPOST_URL: 'http://x/' }
  expect(resolveBotTarget(env, INBOX, 'ALPHA')).toEqual({ kind: 'bot', bot: ALPHA })
  expect(resolveBotTarget(env, INBOX, undefined)).toEqual({ kind: 'bot', bot: BETA })
  expect(resolveBotTarget({ JAYPOST_URL: 'http://x/' }, INBOX, undefined)).toEqual({ kind: 'env' })
  expect(resolveBotTarget({ JAYPOST_TOKEN: 'x' }, INBOX, undefined)).toEqual({ kind: 'env' })
  expect(resolveBotTarget({}, INBOX, undefined)).toEqual({ kind: 'bot', bot: ALPHA })
})

test('resolveBotTarget with an alias ignores JAYPOST_URL and JAYPOST_TOKEN', () => {
  const env = { JAYPOST_URL: 'http://x/', JAYPOST_TOKEN: 'x' }
  expect(resolveBotTarget(env, INBOX, 'beta')).toEqual({ kind: 'bot', bot: BETA })
})

test('resolveBotTarget lists the known aliases for an unknown one', () => {
  expect(resolveBotTarget({}, INBOX, 'nope')).toEqual({
    kind: 'failed',
    message: 'no bot "nope" in your inbox; known: alpha, beta',
  })
  expect(resolveBotTarget({ JAYPOST_BOT: 'nope' }, EMPTY_INBOX, undefined)).toEqual({
    kind: 'failed',
    message: 'no bot "nope" in your inbox; it\'s empty',
  })
})

test('resolveBotTarget on an empty inbox with no env says how to add a bot', () => {
  expect(resolveBotTarget({}, EMPTY_INBOX, undefined)).toEqual({
    kind: 'failed',
    message: 'no bot to send to; run "jaypost service install" or "jaypost inbox join"',
  })
})
