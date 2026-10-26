# Hosted Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-owner daemon into one multi-tenant service: many bots, many paired people per bot, API keys that each reach one person on one bot, and admin HTTP routes, while existing installs upgrade in place.

**Architecture:** Core learns "many paired people per bot" (conversation, pairing codes, per-recipient and per-key scoping) without touching storage. A new `registry` module in `store` holds bots, pairings and hashed keys in one JSON file with pure operations. In `service`, a `Hub` owns the registry and one `BotSupervisor` per bot, routes each call by key, and backs new `/admin/*` routes. The CLI gets admin commands that call those routes.

**Tech Stack:** Node >= 24.2 running `.ts` directly, Fastify, zod, grammY/Discord, commander, vite-plus test runner (`test`/`expect` from `vite-plus/test`).

**Spec:** `docs/superpowers/specs/2026-10-26-hosted-service-design.md` (read it first; it's the source of every rule below).

## Global Constraints

- Node 24, no build step, ESM. Package layering from `CONTRIBUTING.md`: a package imports only packages above it (`core`, `store`, `protocol`, `client`, `providers`, `service`, `install`, `mcp`, `hook`). New exports go through each package's `src/index.ts`.
- Match the surrounding code: top-level functions plus classes with `#private` fields, JSDoc on exports, `Never throws` where true, `x === undefined ? {} : { x }` spreads for optional fields.
- Pure core, I/O at the edges. Nothing in `packages/core` reads or writes files.
- HTTP API stays compatible: new fields and routes are fine, changed meanings for existing ones aren't. The one intended change is from the spec: on a no-token install a *wrong* token now gets 401.
- Secrets (bot tokens, API keys, the admin key, pairing codes in logs) are never logged or echoed in an error body. Error messages never quote request bodies.
- Every file that holds a secret or a person id is written with `SECRET_FILE_MODE` (0600) through `writeFileAtomic`.
- No em-dashes anywhere (code, copy, docs, commits). Commits are conventional and lowercase (`feat:`, `refactor:`, `docs:`, `chore:`), with no Claude/Anthropic attribution trailer.
- Stay on the current branch `feat/hosted-service-2`.
- Run one test file: `npx vp test <path>`; one test: `npx vp test <path> -t "<name>"`. Before each commit: `npx vp check` (lint, format, types) passes.

## Review Focus

1. A paired person's plain text on a shared bot while someone else's text question is open: it must never answer the other person's question (test in Task 1).
2. Upgrading an install that has pending requests and notifications in the old `state.json`: they must still be expired and deleted after the move into `bots/b1/` (test in Task 5).
3. A failed registry write during an admin call: the call answers 500 and the in-memory registry stays as it was, so memory and disk never disagree (test in Task 7).
4. A key polling or cancelling another key's background question id: 404, same as an unknown id (test in Task 7).
5. `POST /admin/bots` with rejected credentials or a body that holds the token: the error body and logs never contain the token (test in Task 8).

---

### Task 1: Many paired people in the conversation and providers

The provider contract stops knowing "the owner". Every message goes to an explicit `recipient`, and the daemon answers "is this sender paired?".

**Files:**
- Modify: `packages/core/src/provider/types.ts` (`RuntimeHandlers`)
- Modify: `packages/core/src/notify/types.ts` (`SendNotificationOptions`)
- Modify: `packages/core/src/conversation/{conversation,types,constants}.ts`
- Modify: `packages/providers/src/telegram/{runtime,adapter}.ts`, `packages/providers/src/discord/{runtime,messenger,events}.ts`, `packages/providers/src/terminal/runtime.ts`
- Modify: `packages/core/src/notify/service.ts` (`notify` takes the recipient)
- Modify: `packages/service/src/daemon/bot.ts`, `packages/service/src/server/{types,server}.ts` (interim single-owner wiring)
- Test: `packages/core/test/conversation/conversation.test.ts`, provider tests under `packages/providers/test/`, `packages/service/test/daemon/service.test.ts`

**Interfaces:**
- Produces, in `RuntimeHandlers`:
  ```ts
  /** True for anyone paired on this bot; only their messages, taps and commands count. */
  readonly isPaired: (senderId: string) => boolean
  /** Everyone paired on this bot, for per-chat command menus at start. */
  readonly listPaired: () => readonly string[]
  /** `senderId` is undefined only for providers without chat identities (terminal). */
  readonly command: (name: string, argument: string, senderId: string | undefined) => string | undefined
  ```
  `pair` stays optional; the daemon now passes it whenever the provider has an owner setting.
- `SendNotificationOptions` gains `readonly recipient: string | undefined`, and `NotificationService.notify(request: NotifyRequest, recipient: string | undefined)` puts it there.
- `ConversationHandlers = Pick<RuntimeHandlers, 'answer' | 'reply' | 'dismiss' | 'pair' | 'isPaired'>`.
- `OwnerConversation` (name kept): `constructor()` with no owner; the `ownerId` getter is removed; `isOwner` becomes `isPaired(senderId: string | undefined, isDirect: boolean, handlers: Pick<RuntimeHandlers, 'isPaired'>): boolean`.
- `MessageOutcome` `paired` variant becomes `{ readonly kind: 'paired'; readonly senderId: string; readonly text: string }`.
- Interim `ApiBot.recipient: () => string | undefined` (the paired owner), removed in Task 7.

- [ ] **Step 1: Write the failing conversation tests**

```ts
test('a plain reply only answers a text question sent to the sender', () => {
  const conversation = new OwnerConversation()
  const reply = vi.fn(() => 'accepted' as const)
  const handlers = { ...createHandlers({ reply }), isPaired: (id: string) => id === 'A' || id === 'B' }
  conversation.track('m1', 'q1', true, 'B')
  const outcome = conversation.receive(message({ senderId: 'A', text: 'yes' }), handlers)
  expect(outcome).toEqual({ kind: 'ignored' })
  expect(reply).not.toHaveBeenCalled()
})

test("a reply to another person's question is not open for the sender", () => {
  // A replies to B's message key: treated like a message that isn't waiting for an answer.
  conversation.track('m1', 'q1', true, 'B')
  expect(conversation.receive(message({ senderId: 'A', text: 'yes', replyTo: { key: 'm1', fromSelf: true } }), handlers))
    .toEqual({ kind: 'refused', text: NOT_OPEN_REPLY })
})

test('a choice counts only from the question recipient, paired or not', () => {
  conversation.track('m1', 'q1', false, 'V')   // V is a voter, not paired
  expect(conversation.tap(tap({ senderId: 'A', payload: 'q1:0' }), handlers)).toEqual({ kind: 'ignored' })
  expect(conversation.tap(tap({ senderId: 'V', payload: 'q1:0' }), handlers)).toEqual({ kind: 'answered' })
})

test('pairing reports the sender and does not store an owner', () => {
  const pair = vi.fn(() => 'paired' as const)
  expect(conversation.receive(message({ senderId: 'C', text: '/start K7QM4XPD' }), { ...handlers, pair }))
    .toEqual({ kind: 'paired', senderId: 'C', text: PAIRED_REPLY })
  expect(conversation.isPaired('C', true, handlers)).toBe(false)   // membership is the daemon's
})
```
Adapt the existing conversation tests: replace `new OwnerConversation('1')` with `new OwnerConversation()` plus `isPaired: (id) => id === '1'` in the handlers, and track owner questions with `recipient: '1'`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vp test packages/core/test/conversation/conversation.test.ts`
Expected: FAIL (constructor arity, `isPaired` missing, `senderId` field).

- [ ] **Step 3: Implement the conversation changes**

`receive`: a paired sender (per `handlers.isPaired`) goes through reply routing, which only considers tracked questions whose `recipient === senderId` (both for `replyTo` and for the single-open-text-question case); everyone else, and paired senders whose message routed to `ignored`, go to `#pair`. `tap`: dismiss needs a paired sender; a choice on a tracked question counts only when `question.recipient === tap.senderId`; an untracked choice goes to `handlers.answer` for a paired sender, else `expired`. Change `WRONG_CODE_REPLY` to `"That pairing code didn't match. Check it and try again."` (the old text says the bot isn't paired, which is false on a shared bot).

- [ ] **Step 4: Update the providers**

Telegram: `createTelegramRuntime` no longer reads `settings.ownerId`; `sendRequest` and `sendNotification` use `requireChatId(recipient)` (throws, so the service reports a send failure); `start` sets the command menu for each `handlers.listPaired()` id; a `paired` outcome sets it for `outcome.senderId`; command handlers check `conversation.isPaired(...)` and call `command(name, match, String(senderId))`. Discord: same in `resolveChannel(recipient)`, `sendNotification` and the slash-command check in `events.ts`. Terminal: `command(name, argument, undefined)`; it keeps ignoring `recipient`. Update provider tests that built runtimes with an owner setting to pass `isPaired`/`listPaired` in their handlers and an explicit recipient.

- [ ] **Step 5: Interim daemon wiring so the service still works**

In `startBot`, keep a local `owner` (from the owner setting, set on pairing as today) and pass `isPaired: (id) => id === owner`, `listPaired: () => (owner === undefined ? [] : [owner])`, `command: (name, argument) => ...` (sender ignored for now), and expose `recipient: () => owner` on `ApiBot`. In `server.ts`, `/request`, `/request/async` add `recipient: bot.recipient()` to the parsed request (only when no recipient is set), and `/notify` passes it to `notifications.notify(parsed, bot.recipient())`. Add a `notify sends to the given recipient` case to `packages/core/test/notify/service.test.ts`.

- [ ] **Step 6: Run the affected suites**

Run: `npx vp test packages/core packages/providers packages/service`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core packages/providers packages/service
git commit -m "refactor: send every message to an explicit recipient and ask the daemon who is paired"
```

---

### Task 2: Several outstanding pairing codes per bot

**Files:**
- Create: `packages/core/src/pairing/codes.ts`
- Modify: `packages/core/src/pairing/{types,constants,index}.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/pairing/codes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** Outcome of redeeming a code; `pairingId` names the pending pairing the code belonged to. */
  export type PairingClaim =
    | { readonly kind: 'paired'; readonly pairingId: string }
    | { readonly kind: 'wrong' }
    | { readonly kind: 'blocked' }
    | { readonly kind: 'notPairing' }
  export class PairingCodes {
    constructor(maxFailures?: number)              // default DEFAULT_MAX_FAILURES
    add(pairingId: string, code: string): void      // replaces that pairing's previous code
    remove(pairingId: string): void
    codeFor(pairingId: string): string | undefined  // raw, uppercase, no dash
    get isEmpty(): boolean
    attempt(senderId: string, text: string): PairingClaim  // success removes the code
  }
  /** True when `text` normalizes to PAIRING_CODE_LENGTH characters of PAIRING_ALPHABET. */
  export function isCodeShaped(text: string): boolean
  ```
- The existing `Pairing` class stays for direct mode (`setup-ci`, `pair approver`).

- [ ] **Step 1: Write the failing tests**

```ts
test('each code claims its own pairing once', () => {
  const codes = new PairingCodes()
  codes.add('p1', 'K7QM4XPD')
  codes.add('p2', 'ABCD2345')
  expect(codes.attempt('u1', 'abcd-2345')).toEqual({ kind: 'paired', pairingId: 'p2' })
  expect(codes.codeFor('p2')).toBeUndefined()
  expect(codes.attempt('u2', 'ABCD2345')).toEqual({ kind: 'wrong' })
  expect(codes.codeFor('p1')).toBe('K7QM4XPD')
})

test('wrong guesses are counted per sender across all codes', () => {
  // five wrong guesses from u1, then u1 is blocked even with a right code; u2 still pairs
})

test('no outstanding codes means not pairing, and failures are not counted', () => {
  expect(new PairingCodes().attempt('u1', 'K7QM4XPD')).toEqual({ kind: 'notPairing' })
})

test('removing a pairing drops its code', () => { /* add, remove, attempt -> wrong or notPairing */ })

test('isCodeShaped accepts dashes, spaces and lowercase, rejects chat text', () => {
  expect(isCodeShaped('k7qm-4xpd')).toBe(true)
  expect(isCodeShaped('/start K7QM4XPD')).toBe(false) // callers strip /start first
  expect(isCodeShaped('sounds good')).toBe(false)
})
```

- [ ] **Step 2: Run, expect FAIL** (`npx vp test packages/core/test/pairing/codes.test.ts`, module missing)
- [ ] **Step 3: Implement `PairingCodes` and `isCodeShaped`** reusing `normalizeCode` (move it to a shared private helper in `pairing.ts` or `codes.ts`).
- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit** `feat: pairing codes for several pending pairings per bot`

---

### Task 3: Scope questions, history, notifications and the audit log by recipient and key

**Files:**
- Modify: `packages/core/src/approval/{types,service,commands,pending}.ts`
- Modify: `packages/core/src/notify/{types,service}.ts`
- Modify: `packages/store/src/audit/{types,schema,store,parser}.ts`, `packages/store/src/state/schema.ts`
- Modify: `packages/service/src/daemon/bot.ts`, `packages/service/src/server/{types,server}.ts` (new call signatures, still single-key)
- Test: `packages/core/test/approval/{service,commands}.test.ts`, `packages/core/test/notify/service.test.ts`, `packages/store/test/audit/{store,parser}.test.ts`, `packages/store/test/state/parser.test.ts`

**Interfaces:**
- Produces in `@jaypost/core`:
  ```ts
  /** Who asked: the API key and its pairing. Opaque to core; used for scoping and the audit log. */
  export type RequestCaller = { readonly key: string; readonly pairing: string }
  // ApprovalRequest gains: readonly caller?: RequestCaller
  // RequestRecord gains:   readonly caller?: RequestCaller   (saved in state.json)
  // HistoryEntry gains:    readonly recipient: string | undefined
  // AuditSink.settled becomes (id, ending, at, caller: RequestCaller | undefined) => void
  ```
  `ApprovalService`:
  ```ts
  get(id: string, key: string | undefined): RequestState | undefined
  waitFor(id: string, key: string | undefined, waitMs: number, signal?: AbortSignal): Promise<RequestState | undefined>
  cancel(id: string, key: string | undefined): Promise<RequestState | undefined>
  listPending(recipient: string | undefined): readonly PendingSummary[]
  rejectAll(recipient: string | undefined): readonly PendingSummary[]
  /** Settles every open question asked with `key` (votes included) as rejected with its timeout option. */
  rejectForKey(key: string): readonly PendingSummary[]
  history(count: number, recipient: string | undefined): readonly HistoryEntry[]
  ```
  Matching is strict: `key` matches `request.caller?.key`, `recipient` matches `request.recipient`, so `undefined` only matches questions without one. A mismatched id behaves exactly like an unknown id.
  `runOwnerCommand(service, name, argument, recipient: string | undefined, options)`.
  `QuietSource.quietUntil: (recipient: string | undefined) => Date | undefined`; `notify` asks it for the notification's recipient.
- Produces in `@jaypost/store`: `AskedRecord` and `SettledRecord` gain `key?: string; pairing?: string`; `AuditEntry` gains `key?`, `pairing?` and `bot?` (set by readers that merge several bots); `AuditFilter` gains `key?`, `pairing?`, `bot?` and `unkeyedAs?: string` ("lines without a key count as this key's", for logs written before the upgrade).
- `runVote` already spreads `vote.request`, so `caller` reaches every voter's question; check it in a test rather than changing it.

- [ ] **Step 1: Write the failing core tests**

```ts
test("get, waitFor and cancel don't see another key's background question", async () => {
  const { id } = await service.start({ ...REQUEST, caller: { key: 'k1', pairing: 'p1' } })
  expect(service.get(id, 'k2')).toBeUndefined()
  expect(await service.cancel(id, 'k2')).toBeUndefined()
  expect(service.get(id, 'k1')).toEqual({ kind: 'pending', expiresAt: expect.any(Date) })
})

test('pending, cancel and history only cover the given recipient', async () => {
  // open one question to 'A' and one to 'B'; listPending('A') has one entry; rejectAll('A')
  // settles only A's; history(10, 'B') is empty until B's settles
})

test('rejectForKey settles every question asked with that key, votes included', async () => {
  // a vote with caller k1 to voters V1, V2 plus a request with caller k2: rejectForKey('k1')
  // settles both vote questions with their timeout option and leaves k2's open
})

test('the audit sink gets the caller on asked and settled', async () => {
  // asked(id, { ...caller }) and settled(id, ending, at, { key: 'k1', pairing: 'p1' })
})

test('notify asks quiet hours for its recipient', async () => {
  const quietUntil = vi.fn((recipient: string | undefined) => (recipient === 'B' ? LATER : undefined))
  await notifications.notify(NOTIFY_REQUEST, 'A')
  await notifications.notify(NOTIFY_REQUEST, 'B')
  expect(sendNotification.mock.calls.map((call) => call[2])).toEqual([
    { silent: false, dismissible: true, recipient: 'A' },
    { silent: true, dismissible: true, recipient: 'B' },
  ])
})
```
`commands.test.ts`: `/pending`, `/cancel` and `/history` run with recipient `'A'` don't list, reject or show `'B'`'s questions.

- [ ] **Step 2: Write the failing store tests**

```ts
test('asked and settled lines carry key and pairing when the request has a caller', () => {
  // read the file back: both lines have key: 'k1', pairing: 'p1'; a request without caller
  // writes neither field (old readers keep working)
})

test('selectAuditEntries filters by key and pairing, and unkeyedAs claims old lines', () => {
  const entries = [entry({ id: 'a', key: 'k1' }), entry({ id: 'b', key: 'k2' }), entry({ id: 'c' })]
  expect(selectAuditEntries(entries, { key: 'k1' }).map((e) => e.id)).toEqual(['a'])
  expect(selectAuditEntries(entries, { key: 'k1', unkeyedAs: 'k1' }).map((e) => e.id)).toEqual(['a', 'c'])
})
```
State parser: a request record with `caller` round-trips; one without still parses.

- [ ] **Step 3: Run, expect FAIL** (`npx vp test packages/core/test/approval packages/core/test/notify packages/store/test`)
- [ ] **Step 4: Implement.** Background entries keep the request's `caller`. `#finish` and `expireOrphans` pass `request.caller` / `record.caller` to `audit.settled`. `#open` saves `caller` in the request record. The parser copies `key`/`pairing` from the asked line into the entry. Update `bot.ts` and `server.ts` call sites to pass `undefined` for key and the interim owner for recipient, so behavior is unchanged until Task 7.
- [ ] **Step 5: Run the core, store and service suites, expect PASS** (`npx vp test packages/core packages/store packages/service`)
- [ ] **Step 6: Commit** `feat: scope questions, notifications and the question log by recipient and key`

---

### Task 4: Registry data and pure operations

**Files:**
- Create: `packages/store/src/registry/{types,constants,schema,operations,keys,index}.ts`
- Modify: `packages/store/src/index.ts`
- Test: `packages/store/test/registry/operations.test.ts`, `packages/store/test/registry/keys.test.ts`

**Interfaces:**
- Produces (types; every optional field is omitted when unset, never `undefined`):
  ```ts
  export type BotRecord = { readonly id: string; readonly provider: string; readonly settings: SettingValues; readonly label?: string; readonly createdAt: string }
  /** No `person` means pending: it has a `code` and waits for someone to redeem it. */
  export type PairingRecord = {
    readonly id: string; readonly botId: string; readonly person?: string; readonly code?: string
    readonly quietHours?: string; readonly mutedUntil?: string; readonly createdAt: string
  }
  /** `hash` is absent only for the seed key of a tokenless install. */
  export type KeyRecord = { readonly id: string; readonly pairingId: string; readonly hash?: string; readonly label?: string; readonly externalId?: string; readonly createdAt: string }
  /** What init/env seeded: bot 1, pairing 1 and key 1, and whether calls without a token act as key 1. */
  export type SeedRecord = { readonly fingerprint: string; readonly botId: string; readonly pairingId: string; readonly keyId: string; readonly isOpen: boolean }
  export type Registry = {
    readonly version: 1
    /** Ids are never reused, so an old audit line can't be read as a new key's. */
    readonly lastIds: { readonly bot: number; readonly pairing: number; readonly key: number }
    readonly bots: readonly BotRecord[]; readonly pairings: readonly PairingRecord[]; readonly keys: readonly KeyRecord[]
    readonly seed?: SeedRecord
  }
  export type KeyTarget =
    | { readonly kind: 'newPairing'; readonly botId: string }
    | { readonly kind: 'pairing'; readonly pairingId: string }
    | { readonly kind: 'sameAsKey'; readonly keyId: string }
  export type SeedInput = {
    readonly fingerprint: string; readonly provider: string; readonly settings: SettingValues
    readonly owner?: string; readonly tokenHash?: string
    readonly quietHours?: string; readonly mutedUntil?: string
  }
  ```
  Constants: `REGISTRY_VERSION = 1`, `REGISTRY_FILE_NAME = 'registry.json'`, `BOTS_DIRECTORY_NAME = 'bots'`, `ADMIN_KEY_FILE_NAME = 'admin-key'`, `ADMIN_KEY_ENV_VAR = 'JAYPOST_ADMIN_KEY'`, `LOCAL_PERSON = 'local'` (the person of pairings on providers that don't pair), `API_KEY_PREFIX = 'jpk_'`, `ADMIN_KEY_PREFIX = 'jpa_'`. Ids are `b<n>`, `p<n>`, `k<n>`.
- Operations (all pure, never throw; `at` is the caller's clock; `pairs` says whether the bot's provider has an owner setting; results are discriminated on `kind`, with `'notFound'` carrying `what: 'bot' | 'pairing' | 'key'` and `id`):
  ```ts
  createEmptyRegistry(): Registry
  addBot(registry, input: { provider: Provider; settings: SettingValues; label?: string }, at: Date): { kind: 'added'; registry; bot } | { kind: 'duplicate'; botId: string }
  removeBot(registry, botId): { kind: 'removed'; registry; keyIds: readonly string[] } | NotFound
  createPairing(registry, botId, code: string, pairs: boolean, at): { kind: 'created'; registry; pairing } | NotFound
  createKey(registry, target: KeyTarget, hash: string, details: { label?: string; externalId?: string }, code: string, pairs: boolean, at): { kind: 'created'; registry; key; pairing } | NotFound
  claimPairing(registry, pairingId, person): { kind: 'claimed' | 'merged'; registry; pairing } | NotFound
  resetPairing(registry, pairingId, code): { kind: 'reset'; registry; pairing } | NotFound
  revokeKey(registry, keyId): { kind: 'revoked'; registry } | NotFound
  removePairing(registry, pairingId): { kind: 'removed'; registry; keyIds } | NotFound
  updateKey(registry, keyId, patch: { label?: string | null; externalId?: string | null }): { kind: 'updated'; registry; key } | NotFound
  updatePairingQuiet(registry, pairingId, patch: QuietPatch): Registry
  applySeed(registry, seed: SeedInput, pairs: boolean, generateCode: () => string, at): { registry; isNew: boolean }
  findKeyByHash(registry, hash): KeyRecord | undefined
  ```
  In `keys.ts`: `generateApiKey(): string` (`jpk_` + 32 random bytes base64url), `generateAdminKey(): string` (`jpa_` + same), `hashKey(key: string): string` (sha256 hex). Both generated formats pass `TOKEN_PATTERN`, so clients accept them unchanged.

Rules the operations implement (from the spec's calls):
- `addBot` refuses a bot whose provider and secret settings (`listSecretValues`) equal a stored bot's. The owner setting is never stored on a bot.
- With `pairs === false`, `createPairing` and `createKey` with `newPairing` reuse the bot's one `LOCAL_PERSON` pairing (creating it, already claimed, if missing). No code.
- `claimPairing`: if another pairing on the same bot already has this person, every key of the pending pairing moves to it and the pending one is deleted (`merged`); else the person is set and the code dropped (`claimed`).
- `removePairing` removes its keys; `removeBot` removes its pairings and their keys; both return the removed key ids so the caller can cancel their questions.
- `applySeed`: on an empty registry, creates bot, pairing (claimed with `owner`, or pending with `generateCode()`; quiet values copied) and key (`hash` = `tokenHash`, absent without a token) and records the seed with `isOpen: tokenHash === undefined`. On a registry whose `seed.fingerprint` equals the input's, returns it unchanged. Otherwise updates the seed bot in place (re-creating it if removed); when the provider name changed, every pairing of that bot is reset to pending with its own `generateCode()`; sets key 1's hash (re-creating it on the seed pairing if revoked); sets the seed pairing's person from `owner` when it has none; stores the new fingerprint.

- [ ] **Step 1: Write the failing tests** (one per rule above, asserting the whole returned registry with `toEqual`). Key ones:

```ts
test('a key for a new pairing on a pairing bot is pending with the code', () => {
  const { registry } = addBot(createEmptyRegistry(), { provider: TELEGRAM_LIKE, settings: { botToken: 't' } }, AT) as Added
  const result = createKey(registry, { kind: 'newPairing', botId: 'b1' }, 'h1', {}, 'K7QM4XPD', true, AT)
  expect(result).toEqual({ kind: 'created', registry: expect.anything(),
    key: { id: 'k1', pairingId: 'p1', hash: 'h1', createdAt: AT.toISOString() },
    pairing: { id: 'p1', botId: 'b1', code: 'K7QM4XPD', createdAt: AT.toISOString() } })
})

test('redeeming a second code on the same bot moves its keys to the existing pairing', () => { /* merged */ })
test('a duplicate bot token is refused', () => {})
test('removing a pairing removes its keys and returns their ids', () => {})
test('ids are never reused after a removal', () => { /* remove k2, create again -> k3 */ })
test('a terminal-like bot gets one local pairing and no code', () => {})
test('seeding an empty registry makes bot 1, pairing 1 and key 1', () => {})
test('seeding with the same fingerprint changes nothing, even after admin removed key 1', () => {})
test('seeding with a new fingerprint updates bot 1 and key 1 and keeps other keys', () => {})
test('seeding a different provider resets the bot pairings', () => {})
test('generated keys pass the client token pattern and hash to 64 hex characters', () => {})
```

- [ ] **Step 2: Run, expect FAIL** (`npx vp test packages/store/test/registry`)
- [ ] **Step 3: Implement** the types, a zod `registrySchema` (loose objects so unknown fields survive), the operations and key helpers. `addBot` takes the `Provider` so it can strip the owner setting and compare secrets.
- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit** `feat: registry of bots, pairings and hashed api keys`

---

### Task 5: Registry file, admin key file, seed and upgrade migration

**Files:**
- Create: `packages/store/src/registry/{store,paths,seed}.ts`
- Modify: `packages/store/src/config/{store,index,types}.ts` (split service config from the seed), `packages/store/src/index.ts`
- Test: `packages/store/test/registry/{store,seed}.test.ts`

**Interfaces:**
- Consumes: Task 4 types and `applySeed`.
- Produces:
  ```ts
  /** Port and host; the only service-wide settings left in config.json and the env. */
  export type ServiceConfig = { readonly port: number; readonly host: string }
  export function loadServiceConfig(env: NodeJS.ProcessEnv): ServiceConfig   // throws like loadConfig on a bad port
  /** What the env and config.json say bot 1, pairing 1 and key 1 should be. */
  export type SeedLoad =
    | { readonly kind: 'seed'; readonly provider: Provider; readonly seed: SeedInput }
    | { readonly kind: 'missing'; readonly message: string }  // a required setting is absent
  export function loadSeed(env: NodeJS.ProcessEnv, providers: readonly Provider[]): SeedLoad  // throws on invalid values, like loadConfig
  export function resolveRegistryPath(configPath: string): string
  export function resolveAdminKeyPath(configPath: string): string
  export function resolveBotFiles(configPath: string, botId: string): { readonly directory: string; readonly statePath: string; readonly auditPath: string }
  /** The seed bot's audit file, or the pre-upgrade one next to config.json when there's no registry yet. */
  export function resolveSeedAuditPath(configPath: string): string
  export class RegistryStore {
    constructor(path: string)
    /** Missing file: empty registry. Invalid JSON or schema: throws without quoting the file. */
    load(): Registry
    /** Atomic, 0600. Throws on failure; the caller keeps its previous value. */
    save(registry: Registry): void
  }
  /** Moves state.json and audit.jsonl(.1) from next to config.json into the bot's directory, if there and not already moved. */
  export function migrateLegacyBotFiles(configPath: string, botId: string): void
  /** Reads the admin key file; writes a new key when it's missing or invalid. Returns the key. */
  export function ensureAdminKey(path: string, log: (line: string) => void): string
  export function writeAdminKeyFile(path: string, key: string): void
  /** Client side: JAYPOST_ADMIN_KEY, then the file; same shape and messages as resolveClientToken. */
  export function resolveAdminKey(env: NodeJS.ProcessEnv, path: string): ClientToken
  ```
  Seed fingerprint: `sha256` hex of `JSON.stringify({ provider, settings, token })` where `settings` excludes the owner setting and `token` is the raw `JAYPOST_TOKEN`/`apiToken` (or `null`). `SeedInput.owner` comes from the owner setting; `quietHours`/`mutedUntil` from config.json as strings. `loadConfig` stays for callers that still want the old shape (`resolveOpenApiProvider` in the CLI), built on the same helpers.

- [ ] **Step 1: Write the failing tests**

```ts
test('the registry round-trips through the file with mode 0600', () => {})
test('a corrupt registry throws without quoting the file', () => {
  writeFileSync(path, '{"bots": [ "jpk_secret"')
  expect(() => new RegistryStore(path).load()).toThrow(/registry .* contains invalid JSON/)
  expect(() => new RegistryStore(path).load()).not.toThrow(/jpk_secret/)
})
test('a failed save leaves the old file', () => {})
test('the fingerprint changes with the token and bot token, not with the owner', () => {})
test('a missing bot token is a missing seed, an invalid one throws', () => {})
test('migration moves state and both audit files into bots/b1 once', () => {
  // legacy files present -> moved; second call is a no-op; existing bots/b1 files are never overwritten
})
test('pending requests saved before the upgrade are still found after migration', () => {
  // write a legacy state.json with one request, migrate, new StateStore(resolveBotFiles(..., 'b1').statePath, ...).load()
  // returns that request (Review Focus 2; the daemon test in Task 7 checks it gets expired)
})
test('ensureAdminKey writes a jpa_ key once and returns the same key after', () => {})
test('resolveAdminKey prefers the env var and never echoes the value', () => {})
```

- [ ] **Step 2: Run, expect FAIL** (`npx vp test packages/store/test/registry`)
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit** `feat: registry file, admin key file and seeding from the existing config`

---

### Task 6: One bot serving many paired people

`startBot` stops reading or writing config.json. It gets its people, codes and quiet settings from an injected `BotPeople`, so it stays testable without the registry.

**Files:**
- Modify: `packages/service/src/daemon/bot.ts`
- Create: `packages/service/src/daemon/types.ts` (move `BotOptions`, `RunningBot` here and add `BotPeople`)
- Modify: `packages/service/src/server/{types,server}.ts` (`ApiBot`, `resolveVoters` call)
- Modify: `packages/service/src/daemon/service.ts` (interim `createConfigPeople`, deleted in Task 7)
- Test: `packages/service/test/daemon/bot.test.ts` (new; move the bot-level cases out of `service.test.ts`)

**Interfaces:**
- Consumes: `PairingCodes`, `isCodeShaped` (Task 2), scoped `ApprovalService` and `NotificationService` (Task 3), `resolveBotFiles` (Task 5).
- Produces:
  ```ts
  /** The registry's view of one bot's people, injected so the bot never touches storage. Calls never throw. */
  export type BotPeople = {
    readonly isPaired: (person: string) => boolean
    readonly list: () => readonly string[]
    /** Pending pairing codes by pairing id, read once at start. */
    readonly pendingCodes: () => ReadonlyMap<string, string>
    /** Someone redeemed `pairingId`'s code; the hub records it and saves. */
    readonly claim: (pairingId: string, person: string) => void
    readonly quietHours: (person: string) => { readonly quietHours?: QuietHours; readonly mutedUntil?: Date }
    readonly saveQuiet: (person: string, patch: QuietPatch) => void   // may throw; QuietService reports it
  }
  export type BotOptions = {
    readonly record: BotRecord
    readonly provider: Provider
    readonly directory: string        // from resolveBotFiles
    readonly people: BotPeople
    readonly fatal: (message: string) => void
    readonly log?: (line: string) => void
  }
  export type RunningBot = {
    readonly bot: ApiBot
    readonly codes: PairingCodes      // the hub adds and removes codes at runtime
    readonly recover: () => Promise<void>
    readonly stop: () => Promise<void>
  }
  ```
  `ApiBot` becomes the bot's capabilities only: `service`, `notifications?`, limits, `providerName`, plus
  ```ts
  /** Provider, display name and provider status fields (Telegram's `bot`), without pairing state. */
  readonly describe: () => { readonly provider: string; readonly displayName: string } & Readonly<Record<string, string>>
  /** How to redeem `code` on this bot; absent for providers that don't pair. */
  readonly pairingInstructions?: (code: string) => string
  /** Voter ids for /vote; without `voters`, `person` (the key's person), or noOwner when undefined. */
  readonly resolveVoters: (voters: readonly string[] | undefined, person: string | undefined) => VoterIds
  /** Settles the open questions of each key, for revocation. */
  readonly rejectForKeys: (keyIds: readonly string[]) => void
  ```
  The interim `status` and `recipient` stay until Task 7, now computed from `people` (recipient: the first listed person; status: paired when anyone is, else the first pending code). `resolveVoters` in core changes to `resolveVoters(provider, person: string | undefined, voters)`; the server passes `bot.recipient()` as the person for now.
- Interim, in `service.ts`: `createConfigPeople(config: Config, configPath: string, generateCode: () => string): BotPeople` reproduces today's single owner (owner from settings; one pending code `p1` when unpaired, logged with the pairing instructions; `claim` saves the owner to config.json and logs on failure; quiet from and to config.json). `startService` builds the bot with it and `resolveBotFiles`'s directory set to the config's own directory, so every existing `service.test.ts` case keeps passing unchanged. This is throwaway wiring; its value is proving the bot rewrite didn't change single-owner behavior.
- Handlers built here: `isPaired`/`listPaired` from `people`; `pair(senderId, text)` returns `notPairing` when `people.isPaired(senderId)` and the text (after `/start`) isn't code-shaped, else `codes.attempt`, calling `people.claim` on success and logging `paired <person> on <bot id>` (never the code); `command(name, argument, senderId)` resolves the person (`senderId`, or `LOCAL_PERSON` for providers that don't pair) and runs `runOwnerCommand(service, name, argument, recipientFor(person), ...)` then that person's `QuietService` (one per person, created lazily from `people.quietHours`, saving through `people.saveQuiet`). `recipientFor(LOCAL_PERSON)` is `undefined`, so terminal questions (sent without recipient) match. The notification `QuietSource` asks the recipient's `QuietService`.

- [ ] **Step 1: Write the failing tests** (fake providers from `@jaypost/testing`, an in-memory `BotPeople`)

```ts
test('a pending code pairs a new person and the hub is told which pairing', async () => {
  const claim = vi.fn()
  const { runtime } = await start({ people: createPeople({ codes: new Map([['p2', 'K7QM4XPD']]), claim }) })
  expect(runtime.handlers?.pair?.('u2', 'K7QM4XPD')).toBe('paired')
  expect(claim).toHaveBeenCalledWith('p2', 'u2')
})

test("a paired person's chat text is not counted as a wrong code", async () => {
  // people.isPaired('u1') is true: pair('u1', 'hello') -> 'notPairing'; five of those, then the
  // right code -> 'paired'
})

test('/pending and /cancel from one person leave the other person alone', async () => {})
test('/mute is per person: notifications to A are silent, to B ping', async () => {})
test('without voters, a vote goes to the given person', async () => {})
test('a terminal-like bot runs commands for the local person over all its questions', async () => {})
test('rejected credentials throw with the provider reason', async () => {})  // kept from service.test.ts
```

- [ ] **Step 2: Run, expect FAIL** (`npx vp test packages/service/test/daemon/bot.test.ts`)
- [ ] **Step 3: Implement.** State and audit files go to `options.directory`. Prefix every log line with the bot id: `log(\`[${record.id}] ${line}\`)`.
- [ ] **Step 4: Run, expect PASS** (`npx vp test packages/service packages/core`, existing `service.test.ts` included, and `npx vp check`).
- [ ] **Step 5: Commit** `feat: one bot serves every person paired on it`

---

### Task 7: Hub, key routing, bot supervision and the service entry point

**Files:**
- Create: `packages/service/src/daemon/{hub,supervisor}.ts`
- Modify: `packages/service/src/daemon/{service,index}.ts`, `packages/service/src/server/{types,router,server,index}.ts`, `packages/service/src/index.ts`
- Modify: `packages/protocol/src/schema.ts` (`statusInfoSchema` optional fields)
- Test: `packages/service/test/daemon/{supervisor,service}.test.ts` (rewrite `service.test.ts` around `startService`), `packages/service/test/server/server.test.ts`

**Interfaces:**
- Consumes: Tasks 4 to 6.
- Produces:
  ```ts
  /** What a call reaches. `bot` is undefined while its bot isn't running (the API answers 503). */
  export type BotRoute =
    | { readonly kind: 'key'; readonly caller: RequestCaller; readonly person: string | undefined
        readonly bot: ApiBot | undefined; readonly status: () => StatusInfo }
    | { readonly kind: 'unauthorized'; readonly reason: 'missing' | 'wrong' }
  export type BotRouter = {
    readonly route: (authorization: string | undefined) => BotRoute     // never throws
    readonly openApi: () => Omit<OpenApiOptions, 'port'>
  }
  export type BotState =
    | { readonly kind: 'starting' }
    | { readonly kind: 'running'; readonly running: RunningBot }
    | { readonly kind: 'failed'; readonly reason: string }
  export class BotSupervisor {
    constructor(options: { readonly start: () => Promise<RunningBot>; readonly log: (line: string) => void
      readonly initialDelayMs?: number; readonly maxDelayMs?: number })   // defaults 5_000 and 300_000
    get state(): BotState
    /** Starts now; on a throw or a later `fail`, retries with doubling backoff until stopped. */
    run(): void
    /** Called from the bot's `fatal`: stops the runtime, marks it failed, schedules a retry. */
    fail(reason: string): void
    stop(): Promise<void>
  }
  export class Hub { /* owns RegistryStore, the registry in memory, one BotSupervisor per bot */
    constructor(options: HubOptions)   // { store, registry, providers, configPath, adminKey, adminKeyPath, now?, generateCode?, log? }
    start(): void                      // a supervisor per stored bot
    get router(): BotRouter
    recover(): Promise<void>           // every running bot's recover
    stop(): Promise<void>
    /** Same outcome kinds as Task 4's createKey; adds the code to the running bot when pending. */
    createKey(target: KeyTarget, details: { readonly label?: string; readonly externalId?: string }): CreatedKey | NotFound
    /** Removes the key and rejects its open questions. */
    revokeKey(keyId: string): { readonly kind: 'revoked' } | NotFound
  }
  // CreatedKey = { kind: 'created'; id; key (plaintext); pairing: PairingRecord; code?: string; instructions?: string }
  // Every mutation: apply the Task 4 operation, save, and only then swap the in-memory registry and
  // update running bots (codes, revocations, starts, stops). A save error throws and changes nothing.
  // Task 8 adds the remaining admin operations the same way.
  export type ServiceOptions = {
    readonly version: string; readonly configPath: string; readonly providers: readonly Provider[]
    readonly seed: SeedLoad; readonly log?: (line: string) => void
    readonly generateCode?: () => string; readonly now?: () => Date
  }
  export function startService(options: ServiceOptions): Promise<RunningService>  // RunningService gains `hub`
  ```
  `statusInfoSchema` gains optional `key`, `pairing`, `state` (`'starting' | 'running' | 'failed'`) and `error` on both variants. `/status` for a key answers `{ paired, key, pairing, state, ...bot.describe(), limits }`, plus `code` (formatted) and `instructions` while the pairing is pending, plus `error` when failed. A failed bot still answers `/status` from the registry.
- Server changes: every guarded route gets the `BotRoute`; `readBody` answers 503 `{ error: 'bot unavailable' }` when `bot` is undefined and 503 `not paired` when `person` is undefined; `/request`, `/request/async` and `/vote` set `caller` (and `recipient: person` for asks, unless the provider doesn't pair, then leave it unset); `/request/:id` and `DELETE` pass `caller.key`; `/notify` passes the person; `/vote` passes the person to `resolveVoters`; new `GET /log?since&project&limit` answers `{ entries, skippedCount }` for the caller's key only (`unkeyedAs` = the key when it's the seed key on the seed bot). The 502 log line names the bot: `via b2 (telegram)`.
- Routing: hash the bearer token with `hashKey`, look it up with `findKeyByHash`. No Authorization header on a registry whose `seed.isOpen` reaches the seed key; any other missing header is `missing`; a token that matches no key, or the admin key, is `wrong`.
- `runService(version, env)`: `loadServiceConfig` (exit 1 on error), `RegistryStore.load` (exit 1 on corrupt), `loadSeed` (exit 1 on invalid; `missing` with an empty registry exits 1 with its message, as today; `missing` with bots is fine), `migrateLegacyBotFiles` when the seed creates bot 1 on an empty registry, `applySeed` and save, `ensureAdminKey`, `startService`, listen, then `recover`. Log `listening on host:port (<n> bots, <m> keys)`. A provider's `fatal` no longer exits the process; it goes to that bot's supervisor.

- [ ] **Step 1: Write the failing supervisor tests** (fake timers via `vi.useFakeTimers()`)

```ts
test('a bot that fails to start is retried with doubling backoff', async () => {
  // start rejects twice then resolves: states failed (5 s), failed (10 s), running
})
test('fatal stops the runtime and retries; stop cancels the retry', async () => {})
```

- [ ] **Step 2: Write the failing service tests** (real HTTP on port 0, fake providers, temp config dir)

```ts
test('an upgraded install keeps its token, owner and quiet hours as key 1 on bot 1', async () => {
  // config.json with fakeKey, fakeOwner 'u1', apiToken T, quietHours; no registry
  // -> /status with T: { paired: true, key: 'k1', pairing: 'p1', state: 'running', ... }
  // -> a request goes to recipient 'u1'; registry.json has bot b1, pairing p1 (person u1, quietHours), key k1 (hash of T)
})
test('a request pending before the upgrade is expired after it', async () => {})       // Review Focus 2
test('two keys on one pairing share the person; a key on another pairing reaches its own', async () => {})
test("a key can't read or cancel another key's background question", async () => {    // Review Focus 4
  // POST /request/async with key A -> id; GET /request/id and DELETE with key B -> 404 unknown request
})
test('an unpaired key gets 503 and its code from /status', async () => {})
test('GET /log only returns the caller key lines', async () => {})
test('a tokenless install treats no token as key 1 and a wrong token as 401', async () => {})
test('the admin key is refused on question routes', async () => {})
test('a bot with rejected credentials shows failed in /status and the others keep working', async () => {})
test('restarting with the same env keeps admin changes', async () => {
  // revoke k1 through the hub, restart startService with the same seed -> k1 still revoked
})
test('a registry write failure leaves memory unchanged', async () => {               // Review Focus 3
  // make registry.json's directory read-only (skip when running as root), call hub.createKey ->
  // throws; the file and hub.router are unchanged
})
```
Keep the existing service tests that still apply (state recovery, notifications restore, audit next to the bot, token on the API), rewritten to use `startService` with a seed.

- [ ] **Step 3: Run, expect FAIL** (`npx vp test packages/service`)
- [ ] **Step 4: Implement** `BotSupervisor`, `Hub` (pairing claims save and log on failure but keep the claim in memory, as today's owner save does), `createHubRouter` replacing `createSingleBotRouter`, the server changes and `runService`. `openApi()` reports the smallest limits across stored bots' providers, or core's defaults with no bots.
- [ ] **Step 5: Run, expect PASS** (`npx vp test packages/service packages/core packages/store`)
- [ ] **Step 6: Commit** `feat: serve every stored bot and route each call by its api key`

---

### Task 8: Admin routes

**Files:**
- Create: `packages/protocol/src/admin.ts` (zod schemas and types for admin bodies and responses)
- Create: `packages/service/src/server/admin.ts`
- Modify: `packages/service/src/server/{server,openapi,types}.ts`, `packages/service/src/daemon/hub.ts`, `packages/protocol/src/index.ts`
- Test: `packages/service/test/server/admin.test.ts`, `packages/service/test/server/openapi.test.ts`

**Interfaces:**
- Consumes: `Hub`, `createKey`, `revokeKey` (Task 7), Task 4 operations.
- Produces: `createApiServer(router: BotRouter, admin?: AdminApi)`. `AdminApi` (in `server/types.ts`, implemented by `Hub`) has `isAdmin(authorization: string | undefined): boolean` plus one method per row below, named after the CLI verbs (`listBots`, `addBot`, `removeBot`, `listPairings`, `createPairing`, `resetPairing`, `removePairing`, `listKeys`, `createKey`, `updateKey`, `revokeKey`, `readLog`, `rotateAdminKey`). Each takes the parsed body or query and returns the response body or `{ kind: 'invalid' | 'notFound' | 'duplicate'; error: string }`; `addBot` and `removeBot` are async. Routes all require `Authorization: Bearer <admin key>`, and an API key gets 401 like a missing one.

| Route | Body | Success |
|---|---|---|
| `GET /admin/bots` | | `200 { bots: [{ id, provider, label?, displayName?, state, error?, pairingCount, keyCount }] }` |
| `POST /admin/bots` | `{ provider, settings: Record<string,string\|number>, label? }` | `201 { bot }`; `400` unknown provider, missing or invalid setting, rejected credentials (provider reason); `409` duplicate |
| `DELETE /admin/bots/:id` | | `200 { removedKeys: [...] }` (runtime stopped, questions of removed keys rejected) |
| `GET /admin/pairings?bot=` | | `200 { pairings: [{ id, bot, person?, state: 'paired'\|'pending', code?, keys: [ids] }] }` |
| `POST /admin/pairings` | `{ bot }` | `201 { pairing, code?, instructions? }` (approver invite) |
| `POST /admin/pairings/:id/reset` | | `200 { pairing, code, instructions? }` (person removed, keys stay) |
| `DELETE /admin/pairings/:id` | | `200 { removedKeys }` |
| `GET /admin/keys?bot=&pairing=` | | `200 { keys: [{ id, pairing, bot, label?, externalId?, createdAt }] }` (never hashes) |
| `POST /admin/keys` | exactly one of `{ bot }`, `{ pairing }`, `{ sameAsKey }`, plus `label?`, `externalId?` | `201 { id, key, pairing, code?, instructions? }`; the plaintext `key` appears only here |
| `PATCH /admin/keys/:id` | `{ label?: string\|null, externalId?: string\|null }` | `200 { key }` |
| `DELETE /admin/keys/:id` | | `200 {}` (its open questions rejected with their timeout option) |
| `GET /admin/log?bot=&pairing=&key=&since=&project=&limit=` | | `200 { entries (with bot), skippedCount }` |
| `POST /admin/admin-key` | | `200 { adminKey }`; the old key stops working at once and the file is rewritten |

Unknown ids answer `404 { error: 'unknown key "k9"' }` (ids aren't secret). Labels and external ids are capped at 200 characters. `settings` is parsed with each provider setting's `parse`; the owner setting is rejected (`400 settings may not set the owner`); errors name the setting's `description`, never its value.

- [ ] **Step 1: Write the failing tests** (real server, fake providers, admin key from the hub)

```ts
test('an api key gets 401 on every admin route', async () => {})
test('a created key works at once for an existing pairing and waits for pairing for a new one', async () => {})
test('a bot added at runtime serves its first key without a restart', async () => {})
test('rejected credentials answer 400 without the token in the body or logs', async () => {  // Review Focus 5
  const log = vi.fn()
  const response = await post('/admin/bots', { provider: 'fake', settings: { fakeKey: 'secret-123' } })
  expect(response.status).toBe(400)
  expect(JSON.stringify(await response.json())).not.toContain('secret-123')
  expect(JSON.stringify(log.mock.calls)).not.toContain('secret-123')
})
test('a malformed admin body is a 400 that does not quote it', async () => {})
test('revoking a key cancels its open question with the timeout option', async () => {})
test('removing a pairing revokes its keys', async () => {})
test('a second bot with the same credentials is a 409', async () => {})
test('rotating the admin key invalidates the old one and rewrites the file', async () => {})
test('admin log filters by bot, pairing and key', async () => {})
test('the openapi document lists the admin routes under the adminKey scheme', async () => {})
```

- [ ] **Step 2: Run, expect FAIL** (`npx vp test packages/service/test/server`)
- [ ] **Step 3: Implement** the schemas, the admin plugin (its own `onRequest` guard comparing `hashKey(presented)` to the hub's admin key hash with `timingSafeEqual`), the hub operations and the OpenAPI entries (`GET /log`, the new `/status` fields, admin routes tagged `admin` with an `adminKey` bearer scheme). Regenerate `docs/openapi.yaml` with `pnpm openapi`.
- [ ] **Step 4: Run, expect PASS** (`npx vp test packages/service packages/protocol`)
- [ ] **Step 5: Commit** `feat: admin http routes for bots, pairings, keys, logs and the admin key`

---

### Task 9: Admin client and CLI admin commands

**Files:**
- Create: `packages/client/src/admin.ts` (`AdminCaller`), export from `packages/client/src/index.ts`
- Create: `apps/cli/src/commands/{admin,admin-endpoint,bot,key,pairing}.ts`
- Modify: `apps/cli/src/cli.ts`, `apps/cli/src/commands/{index,types}.ts`
- Modify: `packages/install/src/install/{types,native,systemd,launchd,compose,quadlet}.ts` (`Target.readAdminKey`)
- Test: `packages/client/test/admin.test.ts`, `apps/cli/test/commands/admin.test.ts`, install target tests

**Interfaces:**
- Consumes: protocol admin schemas (Task 8), `resolveAdminKey`, `RegistryStore` and `addBot` (Tasks 4, 5).
- Produces:
  ```ts
  export class AdminCaller {
    constructor(options: { readonly endpoint: ServiceEndpoint; readonly adminKey: string; readonly fetchTimeoutMs?: number })
    listBots(): Promise<AdminResult<BotsBody>>
    addBot(body: AddBotBody): Promise<AdminResult<AddedBotBody>>
    removeBot(id: string): Promise<AdminResult<RemovedBody>>
    listPairings(filter): ...; createPairing(body): ...; resetPairing(id): ...; removePairing(id): ...
    listKeys(filter): ...; createKey(body): ...; updateKey(id, body): ...; revokeKey(id): ...
    readLog(filter): ...; rotateAdminKey(): ...
  }
  export type AdminResult<T> = { readonly kind: 'ok'; readonly value: T } | Failure   // Failure from caller.ts
  // Target gains:
  /** The admin key the service wrote; containers read it with `jaypost admin-key show` inside. */
  readonly readAdminKey: (record: InstallRecord) => Promise<string>
  ```
  `resolveAdminEndpoint(env, paths, targets)` in `admin-endpoint.ts`: with `JAYPOST_URL`, that URL plus `JAYPOST_ADMIN_KEY` (error `JAYPOST_URL is set, so set JAYPOST_ADMIN_KEY too` when missing); else the local install's port with `target.readAdminKey(record)`; with no install, `127.0.0.1` and `JAYPOST_PORT`/config port with the key from `resolveAdminKeyPath(resolveConfigPath(env))`.

Commands (commander subcommands; every one prints `--json` output when given, else a short table):
- `jaypost bot add [--provider <name>] [--label <text>]`: picks the provider and prompts its settings with `selectProvider`/`resolveProviderSettings` like `init` (owner setting never asked), then `POST /admin/bots`. When the local service doesn't answer (connection refused) and the install is native or absent, it adds the bot straight to the registry file after `provider.setup.checkCredentials`, and says the service picks it up on its next start. For a stopped container install it says to start the service first.
- `jaypost bot list`, `jaypost bot remove <id>` (confirms first; says how many keys go with it).
- `jaypost key create (--bot <id> | --pairing <id> | --same-as <key id>) [--label <text>] [--external-id <id>]`: prints the key once with a line saying it isn't shown again, then the pairing code and instructions when pending.
- `jaypost key list [--bot <id>] [--pairing <id>]`, `jaypost key label <id> [--label <text>] [--external-id <id>]` (empty string clears), `jaypost key revoke <id>`.
- `jaypost pairing create --bot <id>`, `jaypost pairing list [--bot <id>]`, `jaypost pairing remove <id>` (confirms; revokes its keys).
- `jaypost admin-key rotate` (prints the new key; locally the service already rewrote the file); hidden `jaypost admin-key show` prints the key file for container targets.

- [ ] **Step 1: Write the failing tests.** `AdminCaller` against a real `startService` server: each method maps 2xx to `ok`, 401 to `unauthorized`, 404/409/400 to a failure carrying the server's `error`. CLI tests drive the command functions with injected deps (as `manage.test.ts` does):

```ts
test('key create prints the key once and the pairing code when pending', async () => {})
test('JAYPOST_URL without JAYPOST_ADMIN_KEY fails with a hint and no request', async () => {})
test('bot add writes the registry directly when the local service is down', async () => {})
test('a container install reads the admin key through the target', async () => {})
```

- [ ] **Step 2: Run, expect FAIL** (`npx vp test packages/client apps/cli/test/commands/admin.test.ts packages/install`)
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit** `feat: cli admin commands for bots, keys, pairings and the admin key`

---

### Task 10: Existing commands on the new store

**Files:**
- Modify: `apps/cli/src/commands/{owner,audit,log,reset-owner,status,init}.ts`, `apps/cli/src/cli.ts` (`resolvePort`, `log` flags)
- Modify: `packages/install/src/install/{native,systemd,launchd}.ts` (`readAuditLog` via `resolveSeedAuditPath`; purge also removes `registry.json`, `admin-key` and `bots/`)
- Test: `apps/cli/test/commands/{owner,log,status,init}.test.ts` (and a reset-owner test), `packages/install/test/install/*.test.ts`

**Interfaces:**
- Consumes: `resolveSeedAuditPath`, `RegistryStore`, `resetPairing` (Tasks 4, 5), `AdminCaller` and `resolveAdminEndpoint` (Task 9).
- Behavior:
  - `owner get` prints the seed pairing's person (falls back to config.json before the registry exists). `owner clear` resets the seed pairing in the registry file (fresh code) and still deletes the owner key from config.json.
  - `audit dump` prints the seed bot's audit files (`resolveSeedAuditPath`).
  - `reset-owner`: reads `/status` with key 1 to learn its pairing, then `POST /admin/pairings/:id/reset` and waits for pairing as today, with no restart. If the service isn't running, it restarts it first. Keep its prompts and exit codes.
  - `log`: new `--bot`, `--pairing`, `--key` and `--all`; any of them, or a set `JAYPOST_URL`, reads through the API (`/admin/log` when an admin key resolves, else `GET /log` with the client token); otherwise it reads the install's files as today (now the seed bot's).
  - `status`: adds `Key: k1 (pairing p1)` and, when the bot failed, `Bot: failed (<error>)`.
  - `init`: unchanged flow; the service seeds or re-seeds from what init writes. Its closing lines add `Admin key: <path>` for native targets or `Admin commands: jaypost key create --help` for containers.
  - `resolvePort` in `cli.ts` uses `loadServiceConfig`.

- [ ] **Step 1: Write the failing tests**

```ts
test('owner clear resets pairing 1 in the registry and keeps other pairings', () => {})
test('audit dump prints bot 1 lines after the upgrade moved them', () => {})
test('log --key k2 goes through the admin route with the local admin key', async () => {})
test('log without flags still reads the install files', async () => {})
test('reset-owner resets pairing 1 through the admin route and waits for the new pairing', async () => {})
test('status shows the key and pairing ids', async () => {})
test('native purge removes the registry, admin key and bot directories', async () => {})
```

- [ ] **Step 2: Run, expect FAIL** (`npx vp test apps/cli packages/install`)
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the whole suite, expect PASS** (`npx vp test` and `npx vp check`)
- [ ] **Step 5: Commit** `feat: owner, log, status and reset-owner work on the registry`

---

### Task 11: Docs and changeset

**Files:**
- Create: `docs/hosting.md` (running jaypost for several people: VM, reverse proxy for TLS, admin key, adding bots, handing out keys, CI workflows sharing a bot)
- Modify: `docs/http-api.md` (`GET /log`, new `/status` fields, admin routes, the no-token 401 change), `docs/commands.md`, `docs/pairing.md`, `docs/question-log.md` (`key`/`pairing` fields, files under `bots/<id>/`), `docs/security.md` (hashed keys, admin key file, exposure), `docs/README.md` (link the new page), `README.md` if it lists commands
- Create: `.changeset/hosted-service.md` (minor)

- [ ] **Step 1: Write the docs.** Plain voice, no em-dashes, match the existing pages' tone. State what wasn't built (no TLS, no quotas, no per-key voter lists).
- [ ] **Step 2: Check** the site's snippet and dist checks still pass: `npx vp test apps/site`, and `npx vp check`.
- [ ] **Step 3: Commit** `docs: hosted service, admin commands and api keys`

---

## Decisions this plan adds to the spec

- Storage is JSON: `registry.json`, `admin-key` and `bots/<id>/{state.json,audit.jsonl}` next to `config.json` (the data volume for containers). Upgrades move the old state and audit files into `bots/b1/`.
- Ids are `b<n>`, `p<n>`, `k<n>` from counters that never go back, so "bot 1, pairing 1, key 1" are literally `b1`, `p1`, `k1` after an upgrade. New keys look like `jpk_<43 chars>`, the admin key `jpa_<43 chars>`.
- Re-seeding is triggered by a fingerprint of what init writes (provider, bot settings without the owner, API token). A restart with the same env changes nothing; running `init` with a new token or bot does. Running `init` again with the same values won't bring back a key 1 the admin revoked.
- The admin key file is the source of truth: the service reads it at start and writes a new one when it's missing. Containers' host CLI reads it with `jaypost admin-key show` inside the container, then calls the admin routes.
- A paired person's chat text only counts as a pairing attempt when it looks like a code, so chatting never burns their wrong-code allowance.
- The wrong-code reply no longer says the bot isn't paired.
- `reset-owner` goes through `POST /admin/pairings/:id/reset` instead of editing files and restarting.
