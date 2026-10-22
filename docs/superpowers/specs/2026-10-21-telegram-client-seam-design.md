# Telegram client seam design

## Intent

Discord talks to discord.js through one narrow seam, `DiscordClient` (src/discord/types.ts:146-164), with one production adapter (src/discord/client.ts) and one fake (test/discord/fake.ts, 106 lines). Telegram has no seam. src/telegram/adapter.ts (564 lines) holds the messenger, routing, entity mapping, pairing and the grammY handlers together, and every function that does I/O takes a grammY `Bot` directly (adapter.ts:218, 347, 417, 487, 518, 541; runtime.ts:30).

So the Telegram tests fake grammY itself. test/telegram/adapter.test.ts has 101 `vi.fn` and 20 `as unknown as Bot` casts across six hand-rolled partial bots (adapter.test.ts:202, 604, 916, 1070, 1169, 1402); test/telegram/runtime.test.ts has 39 more `vi.fn` and its own fake bot. They assert grammY call shapes (`sendMessage` argument objects, `on('callback_query:data')` registration order, context objects with `answerCallbackQuery`). That's testing past the interface: a grammY upgrade or a harmless change in how we call it breaks tests while behavior stays the same.

The change: give Telegram a `TelegramClient` seam shaped like `DiscordClient`, put all grammY knowledge in one adapter behind it, and test everything above it with one fake.

## Goals

- One `TelegramClient` type in src/telegram/types.ts, one grammY adapter (`createTelegramClient` in src/telegram/client.ts), one fake (test/telegram/fake.ts).
- Locality for grammY knowledge. Today it's spread over adapter.ts and runtime.ts: the 400 entity-parse fallback (adapter.ts:145-163), `InputFile` (adapter.ts:228), reading a document off `reply_to_message` on a Dismiss tap (adapter.ts:359-379), middleware order and `next()` (adapter.ts:424-445, runtime.ts:61-69), `GrammyError` codes for the command menu (adapter.ts:557-561) and for token checks (runtime.ts:46), `bot.catch` (runtime.ts:58), the 409 polling conflict (runtime.ts:80). All of it moves into client.ts. Nothing outside client.ts and setup.ts imports `grammy`.
- The modules above the seam (messenger, update handling, runtime) see plain data: normalized updates in, plain send/edit/delete calls out. Their tests read like test/discord/messenger.test.ts and events.test.ts.
- No behavior change the owner can see: same messages, buttons, hints, log lines, fatal texts.

## Non-goals

- Moving routing, payload codecs, open questions or pairing copy out of the Telegram module. That's 2026-10-21-owner-conversation-design.md.
- Changing `ProviderRuntime` or how the daemon drives providers. That's 2026-10-21-provider-runtime-contract-design.md.
- Changing Discord. Its seam is the model, not a target.
- Switching from long polling to webhooks, or dropping grammY.

## Anti-goals

- A seam that mirrors grammY method by method (`sendMessage(chatId, text, other)` with grammY's option bag). That's a shallow pass-through; the fake would still encode grammY shapes.
- Keeping the grammY-shaped tests next to the new ones. Each one gets replaced or deleted, not kept alongside.
- grammY types (`Bot`, `Context`, `MessageEntity`, `GrammyError`) in the seam's types.
- Losing the token-safety guarantees: no token in a credential reason, fatal message or log line (runtime.ts:42, adapter.ts:539).

## Decided by me (owner can override)

- The seam is a plain object type with readonly function fields, built by a factory, same as `DiscordClient`. Not a class, to match the Discord module.
- The client does the 400 entity fallback itself and reports it in the result (`formattingRejected`); the messenger writes today's log line (adapter.ts:160). The client stays free of logging, like the Discord client.
- `toEntities` stays pure and above the seam (the messenger calls it, like Discord's messenger calls `renderContent`). The seam carries our own `TelegramEntity` type, structurally the Bot API entity, so grammY's type doesn't leak.
- Command matching stays grammY's: `connect` takes the command names and the client registers `bot.command(name)` for each, emitting a `command` update. I don't want to reimplement `/name@bot` matching and which update kinds `bot.command` covers; adapter.test.ts:1118-1144 (real grammY `Bot` with a transformer) shows that matching is subtle.
- The client awaits `events.update` per update, so updates stay sequential like grammY polling today. The callback must not reject; the runtime catches and logs `bot error: <message>` (today's text, runtime.ts:59).
- `getIdentity` returns a union like `DiscordIdentity`, and `validateToken` (setup.ts) becomes `createTelegramClient(token, options).getIdentity()` like src/discord/setup.ts.
- The order between taps, commands, reply routing and pairing (runtime.ts:61-69, enforced by `next()`) becomes plain code in a new src/telegram/events.ts, `handleUpdate(update, context)`, mirroring src/discord/events.ts.
- adapter.ts keeps only the pure functions (routing, codecs, `toEntities`, pairing text) until the owner-conversation spec takes them. The messenger moves to src/telegram/messenger.ts.

## Proposed interface

```ts
/** What `getIdentity` found: the bot, a refused token, or no answer at all. */
export type TelegramIdentity =
  | { readonly kind: 'ok'; readonly userId: number; readonly username: string }
  | { readonly kind: 'rejected'; readonly status: number }
  | { readonly kind: 'unreachable' }

/** A message to send; `buttons` is one button per row, `silent` skips the push notification. */
export type OutgoingMessage = {
  readonly text: string
  readonly entities: readonly TelegramEntity[]
  readonly buttons: readonly { readonly label: string; readonly data: string }[]
  readonly silent: boolean
  readonly replyToMessageId?: number
}

/** Set when Telegram refused the entities and the text went out plain; holds its description. */
export type Delivery = { readonly formattingRejected: string | undefined }

export type SentMessage = Delivery & { readonly chatId: number; readonly messageId: number }

/** A normalized update; `replyTo` is in the same chat. */
export type IncomingUpdate =
  | ({ readonly kind: 'message'; readonly messageId: number } & IncomingMessage)
  | ({ readonly kind: 'command'; readonly name: string; readonly argument: string } & ChatSender)
  | {
      readonly kind: 'tap'
      readonly queryId: string
      readonly fromId: number
      readonly data: string
      readonly message: TappedMessage | undefined
    }

export type PollingEvents = {
  readonly ready: (username: string) => void
  readonly update: (update: IncomingUpdate) => Promise<void>
  readonly fatal: (message: string) => void
}

export type MessageEdit = {
  readonly text: string
  readonly entities: readonly TelegramEntity[]
  readonly removeButtons: boolean
}

/** `status` is the Bot API error code, undefined when Telegram couldn't be reached. */
export type CommandsOutcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'failed'; readonly status: number | undefined }

/**
 * The narrow seam over grammY. Methods other than `getIdentity`, `setCommands` and `connect`
 * reject on Bot API failures, never with the token in the message.
 */
export type TelegramClient = {
  readonly getIdentity: () => Promise<TelegramIdentity>
  readonly sendMessage: (chatId: number, message: OutgoingMessage) => Promise<SentMessage>
  readonly sendDocument: (chatId: number, file: Attachment, silent: boolean) => Promise<number>
  readonly editMessage: (chatId: number, messageId: number, edit: MessageEdit) => Promise<Delivery>
  readonly deleteMessages: (chatId: number, messageIds: readonly number[]) => Promise<void>
  readonly answerTap: (queryId: string, text: string | undefined) => Promise<void>
  readonly setCommands: (
    chatId: number,
    commands: readonly OwnerCommand[],
  ) => Promise<CommandsOutcome>
  readonly connect: (commandNames: readonly string[], events: PollingEvents) => void
  readonly destroy: () => Promise<void>
}
```

`ChatSender` is today's `CommandMessage` plus `chatId`; `TappedMessage` is `{ chatId, messageId, replyTo }` where `replyTo` says whether it's the bot's own document. `deleteMessages` calls `deleteMessage` for one id and `deleteMessages` for more, as today (adapter.ts:330-337).

## Tests

- Stay as they are (pure, about 38 of the 98 top-level tests in adapter.test.ts): `routeTap`, `routeReply`, `isOwnerCommand`, `handlePairingMessage`, codecs, pairing instructions, `toEntities`. If the owner-conversation spec lands first, they've already moved.
- Deleted and replaced (about 60 in adapter.test.ts, all 18 in runtime.test.ts): everything built on the six partial bots and runtime.test.ts's `fakeBot`.
- New test/telegram/fake.ts: `createFakeTelegram(overrides)` recording every call, modeled on test/discord/fake.ts.
- New messenger.test.ts (fake): button rows, hints, silent flags, document-then-reply order and cleanup, open-question bookkeeping, logging when `formattingRejected` is set, restored references with and without `documentMessageId`.
- New events.test.ts (fake, driving `handleUpdate`): owner and stranger taps, Expired answer, Dismiss deleting the message and the bot's document, a registered command never becoming an answer, a stranger's command never reaching pairing, ignored messages falling through to pairing, failed replies logged.
- New runtime.test.ts (fake): credential reasons per `TelegramIdentity` kind, command menu by owner chat only, pairing sets the owner, fatal suppressed after stop.
- New client.test.ts: real grammY against a `node:http` fake Bot API on port 0, like setup.test.ts and test/discord/client.test.ts. Covers request shapes once, the 400 fallback (retry once, no retry on plain or non-400), 409 fatal text, command matching (`/mute@mybot`, strangers, `/start CODE`), Dismiss document detection, token never in a reason or rejection.

## Migration steps

1. Add the types, `createTelegramClient` and client.test.ts. Nothing uses it yet.
2. Add test/telegram/fake.ts. Move `createTelegramMessenger` to messenger.ts on `TelegramClient`, write messenger.test.ts, delete the matching adapter.test.ts tests (send, finalize, formatting fallback, attachments). The runtime builds the client and passes it in; the handlers still take `Bot` for now.
3. Add events.ts with `handleUpdate`, switch the runtime to `client.connect(...)`, delete `register*Handler` and `setCommandMenu`, replace runtime.test.ts and the handler tests with events and runtime tests on the fake.
4. Point `validateToken` at `getIdentity`; setup.test.ts keeps passing unchanged.
5. Check that only client.ts and setup.ts import `grammy`, and run `build:exe` and a real send from the binary (see Constraints).

## Constraints

- The standalone binary (commit b299efa): node-fetch inside grammY recognizes the abort signal by `constructor.name`, so the build keeps `keepNames` (scripts/build-exe.ts:34-36) and disables DEP0169 (build-exe.ts:47-49). The client must keep grammY on its own fetch; src/telegram/setup.ts:7 already notes Node's global fetch rejects grammY's polyfilled `AbortSignal`. No `baseFetchConfig` or custom fetch in the client.
- `instanceof GrammyError` only inside client.ts.
- Repo style, as in the Discord module: factory functions, `vite-plus/test`, no semicolons, single quotes, width 100.
- `MessageReference` stays `TelegramMessageReference` (src/telegram/types.ts:56-63). References saved before text replies or attachments must still finalize and delete.

## Left to the builder

- Exact field names in `IncomingUpdate`, `ChatSender` and `TappedMessage`.
- How client.test.ts serves `getUpdates` and stops polling cleanly.
- Whether adapter.ts gets renamed to routing.ts to mirror Discord, if the owner-conversation spec hasn't already moved its contents.

## Open questions

- Ordering with 2026-10-21-owner-conversation-design.md. Either order works. I think this one first is cheaper: then that spec only moves pure functions and their pure tests, and the seam-level events tests survive the move. If that spec lands first, `IncomingUpdate` should feed its shared inputs directly, and step 3 shrinks.
- The command menu log today has the error code (adapter.ts:559). I kept it via `status`. Discord logs no code (src/discord/runtime.ts:84). Not sure the owner cares about matching.
- I haven't checked which update kinds grammY's `bot.command` matches (edited messages, captions, channel posts). Keeping `bot.command` in the client sidesteps it, but someone should confirm the normalized `message` update covers only what `bot.on('message')` covers today.
- The `ProviderRuntime` contract spec may change `start`/`stop`; the runtime here is thin enough to follow, but I haven't seen that spec.
