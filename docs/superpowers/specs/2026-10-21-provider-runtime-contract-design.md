# Honest provider runtime interface

## Intent

`ProviderRuntime` (src/provider/types.ts:66-96) is the seam the daemon drives both chat adapters through. Three of its parts are optional: `finalize`, `sendNotification` and `deleteMessage` (types.ts:77-89). Both real adapters implement all three and say so in their return type, `Required<Messenger> & Required<Notifier>` (src/telegram/adapter.ts:223, src/discord/messenger.ts:33). Telegram has returned that type since the seam was added in 4a1cd69. So the "absent" paths are reachable only through the test fake (test/provider/fake.ts:53-68), but they still cost real code:

- `POST /notify` answers 501 `notifications not supported` (src/server/server.ts:229-231), and `ApiServerOptions.notifications` is optional (src/server/types.ts:15).
- src/daemon/service.ts:56-65 builds `NotificationService` only when `sendNotification` exists, then uses `?.` at 70, 72 and 132.
- `ApprovalService` checks for `finalize` twice (src/approval/service.ts:199, 266). `NotificationService` checks for `deleteMessage` three times (src/notify/service.ts:65, 84, 151).
- Tests pin each of those branches (see Tests).

The runtime type also restates the `Messenger` (src/approval/types.ts:93-110) and `Notifier` (src/notify/types.ts:26-36) signatures instead of composing them, so a signature change has to be made twice. And two Telegram facts live in core modules: the 47h notification cap in src/notify/constants.ts:7-12 is Telegram's 48h delete limit minus an hour, and src/commands/pairing-text.ts:2 imports `formatLegacyInstructions` from telegram/.

The aim is a runtime interface that says what every adapter must do, no optional parts that no adapter leaves out, and provider facts held by the provider module.

## Goals

- `finalize`, `sendNotification` and `deleteMessage` are required; `ProviderRuntime` is `Messenger & Notifier & { ... }`.
- The no-finalize, no-delete and no-notifications branches and their tests are gone.
- The notification lifetime cap is a `Provider` property; src/notify/ holds no Telegram number.
- src/commands/ stops importing from src/telegram/.

## Non-goals

- Shared reply, tap and pairing routing under both adapters: 2026-10-21-owner-conversation-design.md.
- How the Telegram adapter talks to grammY: 2026-10-21-telegram-client-seam-design.md.
- The /status schema (src/server/schema.ts) and how 501 is described on the wire: 2026-10-21-wire-contract-design.md. This spec removes one cause of 501; that spec owns the shape.
- Client handling of 501 (src/client/http.ts:279-283): 2026-10-21-client-protocol-design.md. That branch is also the fallback for any 501 other than `attachments not supported`, so it doesn't automatically go away here.
- `Provider.maxAttachmentBytes?` and the attachment 501. Both providers set 10 MiB (src/telegram/provider.ts:28, src/discord/provider.ts:28), so that path is fake-only too, but it's a `Provider` property, it's documented (README.md:296, 406), and it's a likelier real variation for a third provider. See open questions.
- `pairingInstructions?` stays optional. A provider without an owner setting is a real shape, and src/daemon/service.ts:79-84 already refuses an owner setting without it.

## Anti-goals

- Replacing the optionals with a capability flag every caller checks. That keeps the branches and adds a way for the flag and the functions to disagree.
- A default lifetime cap in src/notify/. A new adapter would silently inherit Telegram's limit.
- No-op `finalize` or `deleteMessage` implementations in adapters to satisfy the type.
- Any change to what a real Telegram or Discord install does: same messages, same expiry, same /status body.

## Decided by me (owner can override)

- Required parts, no flag. If a future provider really can't delete, it brings the optional back with a real implementation behind it. I don't think we should pay for it before then.
- `Messenger` stays in approval/ and `Notifier` in notify/, since `ApprovalService` and `NotificationService` take exactly those. provider/ already imports from both (types.ts:1-9), so composing adds no new dependency direction.
- New required `Provider.maxNotificationLifetimeMs`, next to `maxTextLength`, because it's a static fact, not runtime behaviour. Telegram: 169_200_000 (47h), moved to src/telegram/constants.ts with its comment. Discord: the same value for now, which keeps today's behaviour. That's a placeholder, not a Discord fact. The code doesn't mention a Discord delete limit, and I don't know of an age limit on deleting a single message (src/discord/client.ts:135-136 uses the single delete). I believe bulk delete has a two-week limit, which jaypost doesn't use. Not verified.
- `NotificationService` gets the cap from its caller, with no default. `MAX_TIMER_DELAY_MS` stays in notify/ since it's a Node fact. Mute tops out at 7 days (src/quiet/constants.ts:7), well under the ~24.8-day timer clamp, so a larger cap for Discord later wouldn't make timers fire early.
- The daemon always builds `NotificationService`, `ApiServerOptions.notifications` becomes required and the `/notify` 501 branch goes. README.md:354 loses "Notifications aren't supported, or"; the `NotSupported` text in src/server/openapi.ts:401-403 becomes attachments only; docs/openapi.yaml is regenerated. As far as I can tell no real install ever sent this 501: /notify was added in 2b22462 with `NotificationService` built unconditionally, and Discord shipped with it.
- `bot` stays on the wire, and `statusFields` stays as the seam Telegram emits it through. It's documented (README.md:428, docs/openapi.yaml:344, 370), so dropping it is an HTTP API change for anyone scripting /status; the wire-contract spec should decide that. Only the comment at types.ts:92 changes, since "kept for old CLIs" isn't why it's kept any more.
- Delete the legacy branch in src/commands/pairing-text.ts:13-15 and `formatLegacyInstructions` (src/telegram/adapter.ts:42-45). Only a daemon that sends `bot` without `instructions` hits it, which means telegram-ask 0.1.x: `instructions` landed in 9ad14c7, before the 0.2.0 release, and jaypost 0.6.0 said there's no migration from telegram-ask (CHANGELOG.md:18). It's still reachable in theory, since 0.1.2 also defaults to port 8787, so a jaypost CLI next to a leftover telegram-ask 0.1.x daemon would print the code without the how-to line.

## Constraints

- Follow the repo's code, not a generic style: no semicolons, single quotes, width 100, `readonly` types, factory functions for adapters (don't convert them to classes here). Tests use `vite-plus/test` (`test`, `expect`, `vi`).
- `vp test` and `vp check` green after every step.
- docs/openapi.yaml is generated (`vp run openapi`) and compared by test/server/openapi.test.ts:13. Regenerate it, don't hand-edit.
- No em-dashes in README edits.

## Proposed interface

```ts
// src/approval/types.ts
export type Messenger = {
  readonly sendRequest: (
    id: string,
    message: FormattedText,
    options: readonly string[],
    allowText: boolean,
    attachment: Attachment | undefined,
  ) => Promise<MessageReference>
  /** Request ended: show the final text and stop accepting answers. */
  readonly finalize: (
    reference: MessageReference,
    message: FormattedText,
    ending: MessageEnding,
  ) => Promise<void>
}

// src/notify/types.ts
export type Notifier = {
  readonly sendNotification: (
    id: string,
    message: FormattedText,
    options: SendNotificationOptions,
    attachment: Attachment | undefined,
  ) => Promise<MessageReference>
  readonly deleteMessage: (reference: MessageReference) => Promise<void>
}

// src/provider/types.ts
export type ProviderRuntime = Messenger &
  Notifier & {
    readonly checkCredentials: () => Promise<CredentialCheck>
    /** Present iff the provider pairs; `code` is raw (no dash). */
    readonly pairingInstructions?: (code: string) => string
    /** Extra /status fields the provider documents (Telegram: `bot`). */
    readonly statusFields?: () => Readonly<Record<string, string>>
    readonly start: (handlers: RuntimeHandlers) => void
    readonly stop: () => Promise<void>
  }

export type Provider = {
  // ...existing fields
  /** Past this many ms after the send, a notification is left until dismissed. */
  readonly maxNotificationLifetimeMs: number
}
```

Adapters return `Messenger & Notifier` instead of `Required<Messenger> & Required<Notifier>`.

## Tests

Replace, don't stack: a test that pinned a branch that no longer exists is deleted, not kept next to a new one.

- test/provider/fake.ts: `createFakeProvider` implements `finalize`, `sendNotification` and `deleteMessage` by default and records them, absorbing `createRecordingProvider` (test/daemon/service.test.ts:57-72). It also sets `maxNotificationLifetimeMs`.
- test/approval/service.test.ts: delete 275 (`no finalize part`), 390 (`history ... no finalize`; history is covered by 312, 350, 372), 447 (`records nothing without finalize`), 493 (`expireOrphans without finalize`).
- test/notify/service.test.ts: delete 167, 217, 286 (the `without deleteMessage` ones). 332 and 344 keep their shape but pass the cap explicitly, ideally a number that isn't 47h, so they show the cap comes from the caller.
- test/daemon/service.test.ts: delete 151 (`501 on /notify`). 108 and 118 lose "without optional parts"; 118 asserts finalize ran instead of "no finalize attempted". New: a fake with a short `maxNotificationLifetimeMs`, muted, sends /notify and no notification lands in state.json, proving the provider value reaches `NotificationService`.
- test/server/server.test.ts: delete 401; 818 drops the "501 notifications" step from the check order.
- test/telegram/adapter.test.ts:589 deleted with `formatLegacyInstructions`. test/commands/pairing-wait.test.ts:25-38, 140 and test/commands/manage.test.ts:128 switch their fixtures to carry `instructions`.
- No new test that a Telegram constant equals itself.

## Migration steps

1. Lifetime cap: add required `Provider.maxNotificationLifetimeMs`, set it on telegram, discord and the fake; `NotificationService` takes it from its caller; the daemon passes `provider.maxNotificationLifetimeMs`; delete `MAX_NOTIFICATION_TTL_MS` from notify/. Update notify tests, add the daemon test.
2. Fake: default recording `finalize`, `sendNotification`, `deleteMessage`. Move daemon tests onto it; delete the daemon 501 test.
3. `finalize` required on `Messenger` and `ProviderRuntime`. Delete the `ApprovalService` branches and their tests.
4. `sendNotification` and `deleteMessage` required. Delete the `NotificationService` branches; the daemon always builds it; `ApiServerOptions.notifications` required; delete the 501 branch and its server tests; update openapi.ts and README.md:354; regenerate docs/openapi.yaml.
5. Compose `ProviderRuntime` from `Messenger & Notifier`; adapters drop `Required<>`; fix the `statusFields` comment. Types only.
6. Delete the pairing-text legacy branch and `formatLegacyInstructions`; update the command test fixtures.

## Left to the builder

- Whether the cap reaches `NotificationService` as a required option (the `options = {}` default goes) or as its own constructor argument.
- The exact name of the `Provider` field.
- Whether the fake keeps its records on `FakeRuntime` or returns them next to the provider.
- Whether steps 3 and 4 land as one commit.
- Whether a changeset is worth it. Real installs see no change; only README and openapi text move.

## Open questions

- Is it fine to drop the telegram-ask 0.1.x pairing fallback (step 6)? If not, the fallback could stay in src/commands/ without the telegram/ import, but it still knows Telegram's link format.
- Discord's cap: keep the 47h placeholder, or have someone check Discord's docs for a single-message delete age limit first? I couldn't confirm one either way.
- `bot` on /status: keep it documented for good, or deprecate it under the wire-contract spec?
- `maxAttachmentBytes?` and the attachment 501 follow the same fake-only pattern. A follow-up with this one's reasoning, or left as the place a third provider without files would plug in?
