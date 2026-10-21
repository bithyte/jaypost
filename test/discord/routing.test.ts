import { expect, test, vi } from 'vite-plus/test'
import { Pairing } from '../../src/pairing/index.ts'
import {
  AMBIGUOUS_REPLY,
  BUTTONS_ONLY_REPLY,
  NOT_OPEN_REPLY,
  NOT_TEXT_REPLY,
  PAIRED_REPLY,
  WRONG_CODE_REPLY,
  describeReplyRoute,
  formatCustomId,
  formatDismissId,
  handlePairingMessage,
  parseDismissId,
  routeReply,
  routeTap,
  toButtonRows,
} from '../../src/discord/index.ts'
import type { IncomingMessage } from '../../src/discord/index.ts'

const attempt = (pairing: Pairing) => (senderId: string, text: string) =>
  pairing.attempt(senderId, text)

test('formatCustomId format', () => expect(formatCustomId('abc', 1)).toBe('abc:1'))

test('custom ids stay under 100 characters for a uuid', () => {
  const id = crypto.randomUUID()
  expect(formatCustomId(id, 24).length).toBeLessThanOrEqual(100)
  expect(formatDismissId(id).length).toBeLessThanOrEqual(100)
})

test('seven options make rows of five and two', () => {
  const rows = toButtonRows('r', ['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  expect(rows.map((row) => row.length)).toEqual([5, 2])
  expect(rows[1]).toEqual([
    { label: 'f', customId: 'r:5' },
    { label: 'g', customId: 'r:6' },
  ])
})

test('no options make no rows', () => {
  expect(toButtonRows('r', [])).toEqual([])
})

test('parseDismissId reads a dismiss id back', () => {
  expect(parseDismissId(formatDismissId('n1'))).toBe('n1')
  expect(parseDismissId('n1:0')).toBeUndefined()
  expect(parseDismissId('dismiss/a:1')).toBeUndefined()
})

test('non-owner tap ignored, tap not called', () => {
  const tap = vi.fn()
  expect(routeTap('7', 'abc:0', '42', tap)).toBe('ignored')
  expect(tap).not.toHaveBeenCalled()
})

test('owner tap routed', () => {
  const tap = vi.fn(() => 'accepted' as const)
  expect(routeTap('42', 'abc:1', '42', tap)).toBe('accepted')
  expect(tap).toHaveBeenCalledWith('abc', 1)
})

test('owner tap on expired request', () => {
  expect(routeTap('42', 'abc:1', '42', () => 'expired')).toBe('expired')
})

test.each(['', 'abc', 'abc:', 'abc:x', ':1', 'abc:1:2', 'abc:-1'])(
  'malformed custom id %s is expired',
  (customId) => {
    const tap = vi.fn()
    expect(routeTap('42', customId, '42', tap)).toBe('expired')
    expect(tap).not.toHaveBeenCalled()
  },
)

test('tap with no owner is ignored', () => {
  const tap = vi.fn()
  expect(routeTap('1', 'abc:0', undefined, tap)).toBe('ignored')
  expect(tap).not.toHaveBeenCalled()
})

test('tap from nobody is ignored', () => {
  const tap = vi.fn()
  expect(routeTap(undefined, 'abc:0', '42', tap)).toBe('ignored')
  expect(tap).not.toHaveBeenCalled()
})

test('a dismiss id is never an approval tap', () => {
  expect(routeTap('1', formatDismissId('n'), '1', vi.fn())).toBe('expired')
})

const BOT_ID = '100'
const QUESTION = { messageId: '5', fromId: BOT_ID }
const OTHER_BOT_MESSAGE = { messageId: '7', fromId: BOT_ID }
const messageOf = (overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: '50',
  channelId: 'dm',
  fromId: '9',
  fromBot: false,
  isDirect: true,
  text: 'feature/x',
  replyTo: undefined,
  ...overrides,
})
const questionsOf = (...entries: [string, boolean][]) =>
  new Map(entries.map(([messageId, allowText]) => [messageId, { id: `q${messageId}`, allowText }]))
const accepting = () => vi.fn((_id: string, _text: string) => 'accepted' as const)
const expiring = () => vi.fn((_id: string, _text: string) => 'expired' as const)

test('routeReply ignores a stranger', () => {
  const reply = accepting()
  const route = routeReply(messageOf({ fromId: '8' }), '9', BOT_ID, questionsOf(['5', true]), reply)
  expect(route).toBe('ignored')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply ignores a server channel', () => {
  const reply = accepting()
  const route = routeReply(
    messageOf({ isDirect: false }),
    '9',
    BOT_ID,
    questionsOf(['5', true]),
    reply,
  )
  expect(route).toBe('ignored')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply ignores a bot sender', () => {
  const reply = accepting()
  const route = routeReply(
    messageOf({ fromBot: true }),
    '9',
    BOT_ID,
    questionsOf(['5', true]),
    reply,
  )
  expect(route).toBe('ignored')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply ignores everyone when nobody is paired', () => {
  const reply = accepting()
  const route = routeReply(messageOf(), undefined, BOT_ID, questionsOf(['5', true]), reply)
  expect(route).toBe('ignored')
  expect(reply).not.toHaveBeenCalled()
})

test('a reply is matched by message id', () => {
  const reply = accepting()
  const questions = new Map([['900', { id: 'q', allowText: true }]])
  const message = messageOf({
    fromId: '1',
    text: ' yes ',
    replyTo: { messageId: '900', fromId: BOT_ID },
  })
  expect(routeReply(message, '1', BOT_ID, questions, reply)).toBe('accepted')
  expect(reply).toHaveBeenCalledExactlyOnceWith('q', 'yes')
})

test('routeReply keeps inner newlines', () => {
  const reply = accepting()
  const message = messageOf({ text: 'line 1\nline 2', replyTo: QUESTION })
  expect(routeReply(message, '9', BOT_ID, questionsOf(['5', true]), reply)).toBe('accepted')
  expect(reply).toHaveBeenCalledExactlyOnceWith('q5', 'line 1\nline 2')
})

test('routeReply counts a reply starting with a slash', () => {
  const reply = accepting()
  const message = messageOf({ text: '/var/www', replyTo: QUESTION })
  expect(routeReply(message, '9', BOT_ID, questionsOf(['5', true]), reply)).toBe('accepted')
  expect(reply).toHaveBeenCalledExactlyOnceWith('q5', '/var/www')
})

test('routeReply refuses a reply to a buttons-only question', () => {
  const reply = accepting()
  const message = messageOf({ replyTo: QUESTION })
  expect(routeReply(message, '9', BOT_ID, questionsOf(['5', false]), reply)).toBe('buttonsOnly')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply reports expired when the question is settled but not finalized', () => {
  const reply = expiring()
  const message = messageOf({ replyTo: QUESTION })
  expect(routeReply(message, '9', BOT_ID, questionsOf(['5', true]), reply)).toBe('expired')
  expect(reply).toHaveBeenCalledTimes(1)
})

test('routeReply says not open for a reply to another bot message', () => {
  const reply = accepting()
  const message = messageOf({ replyTo: OTHER_BOT_MESSAGE })
  expect(routeReply(message, '9', BOT_ID, questionsOf(['5', true]), reply)).toBe('notOpen')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply treats a reply to the owner own message as a non-reply', () => {
  const reply = accepting()
  const message = messageOf({ replyTo: { messageId: '7', fromId: '9' } })
  expect(routeReply(message, '9', BOT_ID, questionsOf(['5', true]), reply)).toBe('accepted')
  expect(reply).toHaveBeenCalledExactlyOnceWith('q5', 'feature/x')
})

test('routeReply settles the one text question among buttons-only ones', () => {
  const reply = accepting()
  const questions = questionsOf(['5', false], ['6', true])
  expect(routeReply(messageOf(), '9', BOT_ID, questions, reply)).toBe('accepted')
  expect(reply).toHaveBeenCalledExactlyOnceWith('q6', 'feature/x')
})

test('routeReply is ambiguous with several text questions', () => {
  const reply = accepting()
  const questions = questionsOf(['5', true], ['6', true])
  expect(routeReply(messageOf(), '9', BOT_ID, questions, reply)).toBe('ambiguous')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply ignores a non-reply when no text question is open', () => {
  const reply = accepting()
  expect(routeReply(messageOf(), '9', BOT_ID, questionsOf(['5', false]), reply)).toBe('ignored')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply ignores a non-reply starting with a slash', () => {
  const reply = accepting()
  const message = messageOf({ text: '/start' })
  expect(routeReply(message, '9', BOT_ID, questionsOf(['5', true]), reply)).toBe('ignored')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply ignores a non-reply when the only text question is settled', () => {
  const reply = expiring()
  expect(routeReply(messageOf(), '9', BOT_ID, questionsOf(['5', true]), reply)).toBe('ignored')
  expect(reply).toHaveBeenCalledTimes(1)
})

test('routeReply says not text for a non-text reply to an open text question', () => {
  const reply = accepting()
  const message = messageOf({ text: undefined, replyTo: QUESTION })
  expect(routeReply(message, '9', BOT_ID, questionsOf(['5', true]), reply)).toBe('notText')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply ignores a non-text reply to a buttons-only question', () => {
  const reply = accepting()
  const message = messageOf({ text: undefined, replyTo: QUESTION })
  expect(routeReply(message, '9', BOT_ID, questionsOf(['5', false]), reply)).toBe('ignored')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply ignores a non-text reply to another bot message', () => {
  const reply = accepting()
  const message = messageOf({ text: undefined, replyTo: OTHER_BOT_MESSAGE })
  expect(routeReply(message, '9', BOT_ID, questionsOf(['5', false]), reply)).toBe('ignored')
  expect(reply).not.toHaveBeenCalled()
})

test('routeReply ignores a non-text non-reply', () => {
  const reply = accepting()
  const message = messageOf({ text: undefined })
  expect(routeReply(message, '9', BOT_ID, questionsOf(['5', true]), reply)).toBe('ignored')
  expect(reply).not.toHaveBeenCalled()
})

test('describeReplyRoute maps refusals to copy and silences the rest', () => {
  expect(describeReplyRoute('ignored')).toBeUndefined()
  expect(describeReplyRoute('accepted')).toBeUndefined()
  expect(describeReplyRoute('buttonsOnly')).toBe(BUTTONS_ONLY_REPLY)
  expect(describeReplyRoute('notOpen')).toBe(NOT_OPEN_REPLY)
  expect(describeReplyRoute('expired')).toBe(NOT_OPEN_REPLY)
  expect(describeReplyRoute('ambiguous')).toBe(AMBIGUOUS_REPLY)
  expect(describeReplyRoute('notText')).toBe(NOT_TEXT_REPLY)
})

test('pairing: right code replies and calls onPaired', () => {
  const onPaired = vi.fn()
  const reply = handlePairingMessage(
    messageOf({ text: 'K7QM-4XPD' }),
    attempt(new Pairing('K7QM4XPD')),
    onPaired,
  )
  expect(reply).toBe(PAIRED_REPLY)
  expect(onPaired).toHaveBeenCalledWith('9')
})

test('pairing passes the trimmed text and pairs the sender', () => {
  const pair = vi.fn(() => 'paired' as const)
  const onPaired = vi.fn()
  const reply = handlePairingMessage(messageOf({ fromId: '1', text: '  CODE \n' }), pair, onPaired)
  expect(reply).toBe(PAIRED_REPLY)
  expect(pair).toHaveBeenCalledExactlyOnceWith('1', 'CODE')
  expect(onPaired).toHaveBeenCalledExactlyOnceWith('1')
})

test('pairing: wrong code gets the hint, onPaired not called', () => {
  const onPaired = vi.fn()
  const reply = handlePairingMessage(
    messageOf({ text: 'nope' }),
    attempt(new Pairing('K7QM4XPD')),
    onPaired,
  )
  expect(reply).toBe(WRONG_CODE_REPLY)
  expect(onPaired).not.toHaveBeenCalled()
})

test('pairing ignores messages outside DMs', () => {
  const pair = vi.fn(() => 'paired' as const)
  expect(handlePairingMessage(messageOf({ isDirect: false }), pair, vi.fn())).toBeUndefined()
  expect(pair).not.toHaveBeenCalled()
})

test('pairing ignores bots and empty messages', () => {
  const pair = vi.fn(() => 'paired' as const)
  expect(handlePairingMessage(messageOf({ fromBot: true }), pair, vi.fn())).toBeUndefined()
  expect(handlePairingMessage(messageOf({ text: undefined }), pair, vi.fn())).toBeUndefined()
  expect(pair).not.toHaveBeenCalled()
})

test('pairing: blocked sender gets no reply', () => {
  const pairing = new Pairing('K7QM4XPD', 1)
  const message = messageOf({ text: 'bad' })
  handlePairingMessage(message, attempt(pairing), vi.fn())
  expect(handlePairingMessage(message, attempt(pairing), vi.fn())).toBeUndefined()
})

test('after pairing, strangers and old codes get no reply', () => {
  const pairing = new Pairing('K7QM4XPD')
  pairing.attempt('1', 'K7QM4XPD')
  const onPaired = vi.fn()
  expect(
    handlePairingMessage(messageOf({ fromId: '2', text: 'K7QM4XPD' }), attempt(pairing), onPaired),
  ).toBeUndefined()
  expect(onPaired).not.toHaveBeenCalled()
})
