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
import { pairOwner, receiveReplyTo } from './helpers.ts'

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
  const conversation = new OwnerConversation(OWNER)
  for (const [key, allowText] of entries) {
    conversation.track(key, `q${key}`, allowText)
  }
  return conversation
}
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
  const conversation = new OwnerConversation(undefined)
  conversation.track('5', 'q5', true)
  const handlers = handlersOf()
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
  const conversation = new OwnerConversation(undefined)
  const pair = attempt(new Pairing('K7QM4XPD'))
  expect(conversation.receive(messageOf({ text: 'K7QM-4XPD' }), handlersOf({ pair }))).toEqual({
    kind: 'paired',
    ownerId: '9',
    text: PAIRED_REPLY,
  })
  expect(conversation.ownerId).toBe('9')
})

test.each(['/start K7QM-4XPD', '/start@my_bot k7qm4xpd'])(
  'receive strips /start and /start@bot before pairing: %s',
  (text) => {
    const conversation = new OwnerConversation(undefined)
    const pair = attempt(new Pairing('K7QM4XPD'))
    expect(conversation.receive(messageOf({ text }), handlersOf({ pair }))).toMatchObject({
      kind: 'paired',
    })
  },
)

test('pairing gets the trimmed text', () => {
  const conversation = new OwnerConversation(undefined)
  const pair = vi.fn(() => 'paired' as const)
  const outcome = conversation.receive(
    messageOf({ senderId: '1', text: '  CODE \n' }),
    handlersOf({ pair }),
  )
  expect(pair.mock.calls).toEqual([['1', 'CODE']])
  expect(outcome).toMatchObject({ kind: 'paired', ownerId: '1' })
})

test('the /start strip comes after the trim', () => {
  const conversation = new OwnerConversation(undefined)
  const pair = vi.fn(() => 'notPairing' as const)
  const outcome = conversation.receive(
    messageOf({ senderId: '8', text: '/start K7QM4XPD' }),
    handlersOf({ pair }),
  )
  expect(pair.mock.calls).toEqual([['8', ' K7QM4XPD']])
  expect(outcome).toEqual(IGNORED)
})

test('a wrong code gets the hint', () => {
  const conversation = new OwnerConversation(undefined)
  const pair = attempt(new Pairing('K7QM4XPD'))
  expect(conversation.receive(messageOf({ text: 'nope' }), handlersOf({ pair }))).toEqual({
    kind: 'wrongCode',
    text: WRONG_CODE_REPLY,
  })
  expect(conversation.ownerId).toBeUndefined()
})

test('a blocked sender gets no reply', () => {
  const conversation = new OwnerConversation(undefined)
  const pair = attempt(new Pairing('K7QM4XPD', 1))
  expect(conversation.receive(messageOf({ text: 'bad' }), handlersOf({ pair })).kind).toBe(
    'wrongCode',
  )
  expect(conversation.receive(messageOf({ text: 'bad' }), handlersOf({ pair }))).toEqual(IGNORED)
})

test('after pairing, strangers and old codes get no reply', () => {
  const conversation = new OwnerConversation(undefined)
  const pairing = new Pairing('K7QM4XPD')
  pairing.attempt('1', 'K7QM4XPD')
  const outcome = conversation.receive(
    messageOf({ senderId: '2', text: 'K7QM4XPD' }),
    handlersOf({ pair: attempt(pairing) }),
  )
  expect(outcome).toEqual(IGNORED)
  expect(conversation.ownerId).toBeUndefined()
})

test('pairing ignores messages outside dms, bots, no text and no sender', () => {
  const pair = vi.fn(() => 'paired' as const)
  for (const overrides of [
    { isDirect: false },
    { fromBot: true },
    { text: undefined },
    { senderId: undefined },
  ]) {
    const conversation = new OwnerConversation(undefined)
    expect(conversation.receive(messageOf(overrides), handlersOf({ pair }))).toEqual(IGNORED)
  }
  expect(pair).not.toHaveBeenCalled()
})

test('a message is not a pairing attempt when pairing is off', () => {
  const conversation = new OwnerConversation(undefined)
  expect(
    conversation.receive(messageOf({ senderId: '5', text: 'ABCDEFGH' }), handlersOf()),
  ).toEqual(IGNORED)
})

test('an owner message routing ignores still reaches pairing', () => {
  const conversation = new OwnerConversation(OWNER)
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

test('re-pairing moves open questions to the new owner', () => {
  const conversation = conversationWith(['5', true])
  expect(
    conversation.receive(
      messageOf({ senderId: '5', text: 'CODE' }),
      handlersOf({ pair: () => 'paired' }),
    ),
  ).toMatchObject({ kind: 'paired', ownerId: '5' })
  expect(
    conversation.receive(messageOf({ senderId: '5', replyTo: QUESTION }), handlersOf()),
  ).toEqual(ANSWERED)
  expect(
    conversation.receive(messageOf({ senderId: '9', replyTo: QUESTION }), handlersOf()),
  ).toEqual(IGNORED)
})

test('the pairing copy is pinned', () => {
  expect(PAIRED_REPLY).toBe('Paired. Approval requests will appear here.')
  expect(WRONG_CODE_REPLY).toBe(
    "This bot isn't paired. Check the service logs for the pairing code.",
  )
})

test("the owner's tap answers", () => {
  const handlers = handlersOf()
  expect(new OwnerConversation(OWNER).tap(tapOf('abc:1'), handlers)).toEqual(ANSWERED)
  expect(handlers.answer.mock.calls).toEqual([['abc', 1]])
})

test('a tap on a settled request is expired', () => {
  const handlers = handlersOf({ answer: expiring() })
  expect(new OwnerConversation(OWNER).tap(tapOf('abc:1'), handlers)).toEqual({
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

test('a tap while unpaired is ignored', () => {
  const conversation = new OwnerConversation(undefined)
  conversation.track('5', 'abc', false)
  expect(conversation.tap(tapOf('abc:0'), handlersOf())).toEqual(IGNORED)
})

test('a tap without a sender is ignored', () => {
  expect(
    new OwnerConversation(OWNER).tap(tapOf('abc:0', { senderId: undefined }), handlersOf()),
  ).toEqual(IGNORED)
})

test('taps outside a dm are ignored', () => {
  const handlers = handlersOf()
  const conversation = new OwnerConversation(OWNER)
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
  expect(new OwnerConversation(OWNER).tap(tapOf(payload), handlers)).toEqual({
    kind: 'expired',
    text: EXPIRED_REPLY,
  })
  expect(handlers.answer).not.toHaveBeenCalled()
  expect(handlers.dismiss).not.toHaveBeenCalled()
})

test("the owner's dismiss calls dismiss", () => {
  const handlers = handlersOf()
  expect(new OwnerConversation(OWNER).tap(tapOf('dismiss/n1'), handlers)).toEqual({
    kind: 'dismissed',
  })
  expect(handlers.dismiss.mock.calls).toEqual([['n1']])
  expect(handlers.answer).not.toHaveBeenCalled()
})

test('a dismiss for an unknown id is still dismissed', () => {
  const handlers = handlersOf({ dismiss: vi.fn(() => false) })
  expect(new OwnerConversation(OWNER).tap(tapOf('dismiss/gone'), handlers)).toEqual({
    kind: 'dismissed',
  })
})

test('a dismiss from someone else is ignored', () => {
  const handlers = handlersOf()
  expect(
    new OwnerConversation(OWNER).tap(tapOf('dismiss/n1', { senderId: '7' }), handlers),
  ).toEqual(IGNORED)
  expect(handlers.dismiss).not.toHaveBeenCalled()
})

test('buttons sent before the upgrade still work', () => {
  const id = crypto.randomUUID()
  const handlers = handlersOf()
  const conversation = new OwnerConversation(OWNER)
  expect(conversation.tap(tapOf(`${id}:3`), handlers)).toEqual(ANSWERED)
  expect(conversation.tap(tapOf(`dismiss/${id}`), handlers)).toEqual({ kind: 'dismissed' })
  expect(handlers.answer.mock.calls).toEqual([[id, 3]])
  expect(handlers.dismiss.mock.calls).toEqual([[id]])
})

test('tap reads what the payload helpers write', () => {
  const handlers = handlersOf()
  const conversation = new OwnerConversation(OWNER)
  conversation.tap(tapOf(formatChoicePayload('r1', 2)), handlers)
  conversation.tap(tapOf(formatDismissPayload('n1')), handlers)
  expect(handlers.answer.mock.calls).toEqual([['r1', 2]])
  expect(handlers.dismiss.mock.calls).toEqual([['n1']])
})

test('isOwner only counts the paired owner in a dm', () => {
  const conversation = new OwnerConversation('9')
  expect(conversation.isOwner('9', true)).toBe(true)
  expect(conversation.isOwner('9', false)).toBe(false)
  expect(conversation.isOwner('8', true)).toBe(false)
  expect(conversation.isOwner(undefined, true)).toBe(false)
  expect(new OwnerConversation(undefined).isOwner('9', true)).toBe(false)
})

test('ownerId is the constructor value until pairing', () => {
  expect(new OwnerConversation('9').ownerId).toBe('9')
  expect(new OwnerConversation(undefined).ownerId).toBeUndefined()
})

test('forget closes a question', () => {
  const conversation = conversationWith(['5', true])
  conversation.forget('5')
  expect(receiveReplyTo(conversation, '5')).toMatchObject({
    outcome: refused(NOT_OPEN_REPLY),
  })
  expect(conversation.receive(messageOf(), handlersOf())).toEqual(IGNORED)
})

test('forget of an unknown key does nothing', () => {
  expect(() => new OwnerConversation(OWNER).forget('nope')).not.toThrow()
})

test('tracking a key again replaces the question', () => {
  const conversation = new OwnerConversation(OWNER)
  conversation.track('5', 'a', false)
  conversation.track('5', 'b', true)
  const handlers = handlersOf()
  expect(conversation.receive(messageOf({ replyTo: QUESTION }), handlers)).toEqual(ANSWERED)
  expect(handlers.reply.mock.calls).toEqual([['b', 'feature/x']])
})

test('helpers: receiveReplyTo and pairOwner', () => {
  const text = new OwnerConversation(OWNER)
  text.track('5', 'q5', true)
  const answered = receiveReplyTo(text, '5')
  expect(answered.outcome).toEqual(ANSWERED)
  expect(answered.reply.mock.calls).toEqual([['q5', 'x']])
  const buttons = new OwnerConversation(OWNER)
  buttons.track('5', 'q5', false)
  expect(receiveReplyTo(buttons, '5').outcome).toEqual(refused(BUTTONS_ONLY_REPLY))
  expect(receiveReplyTo(new OwnerConversation(OWNER), '5').outcome).toEqual(refused(NOT_OPEN_REPLY))
  const unpaired = new OwnerConversation(undefined)
  pairOwner(unpaired, '4')
  expect(unpaired.ownerId).toBe('4')
})

function voterConversation(): OwnerConversation {
  const conversation = new OwnerConversation(OWNER)
  conversation.track('k', 'r1', false, '222')
  return conversation
}

test("a voter's tap on their own question answers", () => {
  const handlers = handlersOf()
  const tap = tapOf(formatChoicePayload('r1', 0), { senderId: '222' })
  expect(voterConversation().tap(tap, handlers)).toEqual(ANSWERED)
  expect(handlers.answer).toHaveBeenCalledWith('r1', 0)
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
