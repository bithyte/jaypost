# Owner conversation module design

## Intent

The provider seam (`ProviderRuntime`, src/provider/types.ts:66-96) is drawn around the whole chat runtime, so everything about talking to the owner that has nothing to do with Telegram or Discord got written twice, once in each adapter. `routeReply` is the same algorithm in src/telegram/adapter.ts:170-205 and src/discord/routing.ts:77-112; the differences are the owner/DM predicate, the open-question key (`<chatId>:<messageId>` vs message id) and number vs string ids. The same goes for `routeTap` (adapter.ts:70-84, routing.ts:55-69), `describeReplyRoute` (adapter.ts:394-409, routing.ts:115-130), `handlePairingMessage` (adapter.ts:464-484, routing.ts:136-153), the `<id>:<n>` and `dismiss/<id>` payload codecs (adapter.ts:52-65, routing.ts:23-36), the text hint choice (adapter.ts:258-260, src/discord/messenger.ts:72-73), the `Owner`, `OpenQuestion(s)`, `Tap`, `Reply`, `Dismiss`, `ReplyRoute`, `TapRoute` types in both types.ts files, and seven byte-identical copy constants (src/telegram/constants.ts:6,16-26; src/discord/constants.ts:23,29-39).

The copies have started to drift, and roughly 20 `routeReply` tests plus the tap and pairing tests exist almost verbatim in test/telegram/adapter.test.ts and test/discord/routing.test.ts.

I want one deep module that owns the conversation with the owner: who the owner is, which questions are open, what an incoming message or tap means, the button payloads, pairing, and the bot's refusal copy. The adapters shrink to normalizing platform events in and rendering/sending out.

## Goals

- One module, `src/conversation/`, whose interface takes a platform-free message or tap and returns what the adapter should do next. All routing rules live there once, with locality: changing a reply rule touches one file and one test file.
- Both adapters (Telegram, Discord) use it for open-question bookkeeping, reply/tap/dismiss routing, pairing replies, payload encode/decode and the text hint.
- One copy of each user-facing string.
- Every drift between the two copies resolved explicitly (table below).
- Tests for those rules exist once, at the new interface, and the per-adapter copies are deleted.

## Non-goals

- Message rendering: Telegram entities and the 400 fallback (adapter.ts:105-163), Discord markdown (src/discord/markdown.ts). Stays in the adapters.
- Platform side effects of an outcome: deleting the dismissed message (and Telegram's replied-to document, adapter.ts:359-380), Discord's three-second acknowledge, Discord's rows of five (`toButtonRows`, routing.ts:39-49). The module says "dismissed"; the adapter does the deleting.
- Owner slash commands. That's 2026-10-21-owner-command-registry-design.md; it can use this module's `isOwner` instead of Telegram's `isOwnerCommand` (adapter.ts:509) and Discord's `isOwner` (src/discord/events.ts:32).
- A narrow seam over grammY. That's 2026-10-21-telegram-client-seam-design.md.
- Changing `ProviderRuntime` or moving Telegram facts out of core. That's 2026-10-21-provider-runtime-contract-design.md.
- Rewording any copy.

## Anti-goals

- A ports-and-adapters seam for the conversation. It's in-process logic with one implementation and nothing to fake; one adapter would be a hypothetical seam. Tests call it directly.
- Platform types leaking in: no grammY or discord.js types, no numeric ids, no chat types. If the module needs a platform fact, the adapter turns it into a boolean or an opaque string first.
- A shallow module that just re-exports today's functions with the platform parameters still in them (`botId`, `chatType`, `ownerId` as arguments). The depth comes from the module holding the owner and the open questions itself.
- Compatibility re-exports from the adapters' index.ts. None of these are public (src/index.ts only exports the client and format helpers), so old names get deleted, not aliased.

## Decided by me (owner can override)

- Location: `src/conversation/`, not inside `src/provider/`. src/provider/registry.ts:1-2 imports both adapters at runtime, so a value import from the adapters back into `src/provider/` would make a module cycle. `src/conversation/` imports only types from `provider` and `format` plus the `FormattedText` helpers.
- It's a class, `OwnerConversation`, holding the owner id and the open-question map in `#private` fields, like `Pairing` and `ApprovalService` do. It replaces both `Owner` cells and both `OpenQuestions` maps. I'm not reusing the name `OpenQuestions` anywhere public because src/mcp/questions.ts:9 already exports a class with that name.
- Handlers are passed per call, not to the constructor. The messenger needs the conversation when the runtime is created (src/telegram/runtime.ts:35, src/discord/runtime.ts:126), but handlers only arrive in `start` (telegram/runtime.ts:56, discord/runtime.ts:159).
- Owner and sender ids are strings in the module. The daemon already treats sender ids as strings and parses them back through the owner setting (src/daemon/service.ts:104-112). Telegram converts at its edge.
- Open-question keys are opaque strings made by the adapter. Telegram keeps `<chatId>:<messageId>` because its message ids are per chat; Discord keeps the message id. The incoming message carries `replyTo.key` built the same way, plus `replyTo.fromSelf` (the adapter compares against its own bot id), so `botId` leaves the routing code.
- `receive` runs reply routing and then pairing in one call, in today's order: non-DM and bot senders are dropped before either (as src/discord/events.ts:160 does), an `'ignored'` route falls through to pairing only while pairing is on. On `'paired'` the module sets its own owner and returns the new id so Telegram can set the command menu (telegram/runtime.ts:65-68).
- Drift resolutions:

| Drift | Telegram today | Discord today | Module | Visible? |
| --- | --- | --- | --- | --- |
| Choice payload pattern | `^([^:]+):(\d+)$` (telegram/constants.ts:4) | `^([^:/]+):(\d+)$` (discord/constants.ts:19) | Discord's | No: ids are UUIDs (src/approval/service.ts:52, src/notify/service.ts:30), and `dismiss/a:1` ends as "Expired" either way |
| Bot senders | not checked in `routeReply` | ignored (routing.ts:84) | ignored | No: in a Telegram private chat the other side can't be a bot. Adapter fills `fromBot` from `from.is_bot` |
| Pairing and Expired copy | inline literals (adapter.ts:387,478,481) | constants (discord/constants.ts:41-46) | constants | No, same strings |
| Taps outside a DM | not checked (adapter.ts:354-391) | acknowledged and ignored (events.ts:67-72) | ignored | Probably not, see open questions |
| `/start` prefix on pairing text | stripped (adapter.ts:474) | not stripped (routing.ts:144) | stripped for both | Yes, see open questions |

## Constraints

- Payload formats stay `<id>:<optionIndex>` and `dismiss/<id>`, so buttons on messages sent before the upgrade still work.
- Telegram callback data is at most 64 bytes; the module's payloads must fit that with a UUID id (Discord's limit is 100).
- Copy strings stay byte-identical.
- The module never throws; `receive` calls `reply` at most once and `tap` calls `answer` or `dismiss` at most once.
- Repo formatting: no semicolons, single quotes, width 100. Tests use `vite-plus/test` like the rest of the suite.
- `vp test` and `vp check` (the `test` and `check` scripts) pass after every migration step.

## Proposed interface

```ts
// src/conversation/types.ts
/** One incoming chat message in platform-free terms; the adapter fills it from its event. */
export type ConversationMessage = {
  readonly senderId: string | undefined
  readonly fromBot: boolean
  readonly isDirect: boolean
  readonly text: string | undefined
  /** `key` is the adapter's open-question key for the replied-to message. */
  readonly replyTo: { readonly key: string; readonly fromSelf: boolean } | undefined
}

export type ConversationTap = {
  readonly senderId: string | undefined
  readonly isDirect: boolean
  readonly payload: string | undefined
}

/** What the adapter does next; `text` is the bot's answer. 'refused' replies to the message. */
export type MessageOutcome =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'answered' }
  | { readonly kind: 'refused'; readonly text: string }
  | { readonly kind: 'paired'; readonly ownerId: string; readonly text: string }
  | { readonly kind: 'wrongCode'; readonly text: string }

export type TapOutcome =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'answered' }
  | { readonly kind: 'expired'; readonly text: string }
  | { readonly kind: 'dismissed' }

export type ConversationHandlers = Pick<RuntimeHandlers, 'answer' | 'reply' | 'dismiss' | 'pair'>

// src/conversation/conversation.ts
/** The owner, their open questions, and what each message or tap means. Never throws. */
export declare class OwnerConversation {
  constructor(ownerId: string | undefined)
  get ownerId(): string | undefined
  isOwner(senderId: string | undefined, isDirect: boolean): boolean
  /** Call after the platform accepted the send; `forget` in finalize, even if the edit fails. */
  track(key: string, id: string, allowText: boolean): void
  forget(key: string): void
  receive(message: ConversationMessage, handlers: ConversationHandlers): MessageOutcome
  tap(tap: ConversationTap, handlers: ConversationHandlers): TapOutcome
}

// src/conversation/payload.ts
export declare function formatChoicePayload(id: string, optionIndex: number): string
export declare function formatDismissPayload(id: string): string
/** Appends the reply hint when `allowText`; which hint depends on `hasButtons`. */
export declare function withTextHint(
  message: FormattedText,
  hasButtons: boolean,
  allowText: boolean,
): FormattedText
```

`DISMISS_LABEL` is exported from `src/conversation/constants.ts` with the rest of the copy. Payload parsing stays private; `tap` is the only reader.

## Tests

- New test/conversation/conversation.test.ts at the interface above: the 20 `routeReply` cases once (test/telegram/adapter.test.ts:764-911 and test/discord/routing.test.ts:110-263 are the same list, with Telegram's group chat and channel post cases folding into `isDirect: false` and `senderId: undefined`), each refusal's copy, tap cases (owner, stranger, unpaired, malformed, expired, dismiss never a choice, dismiss from a stranger, outside a DM), pairing cases (right, wrong, blocked, after pairing, not a DM, bot, no text, trimmed, `/start` and `/start@bot` stripped), `ownerId` after pairing, and `track`/`forget`.
- New test/conversation/payload.test.ts: both formats, the 64-byte fit with a UUID, `withTextHint` for the four combinations.
- Delete test/discord/routing.test.ts once its `toButtonRows` tests (lines 32-43) move next to wherever `toButtonRows` lands.
- Delete from test/telegram/adapter.test.ts: the payload format tests (34-39, 382-395), `routeTap` (41-63, 472-476), pure pairing (490-556), `isOwnerCommand` (625) if the registry spec hasn't already taken it, and `routeReply` (764-911).
- Keep and slim the adapter handler tests to normalization and side effects: Telegram reply/tap/pairing handlers (one test per outcome kind, not per route; the five-case `test.each` at line 977 becomes one refusal case), Discord test/discord/events.test.ts (acknowledge, delete, logged failures). test/telegram/runtime.test.ts:104-118 asserts handler registration order and changes when reply and pairing become one handler.
- If 2026-10-21-telegram-client-seam-design.md lands first, the slimmed Telegram handler tests go against its fake instead of the hand-built `bot.on` stubs.

## Migration steps

1. Add `src/conversation/` (constants, types, payload, `OwnerConversation`, index.ts) and its two test files. Nothing uses it yet.
2. Move Discord onto it: the runtime builds an `OwnerConversation` from `settings.ownerId`; the messenger uses `track`/`forget`, `formatChoicePayload`, `formatDismissPayload`, `withTextHint`; events.ts maps `IncomingMessage`/`IncomingInteraction` to the conversation types and acts on the outcome. `EventContext` loses `owner`, `openQuestions` and `onPaired`. Delete routing.ts (keeping `toButtonRows` in the adapter), the duplicate constants and types, their index.ts exports, and routing.test.ts.
3. Move Telegram onto it the same way: one `message` handler replaces `registerReplyHandler` and `registerPairingHandler`, `registerTapHandler` calls `tap`, the `Owner` cell goes, ids convert at the edge. Delete `routeReply`, `routeTap`, `handlePairingMessage`, the codecs, `formatMessageKey` if only the adapter needs it privately, the duplicate constants and types, their exports, and the tests listed above.
4. Grep both adapters and test/ for the deleted names and the old copy literals; nothing left but adapter wiring.

## Open questions

- `/start` on Discord: stripping it for both means a Discord user who types `/start ABCD-EFGH` as plain text now pairs, where today it counts as a wrong guess. I think that's harmless and keeps one rule, but it's a visible change. The alternative is a `stripStartCommand` flag the Telegram adapter sets, which puts a Telegram fact back in the module.
- Taps outside a DM on Telegram: the module ignores them, as Discord does. The bot only ever sends to the owner's private chat, so I don't think a real tap can arrive from elsewhere, but I'm not sure whether a forwarded copy of a question keeps working buttons. If it does, the owner tapping one in a group would stop working.

## Left to the builder

- File split inside `src/conversation/` and exact outcome kind names.
- Whether Telegram converts the owner id with `Number()` before grammY calls (keeps the numeric assertions in today's tests) or passes the string.
- Where `toButtonRows` lands in the Discord adapter.
- Whether Telegram's merged message handler still calls `next()` on `'ignored'` (nothing is registered after it).
