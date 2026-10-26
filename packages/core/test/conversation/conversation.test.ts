import { expect, test, vi } from 'vite-plus/test'
import type { Mock } from 'vite-plus/test'
import {
  AMBIGUOUS_REPLY,
  BUTTONS_ONLY_REPLY,
  EXPIRED_REPLY,
  NOT_OPEN_REPLY,
  NOT_TEXT_REPLY,
  OwnerConversation,
  PAIRED_REPLY,
  WRONG_CODE_REPLY,
  formatChoicePayload,
  formatDismissPayload,
} from '../../src/conversation/index.ts'
import type {
  ConversationHandlers,
  ConversationMessage,
  ConversationTap,
} from '../../src/conversation/index.ts'
import { Pairing } from '../../src/pairing/index.ts'
import { receiveReplyTo } from './helpers.ts'

const OWNER = '9'
const QUESTION = { key: '5', fromSelf: true }
const UNTRACKED_BOT_MESSAGE = { key: '7', fromSelf: true }
const messageOf = (overrides: Partial<ConversationMessage> = {}): ConversationMessage => ({
  senderId: OWNER,
  fromBot: false,
  isDirect: true,
  text: 'feature/x',
  replyTo: undefined,
  ...overrides,
})
const tapOf = (
  payload: string | undefined,
  overrides: Partial<ConversationTap> = {},
): ConversationTap => ({
  senderId: OWNER,
  isDirect: true,
  payload,
  ...overrides,
})
function conversationWith(...entries: [string, boolean][]): OwnerConversation {
  const conversation = new OwnerConversation()
  for (const [key, allowText] of entries) {
    conversation.track(key, `q${key}`, allowText, OWNER)
  }
  return conversation
}
const PAIRED_IS_OWNER = (id: string): boolean => id === OWNER
type SpiedHandlers = {
  answer: Mock<ConversationHandlers['answer']>
  reply: Mock<ConversationHandlers['reply']>
  dismiss: Mock<ConversationHandlers['dismiss']>
} & Omit<ConversationHandlers, 'answer' | 'reply' | 'dismiss'>
function handlersOf(
  overrides: Partial<Omit<ConversationHandlers, 'answer' | 'reply' | 'dismiss'>> &
    Partial<Pick<SpiedHandlers, 'answer' | 'reply' | 'dismiss'>> = {},
): SpiedHandlers {
  return {
    answer: vi.fn(() => 'accepted' as const),
    reply: vi.fn(() => 'accepted' as const),
    dismiss: vi.fn(() => true),
    ...overrides,
    isPaired: overrides.isPaired ?? PAIRED_IS_OWNER,
  }
}
const expiring = () => vi.fn(() => 'expired' as const)
const attempt = (pairing: Pairing) => (senderId: string, text: string) =>
  pairing.attempt(senderId, text)

const IGNORED = { kind: 'ignored' }
const ANSWERED = { kind: 'answered' }
const refused = (text: string) => ({ kind: 'refused', text })

type Row = {
  name: string
  entries: [string, boolean][]
  message?: Partial<ConversationMessage>
  expire?: boolean
  outcome: object
  calls: unknown[][]
}
const ROWS: Row[] = [
  {
    name: 'receive ignores a stranger',
    entries: [['5', true]],
    message: { senderId: '8' },
    outcome: IGNORED,
    calls: [],
  },
  {
    name: 'receive ignores a message outside a dm',
    entries: [['5', true]],
    message: { isDirect: false },
    outcome: IGNORED,
    calls: [],
  },
  {
    name: 'receive ignores a bot sender',
    entries: [['5', true]],
    message: { fromBot: true },
    outcome: IGNORED,
    calls: [],
  },
  {
    name: 'receive ignores a message without a sender',
    entries: [['5', true]],
    message: { senderId: undefined },
    outcome: IGNORED,
    calls: [],
  },
  {
    name: 'a reply is matched by key and trimmed',
    entries: [['900', true]],
    message: { text: ' yes ', replyTo: { key: '900', fromSelf: true } },
    outcome: ANSWERED,
    calls: [['q900', 'yes']],
  },
  {
    name: 'receive keeps inner newlines',
    entries: [['5', true]],
    message: { text: 'line 1\nline 2', replyTo: QUESTION },
    outcome: ANSWERED,
    calls: [['q5', 'line 1\nline 2']],
  },
  {
    name: 'receive counts a reply starting with a slash',
    entries: [['5', true]],
    message: { text: '/var/www', replyTo: QUESTION },
    outcome: ANSWERED,
    calls: [['q5', '/var/www']],
  },
  {
    name: 'receive refuses a reply to a buttons-only question',
    entries: [['5', false]],
    message: { replyTo: QUESTION },
    outcome: refused(BUTTONS_ONLY_REPLY),
    calls: [],
  },
  {
    name: 'receive says not open when the question is settled but not finalized',
    entries: [['5', true]],
    message: { replyTo: QUESTION },
    expire: true,
    outcome: refused(NOT_OPEN_REPLY),
    calls: [['q5', 'feature/x']],
  },
  {
    name: 'receive says not open for a reply to another bot message',
    entries: [['5', true]],
    message: { replyTo: UNTRACKED_BOT_MESSAGE },
    outcome: refused(NOT_OPEN_REPLY),
    calls: [],
  },
  {
    name: "receive treats a reply to the owner's own message as a non-reply",
    entries: [['5', true]],
    message: { replyTo: { key: '7', fromSelf: false } },
    outcome: ANSWERED,
    calls: [['q5', 'feature/x']],
  },
  {
    name: 'receive settles the one text question among buttons-only ones',
    entries: [
      ['5', false],
      ['6', true],
    ],
    outcome: ANSWERED,
    calls: [['q6', 'feature/x']],
  },
  {
    name: 'receive is ambiguous with several text questions',
    entries: [
      ['5', true],
      ['6', true],
    ],
    outcome: refused(AMBIGUOUS_REPLY),
    calls: [],
  },
  {
    name: 'receive ignores a non-reply when no text question is open',
    entries: [['5', false]],
    outcome: IGNORED,
    calls: [],
  },
  {
    name: 'receive ignores a non-reply starting with a slash',
    entries: [['5', true]],
    message: { text: '/start' },
    outcome: IGNORED,
    calls: [],
  },
  {
    name: 'receive ignores a non-reply when the only text question is settled',
    entries: [['5', true]],
    expire: true,
    outcome: IGNORED,
    calls: [['q5', 'feature/x']],
  },
  {
    name: 'receive says not text for a non-text reply to an open text question',
    entries: [['5', true]],
    message: { text: undefined, replyTo: QUESTION },
    outcome: refused(NOT_TEXT_REPLY),
    calls: [],
  },
  {
    name: 'receive ignores a non-text reply to a buttons-only question',
    entries: [['5', false]],
    message: { text: undefined, replyTo: QUESTION },
    outcome: IGNORED,
    calls: [],
  },
  {
    name: 'receive ignores a non-text reply to another bot message',
    entries: [['5', false]],
    message: { text: undefined, replyTo: UNTRACKED_BOT_MESSAGE },
    outcome: IGNORED,
    calls: [],
  },
  {
    name: 'receive ignores a non-text non-reply',
    entries: [['5', true]],
    message: { text: undefined },
    outcome: IGNORED,
    calls: [],
  },
]

for (const row of ROWS) {
  test(row.name, () => {
    const reply = row.expire === true ? expiring() : vi.fn(() => 'accepted' as const)
    const conversation = conversationWith(...row.entries)
    expect(conversation.receive(messageOf(row.message), handlersOf({ reply }))).toEqual(row.outcome)
    expect(reply.mock.calls).toEqual(row.calls)
  })
}

test('receive ignores everyone when nobody is paired', () => {
  const conversation = new OwnerConversation()
  conversation.track('5', 'q5', true)
  const handlers = handlersOf({ isPaired: () => false })
  expect(conversation.receive(messageOf(), handlers)).toEqual(IGNORED)
  expect(handlers.reply).not.toHaveBeenCalled()
})

test('the refusal copy is pinned', () => {
  expect(BUTTONS_ONLY_REPLY).toBe('Tap one of the buttons to answer this question.')
  expect(NOT_OPEN_REPLY).toBe("That message isn't waiting for an answer.")
  expect(AMBIGUOUS_REPLY).toBe("Several questions are open; reply to the one you're answering.")
  expect(NOT_TEXT_REPLY).toBe('Only text replies count as an answer.')
})

test('the right code pairs the sender', () => {
  const conversation = new OwnerConversation()
  const pair = attempt(new Pairing('K7QM4XPD'))
  expect(
    conversation.receive(
      messageOf({ text: 'K7QM-4XPD' }),
      handlersOf({ pair, isPaired: () => false }),
    ),
  ).toEqual({
    kind: 'paired',
    senderId: '9',
    text: PAIRED_REPLY,
  })
  expect(conversation.isPaired('9', true, handlersOf({ isPaired: () => false }))).toBe(false)
})

test.each(['/start K7QM-4XPD', '/start@my_bot k7qm4xpd'])(
  'receive strips /start and /start@bot before pairing: %s',
  (text) => {
    const conversation = new OwnerConversation()
    const pair = attempt(new Pairing('K7QM4XPD'))
    expect(conversation.receive(messageOf({ text }), handlersOf({ pair }))).toMatchObject({
      kind: 'paired',
    })
  },
)

test('pairing gets the trimmed text', () => {
  const conversation = new OwnerConversation()
  const pair = vi.fn(() => 'paired' as const)
  const outcome = conversation.receive(
    messageOf({ senderId: '1', text: '  CODE \n' }),
    handlersOf({ pair }),
  )
  expect(pair.mock.calls).toEqual([['1', 'CODE']])
  expect(outcome).toMatchObject({ kind: 'paired', senderId: '1' })
})

test('the /start strip comes after the trim', () => {
  const conversation = new OwnerConversation()
  const pair = vi.fn(() => 'notPairing' as const)
  const outcome = conversation.receive(
    messageOf({ senderId: '8', text: '/start K7QM4XPD' }),
    handlersOf({ pair }),
  )
  expect(pair.mock.calls).toEqual([['8', ' K7QM4XPD']])
  expect(outcome).toEqual(IGNORED)
})

test('a wrong code gets the hint', () => {
  const conversation = new OwnerConversation()
  const pair = attempt(new Pairing('K7QM4XPD'))
  expect(conversation.receive(messageOf({ text: 'nope' }), handlersOf({ pair }))).toEqual({
    kind: 'wrongCode',
    text: WRONG_CODE_REPLY,
  })
})

test('a blocked sender gets no reply', () => {
  const conversation = new OwnerConversation()
  const pair = attempt(new Pairing('K7QM4XPD', 1))
  expect(conversation.receive(messageOf({ text: 'bad' }), handlersOf({ pair })).kind).toBe(
    'wrongCode',
  )
  expect(conversation.receive(messageOf({ text: 'bad' }), handlersOf({ pair }))).toEqual(IGNORED)
})

test('after pairing, strangers and old codes get no reply', () => {
  const conversation = new OwnerConversation()
  const pairing = new Pairing('K7QM4XPD')
  pairing.attempt('1', 'K7QM4XPD')
  const outcome = conversation.receive(
    messageOf({ senderId: '2', text: 'K7QM4XPD' }),
    handlersOf({ pair: attempt(pairing) }),
  )
  expect(outcome).toEqual(IGNORED)
})

test('pairing ignores messages outside dms, bots, no text and no sender', () => {
  const pair = vi.fn(() => 'paired' as const)
  for (const overrides of [
    { isDirect: false },
    { fromBot: true },
    { text: undefined },
    { senderId: undefined },
  ]) {
    const conversation = new OwnerConversation()
    expect(conversation.receive(messageOf(overrides), handlersOf({ pair }))).toEqual(IGNORED)
  }
  expect(pair).not.toHaveBeenCalled()
})

test('a message is not a pairing attempt when pairing is off', () => {
  const conversation = new OwnerConversation()
  expect(
    conversation.receive(messageOf({ senderId: '5', text: 'ABCDEFGH' }), handlersOf()),
  ).toEqual(IGNORED)
})

test('an owner message routing ignores still reaches pairing', () => {
  const conversation = new OwnerConversation()
  const pair = vi.fn(() => 'notPairing' as const)
  expect(conversation.receive(messageOf(), handlersOf({ pair }))).toEqual(IGNORED)
  expect(pair.mock.calls).toEqual([['9', 'feature/x']])
})

test('a refused reply never reaches pairing', () => {
  const conversation = conversationWith(['5', false])
  const pair = vi.fn(() => 'paired' as const)
  expect(conversation.receive(messageOf({ replyTo: QUESTION }), handlersOf({ pair })).kind).toBe(
    'refused',
  )
  expect(pair).not.toHaveBeenCalled()
})

test('the pairing copy is pinned', () => {
  expect(PAIRED_REPLY).toBe('Paired. Approval requests will appear here.')
  expect(WRONG_CODE_REPLY).toBe("That pairing code didn't match. Check it and try again.")
})

test("the owner's tap answers and names the sender, so the bot can check the recipient", () => {
  const handlers = handlersOf()
  expect(new OwnerConversation().tap(tapOf('abc:1'), handlers)).toEqual(ANSWERED)
  expect(handlers.answer.mock.calls).toEqual([['abc', 1, OWNER]])
})

test('a tap on a settled request is expired', () => {
  const handlers = handlersOf({ answer: expiring() })
  expect(new OwnerConversation().tap(tapOf('abc:1'), handlers)).toEqual({
    kind: 'expired',
    text: EXPIRED_REPLY,
  })
})

test('a tap from someone else is ignored', () => {
  const handlers = handlersOf()
  const conversation = conversationWith(['5', false])
  expect(conversation.tap(tapOf('q5:0', { senderId: '7' }), handlers)).toEqual(IGNORED)
  expect(handlers.answer).not.toHaveBeenCalled()
})

test('a dismiss while unpaired is ignored', () => {
  const handlers = handlersOf({ isPaired: () => false })
  expect(new OwnerConversation().tap(tapOf('dismiss/n1'), handlers)).toEqual(IGNORED)
  expect(handlers.dismiss).not.toHaveBeenCalled()
})

test('a tap without a sender is ignored', () => {
  expect(
    new OwnerConversation().tap(tapOf('abc:0', { senderId: undefined }), handlersOf()),
  ).toEqual(IGNORED)
})

test('taps outside a dm are ignored', () => {
  const handlers = handlersOf()
  const conversation = new OwnerConversation()
  expect(conversation.tap(tapOf('abc:0', { isDirect: false }), handlers)).toEqual(IGNORED)
  expect(conversation.tap(tapOf('dismiss/n1', { isDirect: false }), handlers)).toEqual(IGNORED)
  expect(handlers.answer).not.toHaveBeenCalled()
  expect(handlers.dismiss).not.toHaveBeenCalled()
})

test.each([
  undefined,
  '',
  'abc',
  'abc:',
  'abc:x',
  ':1',
  'abc:1:2',
  'abc:-1',
  'a/b:1',
  'dismiss/a:1',
])('malformed payload %s is expired', (payload) => {
  const handlers = handlersOf()
  expect(new OwnerConversation().tap(tapOf(payload), handlers)).toEqual({
    kind: 'expired',
    text: EXPIRED_REPLY,
  })
  expect(handlers.answer).not.toHaveBeenCalled()
  expect(handlers.dismiss).not.toHaveBeenCalled()
})

test("the owner's dismiss calls dismiss", () => {
  const handlers = handlersOf()
  expect(new OwnerConversation().tap(tapOf('dismiss/n1'), handlers)).toEqual({
    kind: 'dismissed',
  })
  expect(handlers.dismiss.mock.calls).toEqual([['n1']])
  expect(handlers.answer).not.toHaveBeenCalled()
})

test('a dismiss for an unknown id is still dismissed', () => {
  const handlers = handlersOf({ dismiss: vi.fn(() => false) })
  expect(new OwnerConversation().tap(tapOf('dismiss/gone'), handlers)).toEqual({
    kind: 'dismissed',
  })
})

test('a dismiss from someone else is ignored', () => {
  const handlers = handlersOf()
  expect(new OwnerConversation().tap(tapOf('dismiss/n1', { senderId: '7' }), handlers)).toEqual(
    IGNORED,
  )
  expect(handlers.dismiss).not.toHaveBeenCalled()
})

test('buttons sent before the upgrade still work', () => {
  const id = crypto.randomUUID()
  const handlers = handlersOf()
  const conversation = new OwnerConversation()
  expect(conversation.tap(tapOf(`${id}:3`), handlers)).toEqual(ANSWERED)
  expect(conversation.tap(tapOf(`dismiss/${id}`), handlers)).toEqual({ kind: 'dismissed' })
  expect(handlers.answer.mock.calls).toEqual([[id, 3, OWNER]])
  expect(handlers.dismiss.mock.calls).toEqual([[id]])
})

test('tap reads what the payload helpers write', () => {
  const handlers = handlersOf()
  const conversation = new OwnerConversation()
  conversation.tap(tapOf(formatChoicePayload('r1', 2)), handlers)
  conversation.tap(tapOf(formatDismissPayload('n1')), handlers)
  expect(handlers.answer.mock.calls).toEqual([['r1', 2, OWNER]])
  expect(handlers.dismiss.mock.calls).toEqual([['n1']])
})

test('isPaired only counts a paired sender in a dm', () => {
  const conversation = new OwnerConversation()
  const handlers = handlersOf()
  expect(conversation.isPaired('9', true, handlers)).toBe(true)
  expect(conversation.isPaired('9', false, handlers)).toBe(false)
  expect(conversation.isPaired('8', true, handlers)).toBe(false)
  expect(conversation.isPaired(undefined, true, handlers)).toBe(false)
})

test('forget closes a question', () => {
  const conversation = conversationWith(['5', true])
  conversation.forget('5')
  expect(receiveReplyTo(conversation, '5', OWNER)).toMatchObject({
    outcome: refused(NOT_OPEN_REPLY),
  })
  expect(conversation.receive(messageOf(), handlersOf())).toEqual(IGNORED)
})

test('forget of an unknown key does nothing', () => {
  expect(() => new OwnerConversation().forget('nope')).not.toThrow()
})

test('tracking a key again replaces the question', () => {
  const conversation = new OwnerConversation()
  conversation.track('5', 'a', false, OWNER)
  conversation.track('5', 'b', true, OWNER)
  const handlers = handlersOf()
  expect(conversation.receive(messageOf({ replyTo: QUESTION }), handlers)).toEqual(ANSWERED)
  expect(handlers.reply.mock.calls).toEqual([['b', 'feature/x']])
})

test('helper receiveReplyTo', () => {
  const text = new OwnerConversation()
  text.track('5', 'q5', true, OWNER)
  const answered = receiveReplyTo(text, '5', OWNER)
  expect(answered.outcome).toEqual(ANSWERED)
  expect(answered.reply.mock.calls).toEqual([['q5', 'x']])
  const buttons = new OwnerConversation()
  buttons.track('5', 'q5', false, OWNER)
  expect(receiveReplyTo(buttons, '5', OWNER).outcome).toEqual(refused(BUTTONS_ONLY_REPLY))
  expect(receiveReplyTo(new OwnerConversation(), '5', OWNER).outcome).toEqual(
    refused(NOT_OPEN_REPLY),
  )
})

function voterConversation(): OwnerConversation {
  const conversation = new OwnerConversation()
  conversation.track('k', 'r1', false, '222')
  return conversation
}

test("a voter's tap on their own question answers", () => {
  const handlers = handlersOf()
  const tap = tapOf(formatChoicePayload('r1', 0), { senderId: '222' })
  expect(voterConversation().tap(tap, handlers)).toEqual(ANSWERED)
  expect(handlers.answer).toHaveBeenCalledWith('r1', 0, '222')
})

test("the owner's tap on a voter's question is ignored", () => {
  const handlers = handlersOf()
  expect(voterConversation().tap(tapOf(formatChoicePayload('r1', 0)), handlers)).toEqual(IGNORED)
  expect(handlers.answer).not.toHaveBeenCalled()
})

test("a stranger's tap on a voter's question is ignored", () => {
  const handlers = handlersOf()
  const tap = tapOf(formatChoicePayload('r1', 0), { senderId: '333' })
  expect(voterConversation().tap(tap, handlers)).toEqual(IGNORED)
  expect(handlers.answer).not.toHaveBeenCalled()
})

test("a voter's tap outside a dm is ignored", () => {
  const handlers = handlersOf()
  const tap = tapOf(formatChoicePayload('r1', 0), { senderId: '222', isDirect: false })
  expect(voterConversation().tap(tap, handlers)).toEqual(IGNORED)
  expect(handlers.answer).not.toHaveBeenCalled()
})

test('a tap on an unknown request id is expired for anyone in a dm', () => {
  const handlers = handlersOf()
  const tap = tapOf(formatChoicePayload('r9', 0), { senderId: '333' })
  expect(voterConversation().tap(tap, handlers)).toEqual({ kind: 'expired', text: EXPIRED_REPLY })
  expect(handlers.answer).not.toHaveBeenCalled()
})

test("a voter can't dismiss", () => {
  const handlers = handlersOf()
  const tap = tapOf(formatDismissPayload('r1'), { senderId: '222' })
  expect(voterConversation().tap(tap, handlers)).toEqual(IGNORED)
  expect(handlers.dismiss).not.toHaveBeenCalled()
})

const TWO_PAIRED = (id: string): boolean => id === 'A' || id === 'B'

test('a plain reply only answers a text question sent to the sender', () => {
  const conversation = new OwnerConversation()
  const handlers = handlersOf({ isPaired: TWO_PAIRED })
  conversation.track('m1', 'q1', true, 'B')
  const outcome = conversation.receive(messageOf({ senderId: 'A', text: 'yes' }), handlers)
  expect(outcome).toEqual(IGNORED)
  expect(handlers.reply).not.toHaveBeenCalled()
})

test("a plain reply still answers the sender's own text question beside another person's", () => {
  const conversation = new OwnerConversation()
  const handlers = handlersOf({ isPaired: TWO_PAIRED })
  conversation.track('m1', 'q1', true, 'B')
  conversation.track('m2', 'q2', true, 'A')
  expect(conversation.receive(messageOf({ senderId: 'A', text: 'yes' }), handlers)).toEqual(
    ANSWERED,
  )
  expect(handlers.reply.mock.calls).toEqual([['q2', 'yes']])
})

test("a reply to another person's question is not open for the sender", () => {
  const conversation = new OwnerConversation()
  const handlers = handlersOf({ isPaired: TWO_PAIRED })
  conversation.track('m1', 'q1', true, 'B')
  const message = messageOf({
    senderId: 'A',
    text: 'yes',
    replyTo: { key: 'm1', fromSelf: true },
  })
  expect(conversation.receive(message, handlers)).toEqual(refused(NOT_OPEN_REPLY))
  expect(handlers.reply).not.toHaveBeenCalled()
})

test('a choice counts only from the question recipient, paired or not', () => {
  const conversation = new OwnerConversation()
  const handlers = handlersOf({ isPaired: TWO_PAIRED })
  conversation.track('m1', 'q1', false, 'V')
  expect(conversation.tap(tapOf('q1:0', { senderId: 'A' }), handlers)).toEqual(IGNORED)
  expect(conversation.tap(tapOf('q1:0', { senderId: 'V' }), handlers)).toEqual(ANSWERED)
})

test('pairing reports the sender and does not store an owner', () => {
  const conversation = new OwnerConversation()
  const pair = vi.fn(() => 'paired' as const)
  const handlers = handlersOf({ isPaired: () => false, pair })
  expect(
    conversation.receive(messageOf({ senderId: 'C', text: '/start K7QM4XPD' }), handlers),
  ).toEqual({
    kind: 'paired',
    senderId: 'C',
    text: PAIRED_REPLY,
  })
  expect(conversation.isPaired('C', true, handlers)).toBe(false)
})
