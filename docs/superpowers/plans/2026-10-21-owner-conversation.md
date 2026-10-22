# Owner Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One platform-free module, `src/conversation/`, owns the owner id, the open questions, reply/tap/dismiss routing, pairing replies, button payloads, the text hint and the bot's copy; Telegram and Discord shrink to mapping events in and acting on outcomes.

**Architecture:** `OwnerConversation` is a class with `#ownerId` and `#questions` (a `Map<string, OpenQuestion>`); `receive` and `tap` take a platform-free message or tap plus the runtime handlers and return a `kind`-tagged outcome. Payload helpers and copy are plain exports next to it. Discord moves first (its ids are already strings), then Telegram, converting numeric ids at its edge.

**Tech Stack:** TypeScript on Node >= 24.2, vite-plus (`vp test`, `vp check`), grammY, discord.js REST/WS wrappers.

**Spec:** `docs/superpowers/specs/2026-10-21-owner-conversation-design.md`

## Global Constraints

- Payload formats stay `<id>:<optionIndex>` and `dismiss/<id>`; buttons sent before the upgrade keep working.
- Telegram callback data <= 64 bytes with a UUID id (Discord's limit is 100).
- Copy strings stay byte-identical to today's (listed in Task 1).
- The module never throws; `receive` calls `reply` at most once, `tap` calls `answer` or `dismiss` at most once.
- Repo formatting: no semicolons, single quotes, width 100. Tests use `vite-plus/test` (`expect`, `test`, `vi`).
- Repo conventions win over `~/.claude/rules/ts-coding-style.md` where they conflict: free functions, `#private` fields, no `public` keyword (see `src/pairing/pairing.ts`), `vite-plus/test` not `node:test`.
- `src/conversation/` imports only types from `../provider/index.ts`, `FormattedText` + `appendText` from `../format/index.ts`. No grammY or discord.js types, no numbers for ids, no chat types.
- No compatibility re-exports: deleted names are deleted from the adapters' `index.ts`.
- `pnpm test` and `pnpm check` pass at the end of every task.
- Owner decisions (2026-10-21): `/start` prefix stripped on both platforms; taps outside a DM ignored on both.
- Commits: conventional, lowercase summary; no Co-Authored-By trailer.

## Review Focus

1. Owner taps a button on a Telegram message older than 48h: `callbackQuery.message` is an `InaccessibleMessage` (has `chat`, no text). Expect the answer to count. Test in Task 4.
2. A Telegram callback with no `message` at all: expect it ignored, but `answerCallbackQuery()` still called so the button stops spinning. Test in Task 4.
3. Buttons sent before the upgrade (`<uuid>:3`, `dismiss/<uuid>`) still answer and dismiss. Test in Task 2.
4. Telegram pairing reply fails to send: expect `failed to reply: <message>` logged, the owner still set and the command menu still set (today it escapes to `bot.catch`). Test in Task 4.
5. Re-pairing while questions are open: the new owner's reply answers the open question, the old owner's is ignored. Test in Task 2.

---

### Task 1: Copy, types and payloads

**Files:**
- Create: `src/conversation/constants.ts`, `src/conversation/types.ts`, `src/conversation/payload.ts`, `src/conversation/index.ts`
- Test: `test/conversation/payload.test.ts`

**Interfaces:**
- Produces (from `src/conversation/index.ts`):
  - `formatChoicePayload(id: string, optionIndex: number): string`
  - `formatDismissPayload(id: string): string`
  - `withTextHint(message: FormattedText, hasButtons: boolean, allowText: boolean): FormattedText`
  - Constants: `DISMISS_LABEL`, `TEXT_HINT_WITH_BUTTONS`, `TEXT_HINT_WITHOUT_BUTTONS`, `BUTTONS_ONLY_REPLY`, `NOT_OPEN_REPLY`, `AMBIGUOUS_REPLY`, `NOT_TEXT_REPLY`, `PAIRED_REPLY`, `WRONG_CODE_REPLY`, `EXPIRED_REPLY`
  - Types: `ConversationMessage`, `ConversationTap`, `MessageOutcome`, `TapOutcome`, `ConversationHandlers`
- Produces (module-private, `payload.ts`, not in index): `parseChoicePayload(payload: string | undefined): { readonly id: string; readonly optionIndex: number } | undefined`, `parseDismissPayload(payload: string | undefined): string | undefined`

- [ ] **Step 1: Write `src/conversation/constants.ts`**

Exact values (copy is pinned by the spec; the choice pattern is Discord's):

```ts
/** Matches `<id>:<optionIndex>`, the format `formatChoicePayload` writes; no `/`, so never a dismiss. */
export const CHOICE_PAYLOAD_PATTERN = /^([^:/]+):(\d+)$/
/** Matches `dismiss/<id>`, the format `formatDismissPayload` writes; no `:`, so never a choice. */
export const DISMISS_PAYLOAD_PATTERN = /^dismiss\/([^:]+)$/
/** Leading `/start` or `/start@botname` on a pairing message. */
export const START_COMMAND_PATTERN = /^\/start(@\w+)?/i
/** Label of the button that deletes a notification. */
export const DISMISS_LABEL = 'Dismiss'
/** Hint appended to a text-enabled request that has buttons. */
export const TEXT_HINT_WITH_BUTTONS = 'Tap a button or reply to this message to type an answer.'
/** Hint appended to a text-enabled request without buttons. */
export const TEXT_HINT_WITHOUT_BUTTONS = 'Reply to this message with your answer.'
/** Bot answer to a typed reply on a question that only takes buttons. */
export const BUTTONS_ONLY_REPLY = 'Tap one of the buttons to answer this question.'
/** Bot answer to a reply on a message that isn't an open question (or has expired). */
export const NOT_OPEN_REPLY = "That message isn't waiting for an answer."
/** Bot answer to a plain message while several text questions are open. */
export const AMBIGUOUS_REPLY = "Several questions are open; reply to the one you're answering."
/** Bot answer to a non-text reply on an open text question. */
export const NOT_TEXT_REPLY = 'Only text replies count as an answer.'
/** Bot answer to a correct pairing code. */
export const PAIRED_REPLY = 'Paired. Approval requests will appear here.'
/** Bot answer to a wrong pairing code. */
export const WRONG_CODE_REPLY =
  "This bot isn't paired. Check the service logs for the pairing code."
/** Answer to a tap on a request that is no longer valid. */
export const EXPIRED_REPLY = 'Expired'
```

- [ ] **Step 2: Write `src/conversation/types.ts`**

The five public types exactly as in the spec's "Proposed interface" block (`ConversationHandlers = Pick<RuntimeHandlers, 'answer' | 'reply' | 'dismiss' | 'pair'>`, `import type { RuntimeHandlers } from '../provider/index.ts'`). After a blank line, the internal `OpenQuestion = { readonly id: string; readonly allowText: boolean }` (not exported from index).

- [ ] **Step 3: Write the failing test `test/conversation/payload.test.ts`**

Imports from `../../src/conversation/index.ts` only.

```ts
const plain = (text: string) => ({ text, spans: [] })
const BOLD = { kind: 'bold', offset: 0, length: 1 } as const

test('formatChoicePayload writes <id>:<optionIndex>', () => {
  expect(formatChoicePayload('abc', 1)).toBe('abc:1')
})

test('formatDismissPayload writes dismiss/<id>', () => {
  expect(formatDismissPayload('abc')).toBe('dismiss/abc')
})

test('payloads fit telegram callback data with a uuid', () => {
  const id = crypto.randomUUID()
  expect(Buffer.byteLength(formatChoicePayload(id, 24))).toBeLessThanOrEqual(64)
  expect(Buffer.byteLength(formatDismissPayload(id))).toBeLessThanOrEqual(64)
})

test('withTextHint appends the buttons hint and keeps spans', () => {
  expect(withTextHint({ text: 'Q', spans: [BOLD] }, true, true)).toEqual({
    text: `Q\n\n${TEXT_HINT_WITH_BUTTONS}`,
    spans: [BOLD],
  })
})

test('withTextHint appends the reply hint without buttons', () => {
  expect(withTextHint(plain('Q'), false, true)).toEqual(plain(`Q\n\n${TEXT_HINT_WITHOUT_BUTTONS}`))
})

test.each([true, false])('withTextHint leaves the message alone without text (buttons %s)', (hasButtons) => {
  expect(withTextHint(plain('Q'), hasButtons, false)).toEqual(plain('Q'))
})
```

Also one test pinning the two hint strings and `DISMISS_LABEL` literally (`'Tap a button or reply to this message to type an answer.'`, `'Reply to this message with your answer.'`, `'Dismiss'`), so a copy edit fails a test.

- [ ] **Step 4: Run it to see it fail**

Run: `pnpm exec vp test test/conversation/payload.test.ts`
Expected: FAIL, cannot resolve `../../src/conversation/index.ts` exports.

- [ ] **Step 5: Implement `src/conversation/payload.ts` and `src/conversation/index.ts`**

`withTextHint` uses `appendText(message, `\n\n${hint}`)`. The parsers return `undefined` for `undefined` input or no match; `optionIndex` is `Number(rawIndex)`. `index.ts`: named re-exports of the Task 1 "Produces" list plus `OwnerConversation` once Task 2 adds it; `export type` for types; no parsers, no patterns, no `OpenQuestion`.

- [ ] **Step 6: Run tests and checks**

Run: `pnpm exec vp test test/conversation/payload.test.ts && pnpm check`
Expected: PASS, check clean.

- [ ] **Step 7: Commit**

```bash
git add src/conversation test/conversation/payload.test.ts
git commit -m "refactor: add conversation copy, types and button payloads"
```

---

### Task 2: `OwnerConversation`

**Files:**
- Create: `src/conversation/conversation.ts`, `test/conversation/conversation.test.ts`, `test/conversation/helpers.ts`
- Modify: `src/conversation/index.ts` (export `OwnerConversation`)

**Interfaces:**
- Consumes: Task 1 constants, types, `parseChoicePayload`, `parseDismissPayload`.
- Produces:
  ```ts
  export class OwnerConversation {
    constructor(ownerId: string | undefined)
    get ownerId(): string | undefined
    isOwner(senderId: string | undefined, isDirect: boolean): boolean
    track(key: string, id: string, allowText: boolean): void
    forget(key: string): void
    receive(message: ConversationMessage, handlers: ConversationHandlers): MessageOutcome
    tap(tap: ConversationTap, handlers: ConversationHandlers): TapOutcome
  }
  ```
- Produces (`test/conversation/helpers.ts`, used by adapter tests in Tasks 3 and 4):
  - `receiveReplyTo(conversation: OwnerConversation, key: string): { readonly outcome: MessageOutcome; readonly reply: Mock }`: the owner (`conversation.ownerId`) replies `'x'` in a DM to `{ key, fromSelf: true }` with an accepting `reply` spy. Tracked text question gives `{ kind: 'answered' }` and `reply('<id>', 'x')`; tracked buttons-only gives `refused` with `BUTTONS_ONLY_REPLY`; untracked gives `refused` with `NOT_OPEN_REPLY`.
  - `pairOwner(conversation: OwnerConversation, ownerId: string): void`: a DM from `ownerId` with `pair: () => 'paired'`, no reply-to.

- [ ] **Step 1: Write the test helpers and fixtures**

At the top of `conversation.test.ts`:

```ts
const OWNER = '9'
const QUESTION = { key: '5', fromSelf: true }
const OTHER_BOT_MESSAGE = { key: '7', fromSelf: true }
const messageOf = (overrides: Partial<ConversationMessage> = {}): ConversationMessage => ({
  senderId: OWNER, fromBot: false, isDirect: true, text: 'feature/x', replyTo: undefined, ...overrides,
})
const tapOf = (payload: string | undefined, overrides: Partial<ConversationTap> = {}): ConversationTap => ({
  senderId: OWNER, isDirect: true, payload, ...overrides,
})
// keys track as `q<key>`
function conversationWith(...entries: [string, boolean][]): OwnerConversation
function handlersOf(overrides: Partial<ConversationHandlers> = {}) // answer/reply accept, dismiss true, all vi.fn, no pair
const attempt = (pairing: Pairing) => (senderId: string, text: string) => pairing.attempt(senderId, text)
```

- [ ] **Step 2: Write the failing reply-routing tests**

One `test` per row; each asserts `expect(conversation.receive(message, handlers)).toEqual(outcome)` and the `reply` spy as listed. "accepting" is `reply` returning `'accepted'`, "expiring" returns `'expired'`. No `pair` handler unless stated.

| Test name | Conversation | Message overrides | reply | Outcome | reply calls |
| --- | --- | --- | --- | --- | --- |
| receive ignores a stranger | `['5', true]` | `senderId: '8'` | accepting | `ignored` | none |
| receive ignores a message outside a dm | `['5', true]` | `isDirect: false` | accepting | `ignored` | none |
| receive ignores a bot sender | `['5', true]` | `fromBot: true` | accepting | `ignored` | none |
| receive ignores a message without a sender | `['5', true]` | `senderId: undefined` | accepting | `ignored` | none |
| receive ignores everyone when nobody is paired | `new OwnerConversation(undefined)`, `track('5','q5',true)` | none | accepting | `ignored` | none |
| a reply is matched by key and trimmed | `track('900','q',true)` | `text: ' yes '`, `replyTo: { key: '900', fromSelf: true }` | accepting | `answered` | once `('q', 'yes')` |
| receive keeps inner newlines | `['5', true]` | `text: 'line 1\nline 2'`, `replyTo: QUESTION` | accepting | `answered` | once `('q5', 'line 1\nline 2')` |
| receive counts a reply starting with a slash | `['5', true]` | `text: '/var/www'`, `replyTo: QUESTION` | accepting | `answered` | once `('q5', '/var/www')` |
| receive refuses a reply to a buttons-only question | `['5', false]` | `replyTo: QUESTION` | accepting | `refused`, `BUTTONS_ONLY_REPLY` | none |
| receive says not open when the question is settled but not finalized | `['5', true]` | `replyTo: QUESTION` | expiring | `refused`, `NOT_OPEN_REPLY` | 1 |
| receive says not open for a reply to another bot message | `['5', true]` | `replyTo: OTHER_BOT_MESSAGE` | accepting | `refused`, `NOT_OPEN_REPLY` | none |
| receive treats a reply to the owner's own message as a non-reply | `['5', true]` | `replyTo: { key: '7', fromSelf: false }` | accepting | `answered` | once `('q5', 'feature/x')` |
| receive settles the one text question among buttons-only ones | `['5', false], ['6', true]` | none | accepting | `answered` | once `('q6', 'feature/x')` |
| receive is ambiguous with several text questions | `['5', true], ['6', true]` | none | accepting | `refused`, `AMBIGUOUS_REPLY` | none |
| receive ignores a non-reply when no text question is open | `['5', false]` | none | accepting | `ignored` | none |
| receive ignores a non-reply starting with a slash | `['5', true]` | `text: '/start'` | accepting | `ignored` | none |
| receive ignores a non-reply when the only text question is settled | `['5', true]` | none | expiring | `ignored` | 1 |
| receive says not text for a non-text reply to an open text question | `['5', true]` | `text: undefined`, `replyTo: QUESTION` | accepting | `refused`, `NOT_TEXT_REPLY` | none |
| receive ignores a non-text reply to a buttons-only question | `['5', false]` | `text: undefined`, `replyTo: QUESTION` | accepting | `ignored` | none |
| receive ignores a non-text reply to another bot message | `['5', false]` | `text: undefined`, `replyTo: OTHER_BOT_MESSAGE` | accepting | `ignored` | none |
| receive ignores a non-text non-reply | `['5', true]` | `text: undefined` | accepting | `ignored` | none |

Plus one test pinning the four refusal strings literally (`'Tap one of the buttons to answer this question.'`, `"That message isn't waiting for an answer."`, `"Several questions are open; reply to the one you're answering."`, `'Only text replies count as an answer.'`).

- [ ] **Step 3: Write the failing pairing tests**

Conversation is `new OwnerConversation(undefined)` unless stated; `pair` goes in `handlersOf({ pair })`.

| Test name | Setup | Message overrides | Expect |
| --- | --- | --- | --- |
| the right code pairs the sender | `attempt(new Pairing('K7QM4XPD'))` | `text: 'K7QM-4XPD'` | `{ kind: 'paired', ownerId: '9', text: PAIRED_REPLY }`; `conversation.ownerId` is `'9'` |
| receive strips /start and /start@bot before pairing: %s (`test.each(['/start K7QM-4XPD', '/start@my_bot k7qm4xpd'])`) | `attempt(new Pairing('K7QM4XPD'))` | `text` | `paired` |
| pairing gets the trimmed text | `pair = vi.fn(() => 'paired')` | `senderId: '1'`, `text: '  CODE \n'` | `pair` once `('1', 'CODE')`; outcome `paired` with `ownerId: '1'` |
| the /start strip comes after the trim | `pair = vi.fn(() => 'notPairing')` | `senderId: '8'`, `text: '/start K7QM4XPD'` | `pair` once `('8', ' K7QM4XPD')`; `ignored` |
| a wrong code gets the hint | `attempt(new Pairing('K7QM4XPD'))` | `text: 'nope'` | `{ kind: 'wrongCode', text: WRONG_CODE_REPLY }`; `ownerId` undefined |
| a blocked sender gets no reply | `attempt(new Pairing('K7QM4XPD', 1))` | `text: 'bad'` twice | first `wrongCode`, second `ignored` |
| after pairing, strangers and old codes get no reply | `Pairing('K7QM4XPD')` already attempted by `'1'` | `senderId: '2'`, `text: 'K7QM4XPD'` | `ignored`; `ownerId` undefined |
| pairing ignores messages outside dms, bots, no text and no sender | `pair = vi.fn(() => 'paired')` | each of `isDirect: false`, `fromBot: true`, `text: undefined`, `senderId: undefined` | all `ignored`; `pair` not called |
| a message is not a pairing attempt when pairing is off | no `pair` | `senderId: '5'`, `text: 'ABCDEFGH'` | `ignored` |
| an owner message routing ignores still reaches pairing | `new OwnerConversation(OWNER)`, no questions, `pair = vi.fn(() => 'notPairing')` | none | `pair` once `('9', 'feature/x')`; `ignored` |
| a refused reply never reaches pairing | `conversationWith(['5', false])`, `pair = vi.fn(() => 'paired')` | `replyTo: QUESTION` | `refused`; `pair` not called |
| re-pairing moves open questions to the new owner (Review Focus 5) | `conversationWith(['5', true])`, `pair: () => 'paired'` | DM from `'5'`, `text: 'CODE'` | `paired` with `ownerId: '5'`; then, with handlers that have no `pair`, a reply from `'5'` to `QUESTION` is `answered` and a reply from `'9'` is `ignored` |

One literal-copy test for `PAIRED_REPLY` and `WRONG_CODE_REPLY`.

- [ ] **Step 4: Write the failing tap, `isOwner` and `track`/`forget` tests**

| Test name | Setup | Tap | Expect |
| --- | --- | --- | --- |
| the owner's tap answers | answer accepting | `tapOf('abc:1')` | `{ kind: 'answered' }`; `answer` once `('abc', 1)` |
| a tap on a settled request is expired | answer returns `'expired'` | `tapOf('abc:1')` | `{ kind: 'expired', text: EXPIRED_REPLY }` |
| a tap from someone else is ignored | | `tapOf('abc:0', { senderId: '7' })` | `ignored`; `answer` not called |
| a tap while unpaired is ignored | `new OwnerConversation(undefined)` | `tapOf('abc:0')` | `ignored` |
| a tap without a sender is ignored | | `tapOf('abc:0', { senderId: undefined })` | `ignored` |
| taps outside a dm are ignored | | `tapOf('abc:0', { isDirect: false })` and `tapOf('dismiss/n1', { isDirect: false })` | both `ignored`; `answer`, `dismiss` not called |
| malformed payload %s is expired (`test.each([undefined, '', 'abc', 'abc:', 'abc:x', ':1', 'abc:1:2', 'abc:-1', 'a/b:1', 'dismiss/a:1'])`) | | `tapOf(payload)` | `{ kind: 'expired', text: EXPIRED_REPLY }`; `answer`, `dismiss` not called |
| the owner's dismiss calls dismiss | | `tapOf('dismiss/n1')` | `{ kind: 'dismissed' }`; `dismiss` once `('n1')`; `answer` not called |
| a dismiss for an unknown id is still dismissed | dismiss returns `false` | `tapOf('dismiss/gone')` | `dismissed` |
| a dismiss from someone else is ignored | | `tapOf('dismiss/n1', { senderId: '7' })` | `ignored`; `dismiss` not called |
| buttons sent before the upgrade still work (Review Focus 3) | `id = crypto.randomUUID()` | `tapOf(`${id}:3`)`, `tapOf(`dismiss/${id}`)` | `answered` with `answer(id, 3)`; `dismissed` with `dismiss(id)` |
| tap reads what the payload helpers write | | `tapOf(formatChoicePayload('r1', 2))`, `tapOf(formatDismissPayload('n1'))` | `answer('r1', 2)`; `dismiss('n1')` |

Also:
- `isOwner only counts the paired owner in a dm`: `new OwnerConversation('9')`: `('9', true)` true; `('9', false)`, `('8', true)`, `(undefined, true)` false; `new OwnerConversation(undefined).isOwner('9', true)` false.
- `ownerId is the constructor value until pairing`: `'9'` and `undefined`.
- `forget closes a question`: `track('5', 'q5', true)`, `forget('5')`; reply to `QUESTION` is `refused` `NOT_OPEN_REPLY`; a non-reply is `ignored`.
- `forget of an unknown key does nothing`: `expect(() => conversation.forget('nope')).not.toThrow()`.
- `tracking a key again replaces the question`: `track('5','a',false)`, `track('5','b',true)`; reply to `QUESTION` answers `('b', 'feature/x')`.

- [ ] **Step 5: Run them to see them fail**

Run: `pnpm exec vp test test/conversation/conversation.test.ts`
Expected: FAIL, `OwnerConversation` is not exported.

- [ ] **Step 6: Implement `OwnerConversation` in `src/conversation/conversation.ts`**

Class JSDoc: `/** The owner, their open questions, and what each message or tap means. Never throws. */`. Fields `#ownerId: string | undefined`, `#questions = new Map<string, OpenQuestion>()`. JSDoc on `track` from the spec ("Call after the platform accepted the send; `forget` in finalize, even if the edit fails.").

`receive` order (this is the part the tests pin; keep it in this order):
1. `fromBot` or `!isDirect`: `ignored`, nothing called.
2. If `isOwner(senderId, true)`: today's `routeReply` rules, with `#questions.get(replyTo.key)` for the lookup and `replyTo.fromSelf` for the bot check. `accepted` gives `answered`; `buttonsOnly`, `notOpen`/`expired`, `ambiguous`, `notText` give `refused` with the matching copy. Anything routing ignores falls through to step 3.
3. Pairing only when `handlers.pair`, `senderId` and `text` are all defined: `pair(senderId, text.trim().replace(START_COMMAND_PATTERN, ''))`. `'paired'` sets `#ownerId = senderId` and returns `paired`; `'wrong'` returns `wrongCode`; else `ignored`.

`tap` order: not `isOwner(senderId, isDirect)` gives `ignored`; a dismiss payload calls `dismiss` and gives `dismissed`; an unparseable choice gives `expired`; else `answer(id, optionIndex)` mapped to `answered` or `expired`.

Keep the routing in private methods (e.g. `#routeReply(message, reply): RefusalOrAnswer`), one switch mapping a route to copy. Export `OwnerConversation` from `index.ts`.

- [ ] **Step 7: Write `test/conversation/helpers.ts`**

`receiveReplyTo` and `pairOwner` as in Interfaces, importing from `../../src/conversation/index.ts`.

- [ ] **Step 8: Run tests and checks**

Run: `pnpm exec vp test test/conversation && pnpm check`
Expected: PASS, check clean.

- [ ] **Step 9: Commit**

```bash
git add src/conversation test/conversation
git commit -m "refactor: add OwnerConversation for owner routing and pairing"
```

---

### Task 3: Move Discord onto the conversation

**Files:**
- Modify: `src/discord/messenger.ts`, `src/discord/events.ts`, `src/discord/runtime.ts`, `src/discord/types.ts`, `src/discord/constants.ts`, `src/discord/index.ts`
- Delete: `src/discord/routing.ts`, `test/discord/routing.test.ts`
- Modify tests: `test/discord/messenger.test.ts`, `test/discord/events.test.ts`, `test/discord/runtime.test.ts`
- Create: `.changeset/discord-start-pairing.md`

**Interfaces:**
- Consumes: `OwnerConversation`, `formatChoicePayload`, `formatDismissPayload`, `withTextHint`, `DISMISS_LABEL`, copy constants (tests), `receiveReplyTo`, `pairOwner`.
- Produces:
  - `createDiscordMessenger(client: DiscordClient, conversation: OwnerConversation, log: (line: string) => void): Required<Messenger> & Required<Notifier>`
  - `toButtonRows(id: string, options: readonly string[]): readonly ButtonRow[]` now in `messenger.ts`, still exported from `src/discord/index.ts`.
  - `EventContext = { client, conversation: OwnerConversation, botId, handlers, log }` (loses `owner`, `openQuestions`, `onPaired`).

- [ ] **Step 1: Update the Discord tests first**

- `messenger.test.ts`: `setup()` builds `conversation = new OwnerConversation('1')` and returns it instead of `owner`/`openQuestions`. Replace `openQuestions.get('m1')` assertions with `receiveReplyTo(conversation, 'm1')` (`answered` plus `reply('r1', 'x')` for text questions, `refused` `BUTTONS_ONLY_REPLY` for buttons-only); `openQuestions.size` 0 becomes `receiveReplyTo(...).outcome` equal to `refused` `NOT_OPEN_REPLY`. `owner.id = '2'` becomes `pairOwner(conversation, '2')`; `owner.id = undefined` becomes `setup` with `new OwnerConversation(undefined)`. Move the two `toButtonRows` tests from `routing.test.ts:32-43` here unchanged. Hint constants import from `src/conversation/index.ts`.
- `events.test.ts`: `setup` builds `conversation = new OwnerConversation(ownerId)`; drop `owner`, `openQuestions`, `onPaired` from context and return value; return `conversation`. `openQuestions.set('m1', { id: 'r1', allowText })` becomes `conversation.track('m1', 'r1', allowText)`. `formatCustomId`/`formatDismissId` become `formatChoicePayload`/`formatDismissPayload`. `onPaired` assertions become `expect(conversation.ownerId).toBe('5')` (paired) or `toBeUndefined()` (not). Copy constants import from `src/conversation/index.ts`; `NOT_OWNER_COMMAND_REPLY` stays from Discord.
- `runtime.test.ts`: `PAIRED_REPLY` from `src/conversation/index.ts`.
- Delete `test/discord/routing.test.ts`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vp test test/discord`
Expected: FAIL on type/arity mismatches in messenger and events tests.

- [ ] **Step 3: Move the adapter**

- `messenger.ts`: owner from `conversation.ownerId`; after `createMessage` resolves, `conversation.track(sent.id, id, allowText)`; `finalize` calls `conversation.forget(messageId)` before the edit; `withTextHint(message, hasButtons, allowText)`; dismiss row uses `DISMISS_LABEL` and `formatDismissPayload`; `toButtonRows` moves here using `formatChoicePayload`.
- `events.ts`: `handleTap` maps to `conversation.tap({ senderId: interaction.userId, isDirect: interaction.isDirect, payload: interaction.customId }, context.handlers)` and switches on `kind`: `ignored`/`answered` acknowledge; `expired` responds `{ kind: 'message', content: outcome.text, ephemeral: true }`; `dismissed` acknowledges then deletes `interaction.messageId` (logging `failed to delete notification: ...` as today). `handleCommand` uses `context.conversation.isOwner(interaction.userId, interaction.isDirect)`. `handleMessage` maps `{ senderId: message.fromId, fromBot, isDirect, text, replyTo: replyTo && { key: replyTo.messageId, fromSelf: replyTo.fromId === context.botId } }` and switches: `refused` sends as a reply (`isReply` true), `paired`/`wrongCode` send plain, `ignored`/`answered` send nothing. Delete the local `isOwner` and the pre-check (the module drops bots and server messages).
- `runtime.ts`: `const conversation = new OwnerConversation(typeof settings.ownerId === 'string' ? settings.ownerId : undefined)`; pass to messenger and context; no `onPaired`.
- `types.ts`: delete `Owner`, `TapRoute`, `ReplyRoute`, `Tap`, `Reply`, `Dismiss`, `OpenQuestion`, `OpenQuestions`; update `EventContext` and its JSDoc.
- `constants.ts`: delete `CUSTOM_ID_PATTERN`, `DISMISS_ID_PATTERN`, `DISMISS_LABEL`, `TEXT_HINT_WITH_BUTTONS`, `TEXT_HINT_WITHOUT_BUTTONS`, `BUTTONS_ONLY_REPLY`, `NOT_OPEN_REPLY`, `AMBIGUOUS_REPLY`, `NOT_TEXT_REPLY`, `PAIRED_REPLY`, `WRONG_CODE_REPLY`, `EXPIRED_REPLY`.
- `index.ts`: drop the routing block and the deleted constants/types; export `toButtonRows` from `./messenger.ts`.
- Delete `src/discord/routing.ts`.

- [ ] **Step 4: Add the changeset**

`.changeset/discord-start-pairing.md`:

```md
---
'jaypost': patch
---

On Discord, a DM of `/start ABCD-EFGH` now pairs the bot, the same as on Telegram. It used to count as a wrong guess.
```

- [ ] **Step 5: Run tests and checks**

Run: `pnpm test && pnpm check`
Expected: PASS, check clean.

- [ ] **Step 6: Commit**

```bash
git add -A src/discord test/discord .changeset/discord-start-pairing.md
git commit -m "refactor: route discord messages and taps through OwnerConversation"
```

---

### Task 4: Move Telegram onto the conversation, then sweep

**Files:**
- Modify: `src/telegram/adapter.ts`, `src/telegram/runtime.ts`, `src/telegram/types.ts`, `src/telegram/constants.ts`, `src/telegram/index.ts`
- Modify tests: `test/telegram/adapter.test.ts`, `test/telegram/runtime.test.ts`

**Interfaces:**
- Consumes: as Task 3.
- Produces (`src/telegram/index.ts` keeps `createTelegramMessenger`, `formatLegacyInstructions`, `formatPairingInstructions`, `registerCommandHandler`, `registerTapHandler`, `setCommandMenu`, `toEntities`, adds `registerMessageHandler`, and exports no types):
  - `createTelegramMessenger(bot: Bot, conversation: OwnerConversation, log: (line: string) => void = console.error): Required<Messenger> & Required<Notifier>`
  - `registerTapHandler(bot: Bot, conversation: OwnerConversation, handlers: ConversationHandlers, log: (line: string) => void = console.error): void`
  - `registerMessageHandler(bot: Bot, conversation: OwnerConversation, handlers: RuntimeHandlers, log: (line: string) => void = console.error): void`
  - `registerCommandHandler(bot: Bot, conversation: OwnerConversation, commands: readonly OwnerCommand[], command: (name: string, argument: string) => string | undefined): void`

Decisions taken here: the owner id is a string inside the conversation and goes through `Number()` right before each grammY call (`sendMessage`, `sendDocument`, `deleteMessage`, `setMyCommands`), so today's numeric assertions hold. The message handler doesn't take `next` (nothing is registered after it). `formatMessageKey` stays as a private function in `adapter.ts`.

- [ ] **Step 1: Update the Telegram tests first**

`adapter.test.ts`:
- Delete: `formatCallbackData format`, `formatCallbackData fits 64 bytes with a UUID`, the four `routeTap` tests after them, `formatDismissData format`, `formatDismissData fits 64 bytes with a UUID`, `dismiss and approval payloads don't overlap`, `tap with no owner is ignored`, the seven pure pairing tests through `pairing handler replies via ctx.reply and stays silent when ignored`, `isOwnerCommand: owner in private chat only`, and the whole `routeReply` block with its `BOT_ID`/`QUESTION`/`messageOf`/`questionsOf` helpers.
- Messenger tests: `{ id: 42 }` becomes `new OwnerConversation('42')`. The `openQuestions` assertions become `receiveReplyTo(conversation, '42:5')`. `messenger sends to the owner id at call time` uses `new OwnerConversation(undefined)` then `pairOwner(conversation, '9')` and still expects `sendMessage(9, 'Q', ...)`.
- Tap handler tests: `registerTapHandler(bot, conversation, handlers, log)` with `handlers = { answer, reply, dismiss }` spies. `fakeBot().run` defaults `message` to `{ message_id: 11, chat: { id: 42, type: 'private' } }`, and `DISMISSED_MESSAGE` gains `type: 'private'` (without it the tap is now outside a DM and ignored). Add:
  - `handler: an owner tap on an inaccessible message still answers` (Review Focus 1): `message: { message_id: 11, chat: { id: 42, type: 'private' }, date: 0 }`, payload `'abc:0'`: `answer('abc', 0)` called, `answerCallbackQuery()` called.
  - `handler: a tap without a message is ignored and still answered` (Review Focus 2): add a `withoutMessage` option to `run` so `callbackQuery.message` is `undefined`, payload `'abc:0'`: `answer` not called, `answerCallbackQuery` called with no arguments.
  - `handler: a tap outside a private chat is ignored`: `chat: { id: -5, type: 'group' }`: `answer`/`dismiss` not called, `answerCallbackQuery()` called.
- Command handler tests: `{ id: 9 }` becomes `new OwnerConversation('9')`, `{ id: undefined }` becomes `new OwnerConversation(undefined)`. Expectations unchanged.
- Replace `setupReplyHandler` and its tests with `setupMessageHandler(options)` registering `registerMessageHandler(bot, conversation, handlers, log)` on a fake `{ on, botInfo: { id: 100 }, api: { setMyCommands } }`; the context has `from` (default `{ id: 42, is_bot: false }`), `chat` (default `{ id: 42, type: 'private' }`), `message` (`message_id: 50`, optional `text`, optional `reply_to_message`) and `reply`. Conversation is `new OwnerConversation('42')` with `track('42:7', 'q1', true)` unless overridden. Tests, one per outcome kind plus the edge mapping:
  - `message handler registers on message`
  - `message handler settles silently`: `' yes '` replying to `{ message_id: 7, from: { id: 100 } }`: `reply('q1', 'yes')`, `context.reply` not called.
  - `message handler answers a refusal as a reply to the owner message`: buttons-only `42:7`, `'hi'`: `context.reply(BUTTONS_ONLY_REPLY, { reply_parameters: { message_id: 50 } })`.
  - `a reply to an untracked bot message says not open` (exercises `fromSelf` from `botInfo.id`): no tracked questions, reply to `{ message_id: 7, from: { id: 100 } }`: `context.reply(NOT_OPEN_REPLY, { reply_parameters: { message_id: 50 } })`.
  - `message handler pairs and sets the command menu`: `new OwnerConversation(undefined)`, `pair: () => 'paired'`, `from: { id: 9 }`, `chat: { id: 9, type: 'private' }`, `text: '/start K7QM4XPD'`: `context.reply(PAIRED_REPLY)` with no second argument, `conversation.ownerId` is `'9'`, `setMyCommands` scope `{ type: 'chat', chat_id: 9 }`.
  - `message handler sends the wrong-code hint`: `pair: () => 'wrong'`: `context.reply(WRONG_CODE_REPLY)`.
  - `message handler ignores bots and group chats`: `from: { id: 42, is_bot: true }`; `chat: { id: -5, type: 'group' }`: no `reply`, no `context.reply`.
  - `a failed bot reply is logged, not thrown`: unchanged expectation `failed to reply: boom`.
  - `a failed pairing reply is logged and the owner still set` (Review Focus 4): pairing setup with throwing `context.reply`: resolves, `log('failed to reply: boom')`, `conversation.ownerId` `'9'`, `setMyCommands` called.
- Dispatch tests (`registerDispatchHandlers`): take a conversation and a handlers object; register `registerCommandHandler` then `registerMessageHandler`. `onPaired` assertions become `conversation.ownerId` `'9'`.

`runtime.test.ts`:
- Rename the order test to `start registers taps, then commands, then messages` and expect `['on:callback_query:data', 'command:pending', 'command:cancel', 'command:history', 'on:message']`.
- Delete `pairing handler is not registered without pair` (one handler is always registered now; pairing-off is covered in Task 2).
- `pairing sets the owner so requests go to them` and `runPairing`: find the `'message'` handler; the context becomes `{ from: { id: 9, is_bot: false }, chat: { id: 9, type: 'private' }, message: { message_id: 60, text: 'K7QM4XPD' }, reply }`.
- The real-`Bot` dispatch tests stay as they are and must pass unchanged.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vp test test/telegram`
Expected: FAIL on missing `registerMessageHandler` and changed signatures.

- [ ] **Step 3: Move the adapter**

- `adapter.ts`:
  - Delete `formatCallbackData`, `formatDismissData`, `parseDismissData`, `routeTap`, `routeReply`, `describeReplyRoute`, `handlePairingMessage`, `registerPairingHandler`, `registerReplyHandler`, `isOwnerCommand`. Make `formatMessageKey` private.
  - Messenger: a private `requireOwnerChatId(conversation): number` throws `'bot is not paired yet'` and returns `Number(conversation.ownerId)`. `sendRequest` uses `withTextHint`, `formatChoicePayload` and calls `conversation.track(formatMessageKey(sent.chat.id, sent.message_id), id, allowText)` after the send resolves. `finalize` calls `conversation.forget(...)` before the edit. `sendNotification` uses `DISMISS_LABEL`, `formatDismissPayload`.
  - `registerTapHandler`: `conversation.tap({ senderId: String(context.from.id), isDirect: context.callbackQuery.message?.chat.type === 'private', payload: context.callbackQuery.data }, handlers)`. Read the chat from `callbackQuery.message`, not `context.chat`, so the hand-built test contexts work. `dismissed` runs today's two deletes; `expired` answers `{ text: outcome.text }`; the rest answer with no arguments. One `answerCallbackQuery` per tap.
  - `registerMessageHandler` on `'message'`: map `senderId: context.from === undefined ? undefined : String(context.from.id)`, `fromBot: context.from?.is_bot === true`, `isDirect: context.chat.type === 'private'`, `text: context.message.text`, `replyTo` as `{ key: formatMessageKey(context.chat.id, replyTo.message_id), fromSelf: replyTo.from?.id === bot.botInfo.id }` (read `botInfo` only inside that branch). `refused` replies with `reply_parameters`; `paired` calls `setCommandMenu(bot, Number(outcome.ownerId), handlers.commands, log)` then replies plain; `wrongCode` replies plain. Every `context.reply` failure logs `failed to reply: <message>`. JSDoc keeps the "register after `registerCommandHandler`" note.
  - `registerCommandHandler`: `conversation.isOwner(context.from === undefined ? undefined : String(context.from.id), context.chat.type === 'private')`.
- `runtime.ts`: `const conversation = new OwnerConversation(typeof settings.ownerId === 'number' ? String(settings.ownerId) : undefined)`. `start` registers tap, command, message handlers in that order; the startup `setCommandMenu` uses `Number(conversation.ownerId)` when it's defined.
- `types.ts`: keep only `TelegramMessageReference`.
- `constants.ts`: keep `TOKEN_CHECK_TIMEOUT_SECONDS`, `TELEGRAM_MAX_TEXT_LENGTH`, `TELEGRAM_MAX_ATTACHMENT_BYTES`; delete the rest.
- `index.ts`: as in Interfaces.

- [ ] **Step 4: Run tests and checks**

Run: `pnpm test && pnpm check`
Expected: PASS, check clean.

- [ ] **Step 5: Sweep for leftovers**

Run:

```bash
grep -rnE "routeReply|routeTap|describeReplyRoute|handlePairingMessage|registerPairingHandler|registerReplyHandler|isOwnerCommand|formatCallbackData|formatDismissData|parseDismissData|formatCustomId|formatDismissId|parseDismissId|CALLBACK_DATA_PATTERN|CUSTOM_ID_PATTERN|DISMISS_DATA_PATTERN|DISMISS_ID_PATTERN|onPaired|\bOwner\b|TapRoute|ReplyRoute" src test
grep -rnE "Paired\. Approval|isn't paired\. Check|'Expired'|Tap a button or reply|Reply to this message with|Tap one of the buttons|isn't waiting for an answer|Several questions are open|Only text replies count" src
```

Expected: first grep has no code hits (prose like "Owner read/write only" in `src/install`/`src/config` comments is fine). Second grep: hits only in `src/conversation/constants.ts`.

- [ ] **Step 6: Commit**

```bash
git add -A src/telegram test/telegram
git commit -m "refactor: route telegram messages and taps through OwnerConversation"
```
