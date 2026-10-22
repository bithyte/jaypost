# Direct Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `jaypost send request|notify` run on a CI runner with only `JAYPOST_*` env vars and no service, plus a `jaypost setup-ci` command that pairs the owner and prints those env vars.

**Architecture:** A new `src/direct/` module reads the mode and the provider settings from env, and drives a `ProviderRuntime` in-process through an in-memory `ApprovalService` (no store, no audit, no HTTP). `src/commands/send-direct.ts` builds the same wire body `send` posts today, validates it with the server's own parsers, and runs it through that session. `src/commands/setup-ci.ts` reuses init's settings prompt and the `Pairing` class against an in-process runtime. Every env var gets the `JAYPOST_` prefix first, in its own task.

**Tech Stack:** Node 24.2+, TypeScript run directly, commander, vitest through vite-plus (`pnpm test <file>`, `pnpm check`).

**Spec:** `docs/superpowers/specs/2026-10-22-direct-mode-design.md`

## Global Constraints

- Every env var jaypost reads has the `JAYPOST_` prefix: `JAYPOST_PROVIDER`, `JAYPOST_BOT_TOKEN`, `JAYPOST_OWNER_ID`, `JAYPOST_PORT`, `JAYPOST_HOST`, `JAYPOST_TOKEN`, `JAYPOST_CONFIG`, `JAYPOST_MODE`. `HOME`, `XDG_*`, `PATH`, `CLAUDE_PROJECT_DIR`, `TZ` stay as they are.
- No fallback to the old names (`PROVIDER`, `BOT_TOKEN`, `OWNER_ID`, `PORT`, `HOST`) and no migration code.
- `JAYPOST_MODE=direct|service`, default `service`; any other non-empty value is a usage error, exit 2. Mode is never inferred from other env vars. Empty string counts as unset (same as `findEnvValue`).
- Direct `send request` exits: `0` answered with something other than the `-d` value; `1` error; `2` bad arguments; `3` answer equals the `-d` value or the timeout fired. The answer is printed to stdout (or `--json`) in the `0` and `3` cases.
- Direct `send notify` exits `0` once the provider accepts the message, `1` on error.
- With `JAYPOST_MODE` unset, `send` keeps today's output, exit codes and signal handling (SIGINT only).
- Direct mode never reads the config file. Notifications in direct mode have no Dismiss button and aren't auto-deleted.
- `setup-ci` writes no files, installs nothing, and prints exactly these lines last (values filled in): `JAYPOST_MODE=direct`, `JAYPOST_PROVIDER=<name>`, `JAYPOST_BOT_TOKEN=...`, `JAYPOST_OWNER_ID=...`.
- Secret values never go on a command line or into log lines. A failed send prints `failed to send message` without the cause, as the server does (`src/server/server.ts:72`).
- No new runtime dependencies.
- Code follows this repo, not the global class-based TS style: exported functions, `type` aliases, single quotes, no semicolons, width 100, tests with `test`/`expect` from `vite-plus/test`.
- No em-dashes in code, copy, commits or docs. Commits are conventional lowercase, with no Claude attribution trailer.

## Review Focus

1. Owner taps the `-d` button, or types a reply equal to `-d` with `--allow-text`: exit 3, answer still printed. Pinned in Task 5.
2. Cancelled workflow run (SIGTERM while waiting): the message is edited to the cancelled line before exit, and the runtime is stopped. Pinned in Task 4 (abort finalizes) and Task 5 (exit 1, stop called); the SIGTERM wiring is checked by hand in Task 5.
3. Provider dies mid-wait (Telegram 409, Discord gateway fatal): the step fails with exit 1 and the provider's message instead of hanging until the timeout. Pinned in Task 4 and Task 5.
4. Missing or malformed `JAYPOST_OWNER_ID` in direct mode: exit 1 with a message naming the env var and never the token, before anything is sent. Pinned in Task 4 and Task 5.
5. `setup-ci` stops the bot right after `pair` returns; the owner should still see the provider's "paired" reply. Not unit-testable with the fake; a manual check against a real Telegram bot is a step in Task 6.

---

### Task 1: Prefix every env var with `JAYPOST_`

**Files:**
- Modify: `src/config/constants.ts`, `src/config/index.ts`, `src/config/store.ts`
- Modify: `src/provider/constants.ts`, `src/telegram/provider.ts`, `src/discord/provider.ts`
- Modify: `src/commands/owner.ts`, `src/mcp/port.ts`, `src/cli.ts` (`resolvePort`, and every `--port` help string that says `PORT`)
- Modify: `src/install/templates.ts` (Dockerfile `HOST=0.0.0.0`, `formatEnvFile`), `src/install/envfile.ts` (`values.PROVIDER`)
- Test: every test that sets or expects the old names (`test/config/store.test.ts`, `test/install/*.test.ts`, `test/discord/provider.test.ts`, `test/cli.test.ts`, `test/daemon/service.test.ts`, `test/mcp/port.test.ts`, `test/commands/owner.test.ts`, `test/provider/registry.test.ts`)
- Create: `.changeset/env-prefix.md`

**Interfaces:**
- Produces, in `src/config/constants.ts` and re-exported from `src/config/index.ts`:
  `PROVIDER_ENV_VAR = 'JAYPOST_PROVIDER'`, `PORT_ENV_VAR = 'JAYPOST_PORT'`, `HOST_ENV_VAR = 'JAYPOST_HOST'`, `MODE_ENV_VAR = 'JAYPOST_MODE'`.
- Provider settings' `envVar` become `JAYPOST_BOT_TOKEN` and `JAYPOST_OWNER_ID` on both providers.
- `RESERVED_ENV_VARS` becomes `[PROVIDER_ENV_VAR, PORT_ENV_VAR, HOST_ENV_VAR, 'JAYPOST_CONFIG', TOKEN_ENV_VAR, MODE_ENV_VAR, 'TZ']`. Import from `../config/constants.ts` directly (not the index), the way it already imports `../auth/constants.ts`.

- [ ] **Step 1: Write the failing tests**

In `test/provider/registry.test.ts`:

```ts
test('every provider setting reads a JAYPOST_ env var', () => {
  for (const setting of PROVIDERS.flatMap((provider) => provider.settings)) {
    expect(setting.envVar).toMatch(/^JAYPOST_/)
  }
})
```

In `test/config/store.test.ts`:

```ts
test('unprefixed env vars are ignored', () => {
  const none = join(dir, 'none.json')
  expect(() => loadConfig({ JAYPOST_CONFIG: none, BOT_TOKEN: 't', OWNER_ID: '1' })).toThrow(
    'missing bot token; run `jaypost init` to set up the bot (or set JAYPOST_BOT_TOKEN)',
  )
})
```

In `test/install/templates.test.ts`, change the `formatEnvFile` expectations so the telegram output starts `JAYPOST_PROVIDER=telegram\nJAYPOST_BOT_TOKEN=t\nJAYPOST_PORT=8787\n` and the Dockerfile contains `JAYPOST_HOST=0.0.0.0`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test test/provider/registry.test.ts test/config/store.test.ts test/install/templates.test.ts`
Expected: FAIL on the three new or changed expectations.

- [ ] **Step 3: Rename in the source**

Add the constants, then replace every read and write of the old names. Find them with `grep -rnE "\b(PROVIDER|BOT_TOKEN|OWNER_ID|PORT|HOST)\b" src` (the `\b` skips `DEFAULT_PORT`, `MAX_PORT`). Comments and error strings that name a var change too (`src/config/constants.ts:7`, the `loadConfig` JSDoc, `readEnvSecrets` and `formatEnvFile` JSDoc).

- [ ] **Step 4: Update the remaining tests**

Run the same grep over `test/`; rename env usages and expected `.env` contents. Leave fixture constants like `const OWNER_ID = '1'` in `test/discord/events.test.ts` alone, and leave the fake providers' `FAKE_KEY`/`FAKE_OWNER`.

- [ ] **Step 5: Run the whole suite and the checker**

Run: `pnpm test && pnpm check`
Expected: all pass.

- [ ] **Step 6: Write `.changeset/env-prefix.md`**

`'jaypost': minor`. Say plainly that this breaks existing installs: the old names are no longer read. For Quadlet and Compose, rename `PROVIDER`, `BOT_TOKEN`, `OWNER_ID`, `PORT` in the `.env` (paths: `~/.config/jaypost/jaypost.env` for Quadlet and `~/.config/jaypost/compose/.env` for Compose; confirm against `src/install/paths.ts` before writing) to the `JAYPOST_` names before running `jaypost update`, since the new CLI reads that file. Anyone setting `PORT`/`HOST` for `jaypost start`, `mcp`, `hook` or `send` renames them too.

- [ ] **Step 7: Commit**

```bash
git add -A src test .changeset/env-prefix.md
git commit -m "feat!: prefix every env var with JAYPOST_"
```

---

### Task 2: Notifications without a Dismiss button

**Files:**
- Modify: `src/notify/types.ts` (`SendNotificationOptions`), `src/notify/service.ts`
- Modify: `src/telegram/adapter.ts` (`sendNotification`), `src/discord/messenger.ts` (`sendNotification`)
- Test: `test/telegram/adapter.test.ts`, `test/discord/messenger.test.ts`, `test/notify/service.test.ts`

**Interfaces:**
- Produces: `SendNotificationOptions = { readonly silent: boolean; readonly dismissible: boolean }`. `NotificationService.notify` always passes `dismissible: true`. With `dismissible: false`, Telegram sends no `reply_markup`, and Discord sends `rows: []` and returns `hasButtons: false` in the reference.

- [ ] **Step 1: Write the failing tests**

Telegram: `test('sendNotification without dismissible sends no keyboard', ...)` asserting the recorded `sendMessage` call has no `reply_markup`. Discord: `test('sendNotification without dismissible sends no buttons', ...)` asserting the created message has `rows: []` and the reference is `{ channelId, messageId, hasButtons: false }`. Notify service: extend the existing send test so the recorded options equal `{ silent: false, dismissible: true }`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test test/telegram/adapter.test.ts test/discord/messenger.test.ts test/notify/service.test.ts`
Expected: FAIL (type error or button still present).

- [ ] **Step 3: Implement**

Add the field, pass it from the service, branch on it in both adapters. Update the adapters' JSDoc ("Notifications get a single Dismiss button" becomes "unless not dismissible"). Fix any existing test that builds `SendNotificationOptions` literally.

- [ ] **Step 4: Run tests and checker**

Run: `pnpm test && pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/notify src/telegram/adapter.ts src/discord/messenger.ts test
git commit -m "feat: let notifications go out without a dismiss button"
```

---

### Task 3: Read an attachment without the service

**Files:**
- Modify: `src/client/attachment.ts`, `src/client/index.ts`
- Test: `test/client/attachment.test.ts`

**Interfaces:**
- Produces: `readAttachment(source: AttachmentSource, signal: AbortSignal): Promise<AttachmentResult>` exported from `src/client/index.ts`. Reads the source locally with the existing `readSource` and the `MAX_ATTACHMENT_BYTES` cap, makes no HTTP call. Never throws. `prepareAttachment` keeps its signature and behaviour.

- [ ] **Step 1: Write the failing tests**

```ts
test('readAttachment reads a file without calling the service', async () => {
  // temp dir with a.txt containing "hi"
  expect(await readAttachment({ path: file }, new AbortController().signal)).toEqual({
    kind: 'ok',
    attachment: { name: 'a.txt', data: Buffer.from('hi').toString('base64') },
  })
})

test('readAttachment reports a missing file', async () => {
  expect(await readAttachment({ path: missing }, new AbortController().signal)).toEqual({
    kind: 'failed',
    message: `attachment ${JSON.stringify(missing)} not found`,
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test test/client/attachment.test.ts`
Expected: FAIL, `readAttachment` is not exported.

- [ ] **Step 3: Implement** `readAttachment` as a thin wrapper mapping `Read` to `AttachmentResult`; leave `prepareAttachment` calling `readSource` as it does now (it needs `byteLength`).

- [ ] **Step 4: Run tests**

Run: `pnpm test test/client/attachment.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client test/client/attachment.test.ts
git commit -m "refactor: export a local-only attachment read"
```

---

### Task 4: The `direct` module (mode, env config, in-process session)

**Files:**
- Create: `src/direct/types.ts`, `src/direct/constants.ts`, `src/direct/mode.ts`, `src/direct/config.ts`, `src/direct/session.ts`, `src/direct/index.ts`
- Test: `test/direct/mode.test.ts`, `test/direct/config.test.ts`, `test/direct/session.test.ts`

**Interfaces:**
- Consumes: `MODE_ENV_VAR`, `PROVIDER_ENV_VAR`, `findEnvValue` (from `src/config/paths.ts`) from Task 1; `SendNotificationOptions.dismissible` from Task 2; `ApprovalService`, `SendError`, `ApprovalRequest`, `RequestResult` from `src/approval/index.ts`; `NotifyRequest` from `src/notify/index.ts`.
- Produces (all exported from `src/direct/index.ts`):
  - `type SendMode = { readonly kind: 'service' } | { readonly kind: 'direct' } | { readonly kind: 'invalid'; readonly value: string }`; constants `SERVICE_MODE`, `DIRECT_MODE` (`as const satisfies SendMode`).
  - `resolveSendMode(env: NodeJS.ProcessEnv): SendMode`. Unset or empty is `service`; exactly `direct` or `service` map to themselves; anything else is `invalid` with the raw value. Never throws.
  - `type DirectConfig = { readonly provider: Provider; readonly settings: SettingValues }`.
  - `loadDirectConfig(env: NodeJS.ProcessEnv, providers: readonly Provider[]): DirectConfig`. Provider from `JAYPOST_PROVIDER`, else `DEFAULT_PROVIDER`; unknown throws via `requireProvider`. Reads only env, never the config file. Every `required` setting and the owner setting are required. Throws `missing <description>; set <envVar> (jaypost setup-ci prints it)` or `invalid <description> in <envVar>`; never quotes a value.
  - `type DirectSession = { request(request: ApprovalRequest, signal: AbortSignal): Promise<RequestResult>; notify(request: NotifyRequest): Promise<void>; stop(): Promise<void> }`.
  - `openDirectSession(config: DirectConfig, log: (line: string) => void): Promise<DirectSession>`. Creates the runtime and runs `runtime.checkCredentials()`; throws `Error(reason)` when rejected, after stopping the runtime.
    - `request` starts the runtime on its first call (handlers: `answer` → `service.tap`, `reply` → `service.reply`, `dismiss` → `false`, `commands: []`, `command` → `undefined`, `fatal` → record the message and abort an internal controller), then calls `service.request(request, AbortSignal.any([signal, internal]))`. If it settles `cancelled` because of `fatal`, it rejects with `Error(<fatal message>)`. `SendError` propagates.
    - `notify` doesn't start the runtime (Telegram and Discord send over plain HTTP); it calls `runtime.sendNotification(randomUUID, message, { silent: false, dismissible: false }, attachment)` and wraps failures in `SendError('failed to send notification', { cause })`. Throws `Error('<label> can't send notifications')` when the runtime has no `sendNotification`.
    - `stop` calls `runtime.stop()`; never rejects; safe to call when never started.
  - `ApprovalService` is built as `new ApprovalService(runtime)`: no store, no audit, so timeout and cancel finalize exactly as the service does.

- [ ] **Step 1: Write the failing tests**

`test/direct/mode.test.ts`:

```ts
test('mode defaults to service and reads direct', () => {
  expect(resolveSendMode({})).toEqual({ kind: 'service' })
  expect(resolveSendMode({ JAYPOST_MODE: '' })).toEqual({ kind: 'service' })
  expect(resolveSendMode({ JAYPOST_MODE: 'service' })).toEqual({ kind: 'service' })
  expect(resolveSendMode({ JAYPOST_MODE: 'direct' })).toEqual({ kind: 'direct' })
})

test('any other mode is invalid', () => {
  expect(resolveSendMode({ JAYPOST_MODE: 'Direct' })).toEqual({ kind: 'invalid', value: 'Direct' })
})
```

`test/direct/config.test.ts` (with `createPairingFakeProvider()` as `FAKE`):

```ts
test('reads the provider and its settings from env only', () => {
  const env = { JAYPOST_PROVIDER: 'fakepair', FAKE_KEY: 'k', FAKE_OWNER: 'o', JAYPOST_CONFIG: '/nonexistent/x.json' }
  expect(loadDirectConfig(env, [FAKE])).toEqual({ provider: FAKE, settings: { fakeKey: 'k', fakeOwner: 'o' } })
})
test('the owner is required', () => {
  expect(() => loadDirectConfig({ JAYPOST_PROVIDER: 'fakepair', FAKE_KEY: 'k' }, [FAKE])).toThrow(
    'missing fake owner; set FAKE_OWNER (jaypost setup-ci prints it)',
  )
})
test('an invalid telegram owner id names the env var, not the value', () => {
  // PROVIDERS, JAYPOST_BOT_TOKEN: 'secret', JAYPOST_OWNER_ID: 'abc'
  // toThrow('invalid owner id in JAYPOST_OWNER_ID'), and the message doesn't contain 'secret'
})
test('an unknown provider throws', () => { /* JAYPOST_PROVIDER: 'nope' */ })
```

`test/direct/session.test.ts` (fake from `test/provider/fake.ts` with `finalize` and `sendNotification` overrides that record their arguments; requests built with `parseApprovalRequest({ text: 'Publish?', options: ['Yes', 'No'], timeoutOption: 'No' }, 100, 0)`; wait for sends with `vi.waitFor`):

- `request resolves with the tapped option`: `handlers.answer(sent[0].id, 0)` gives `{ kind: 'completed', outcome: { answer: 'Yes', timedOut: false } }`.
- `request times out with the default and finalizes as timed out`: `timeout: 0.01` gives `{ answer: 'No', timedOut: true }`; finalize recorded ending `{ kind: 'timedOut', answer: 'No' }`.
- `aborting finalizes the message as cancelled`: result `{ kind: 'cancelled' }`; finalize recorded `{ kind: 'cancelled' }`.
- `a fatal provider error rejects the pending request with its message`: `handlers.fatal('bot stopped: boom')` makes `request` reject with `'bot stopped: boom'`.
- `the owner gets no commands`: `handlers.commands` is `[]`.
- `notify sends without dismiss and never starts the runtime`: recorded options `{ silent: false, dismissible: false }`; `runtime.handlers` stays `undefined`.
- `rejected credentials throw the reason and stop the runtime`.
- `stop works when the runtime never started`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test test/direct`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the module** per the Interfaces block; `index.ts` re-exports only what's listed there.

- [ ] **Step 4: Run tests and checker**

Run: `pnpm test test/direct && pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/direct test/direct
git commit -m "feat: run a provider in-process from env settings"
```

---

### Task 5: `send` in direct mode

**Files:**
- Create: `src/commands/send-direct.ts`
- Modify: `src/commands/send.ts` (extract the body builders), `src/commands/constants.ts`, `src/commands/types.ts`, `src/commands/index.ts`, `src/cli.ts`
- Test: `test/commands/send-direct.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: `resolveSendMode`, `loadDirectConfig`, `openDirectSession` (Task 4); `readAttachment` (Task 3); `parseApprovalRequest`, `SendError` from approval; `parseNotifyRequest` from notify; `resolveMaxAttachmentBytes` from provider; `MODE_ENV_VAR` (Task 1).
- Produces:
  - In `send.ts`: `toAskBody(args: SendRequestArgs, attachment: AttachmentBody | undefined): AskBody` and `toNotifyBody(args: SendNotifyArgs, attachment: AttachmentBody | undefined)`, used by both the service and direct paths (refactor only for the service path).
  - `DECLINED_EXIT_CODE = 3` in `src/commands/constants.ts`.
  - `type DirectSendDeps = { readonly env: NodeJS.ProcessEnv; readonly providers: readonly Provider[]; readonly signal: AbortSignal; readonly print: (text: string) => void; readonly printError: (text: string) => void }` in `types.ts`, exported.
  - `runDirectSendRequest(args: SendRequestArgs, deps: DirectSendDeps): Promise<number>` and `runDirectSendNotify(args: SendNotifyArgs, deps: DirectSendDeps): Promise<number>`, exported from `src/commands/index.ts`.
- Order inside both: load config → read attachment (if any) → build body → parse with `provider.maxTextLength`, `resolveMaxAttachmentBytes(provider)`, `provider.maxOptionCount` → open session → send → `stop()` in `finally`. Every failure prints `jaypost: <message>` to stderr and returns 1; a `SendError` prints `jaypost: failed to send message`; a cancelled request prints `jaypost: cancelled`. Runtime log lines go to `printError` prefixed `jaypost: `.
- Request exit: completed with `timedOut || answer === args.timeoutOption` returns `DECLINED_EXIT_CODE`, else 0; output is printed exactly as `runSendRequest` prints it.
- `cli.ts`: both `send` actions call `resolveSendMode(process.env)` first. `invalid` → `command.error(\`error: ${MODE_ENV_VAR} must be "direct" or "service", got ${JSON.stringify(value)}\`, { exitCode: 2 })`. `direct` → the direct runner under `runWithSignals(..., ['SIGINT', 'SIGTERM'])`, deps `{ env: process.env, providers: PROVIDERS, ... }`; `--port` is ignored. `service` → unchanged code path, SIGINT only.

- [ ] **Step 1: Write the failing tests**

`test/commands/send-direct.test.ts`, helpers at top: `ENV = { JAYPOST_PROVIDER: 'fakepair', FAKE_KEY: 'k', FAKE_OWNER: 'o' }`, a `createDeps(provider, signal?)` collecting `printed` and `errors`, and an `answerWhenSent(provider, optionIndex)` that waits for the first send and taps.

- `an answer other than the default exits 0 and prints it`: taps `Yes` → `0`, printed `['Yes']`.
- `the default answer exits 3 and still prints it`: taps `No` → `3`, printed `['No']`.
- `a typed reply equal to the default exits 3`: `allowText: true`, no options, `handlers.reply(id, 'No')` → `3`.
- `a timeout exits 3 and prints the default`: `timeout: 0.01`, `json: true` → `3`, printed `['{"answer":"No","timedOut":true}']`.
- `a cancelled question exits 1 and stops the runtime`: abort after send → `1`, errors contain `'jaypost: cancelled'`, finalize saw `{ kind: 'cancelled' }`, a `stop` override was called.
- `a fatal provider error exits 1 with its message`.
- `a missing owner exits 1 before anything is sent`: env without `FAKE_OWNER` → `1`, errors `['jaypost: missing fake owner; set FAKE_OWNER (jaypost setup-ci prints it)']`, `provider.runtimes` empty.
- `text over the provider limit exits 1 with the parser message`: 101 chars on the fake's 100 limit → `1`, `'jaypost: text must be at most 100 characters'`, nothing sent.
- `a failed send exits 1 without the cause`: `sendRequest` throws `Error('token leaked')` → `1`, errors `['jaypost: failed to send message']`.
- `an attachment file is sent with the question`: fake with `maxAttachmentBytes: 100`; `sent[0].attachment` has the file's name and bytes.
- `notify exits 0 once sent`, `notify exits 1 when sending fails`.

`test/cli.test.ts`:

- `send rejects an unknown JAYPOST_MODE with 2`: `vi.stubEnv('JAYPOST_MODE', 'bogus')`; both `send request x -o a -d a` and `send notify x` return `2`.
- `direct send without a bot token exits 1 naming the env var`: stub `JAYPOST_MODE=direct`, `JAYPOST_PROVIDER=''`, `JAYPOST_BOT_TOKEN=''`; returns `1` and stderr contains `missing bot token; set JAYPOST_BOT_TOKEN`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test test/commands/send-direct.test.ts test/cli.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extract `toAskBody`/`toNotifyBody` in `send.ts`**, then run `pnpm test test/commands/send.test.ts` and expect the existing tests to still pass.

- [ ] **Step 4: Implement `send-direct.ts` and the `cli.ts` dispatch.**

- [ ] **Step 5: Run tests and checker**

Run: `pnpm test && pnpm check`
Expected: PASS.

- [ ] **Step 6: Check SIGTERM by hand**

With a real bot (`JAYPOST_MODE=direct` plus the three vars from Task 6's output, or from an existing install), run `node src/cli.ts send request 'test' -o Yes -d No &`, then `kill -TERM %1` once the message arrives. Expected: the chat message changes to the cancelled line, the process exits 1. If no bot is available, say so in the task report instead of claiming it.

- [ ] **Step 7: Commit**

```bash
git add src/commands src/cli.ts test/commands/send-direct.test.ts test/cli.test.ts
git commit -m "feat: send directly to the bot when JAYPOST_MODE=direct"
```

---

### Task 6: `jaypost setup-ci`

**Files:**
- Create: `src/commands/settings-prompt.ts`, `src/commands/setup-ci.ts`
- Modify: `src/commands/init.ts` (use the extracted helpers), `src/commands/types.ts`, `src/commands/index.ts`, `src/cli.ts`
- Test: `test/commands/setup-ci.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: `Pairing`, `formatCode`, `generateCode` from `src/pairing/index.ts`; `findOwnerSetting`, `findProvider` from provider; `MODE_ENV_VAR`, `PROVIDER_ENV_VAR` (Task 1); `Prompts`, `PromptAborted`.
- Produces:
  - `settings-prompt.ts`, moved out of `init.ts` unchanged in behaviour: `promptSettings(provider: Provider, prompt: Prompts, signal?: AbortSignal): Promise<SettingValues>` (throws `PromptAborted` when `signal` is aborted between prompts, replacing init's private `Aborted` there), `isComplete(provider, settings): boolean`, `findDisplayName(provider, settings): Promise<string | undefined>`. Not exported from `src/commands/index.ts`.
  - `type SetupCiArgs = { readonly provider?: string }`.
  - `type SetupCiDeps = { readonly prompt: Prompts; readonly providers: readonly Provider[]; readonly print: (text: string) => void; readonly signal?: AbortSignal; readonly log?: (line: string) => void; readonly generateCode?: () => string }`. No paths or targets, so it can't write files.
  - `runSetupCi(args: SetupCiArgs, deps: SetupCiDeps): Promise<number>`: 0 when the env vars were printed, 1 on failure, 130 on interrupt.
- Flow: pick the provider (`args.provider`; else the only one; else `prompt.select('Which chat app should the bot use?', ...)` defaulting to the first). Prompt settings until `isComplete` and `findDisplayName` succeed, printing `provider.setup.text.rejected` on each failure. Create the runtime with `deps.log ?? console.error`, run `runtime.checkCredentials()` (Discord needs it before `pairingInstructions`). If the provider has an owner setting: generate a code, print `Pairing code: ${formatCode(code)}` then `runtime.pairingInstructions(code)`, start the runtime with handlers that only pair (`answer`/`reply` → `'expired'`, `dismiss` → `false`, `commands: []`, `command` → `undefined`), and wait for `paired`, `fatal`, or abort. On `paired`, parse the sender id with the owner setting. Always `runtime.stop()` in `finally`. Then print a blank line, one line telling devops to add these as GitHub secrets and pass them with `env:`, then the env lines: `JAYPOST_MODE=direct`, `JAYPOST_PROVIDER=<name>`, then `${setting.envVar}=${value}` for each setting in declaration order that has a value.
- `cli.ts`: `program.command('setup-ci').description('pair an owner for CI and print the env vars for direct mode')` with the same `--provider <name>` choices option as `init`, run under `runWithSignals` with `createClackPrompts(controller.signal)`.

- [ ] **Step 1: Write the failing tests**

`test/commands/setup-ci.test.ts`, helpers: a scripted `Prompts` (password returns `'k'`; select returns its initial value), `CODE = 'ABCDEFGH'`, and `pairWhenStarted(provider, senderId, text)` that waits for `runtime.handlers` and calls `handlers.pair`.

- `pairs and prints the env vars last`: `createPairingFakeProvider()`, pair with `('owner-1', 'abcd-efgh')` → returns `0`; the last four printed lines are `['JAYPOST_MODE=direct', 'JAYPOST_PROVIDER=fakepair', 'FAKE_KEY=k', 'FAKE_OWNER=owner-1']`; runtime `stop` was called.
- `shows the pairing code and the provider's instructions`: printed contains `'Pairing code: ABCD-EFGH'` and `'Say ABCDEFGH to fake'`.
- `a wrong code doesn't pair`: `pair('owner-1', 'WRONG')` returns `'wrong'`, then the right code pairs and the owner is `owner-1`.
- `asks again after a rejected token`: `setup.checkCredentials` rejects the first time; printed contains `'Fake rejected that key. Try again.'` and it still returns `0`.
- `interrupting while waiting exits 130 without printing env vars`: abort after start → `130`, no printed line starts with `JAYPOST_`, `stop` called.
- `a fatal provider error exits 1 with its message`.
- `rejected runtime credentials exit 1 with the reason`.
- `an unknown --provider exits 1`.

Existing `test/commands/init.test.ts` must pass unchanged.

`test/cli.test.ts`: `setup-ci --help lists --provider` (exit 0) and `setup-ci --provider nope exits 2`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test test/commands/setup-ci.test.ts test/cli.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extract `settings-prompt.ts` from `init.ts`**, then run `pnpm test test/commands/init.test.ts` and expect PASS.

- [ ] **Step 4: Implement `setup-ci.ts` and register it in `cli.ts`.**

- [ ] **Step 5: Run tests and checker**

Run: `pnpm test && pnpm check`
Expected: PASS.

- [ ] **Step 6: Check against a real bot (Review Focus 5)**

Run `node src/cli.ts setup-ci` with a throwaway Telegram bot, pair from a phone. Expected: the phone gets the bot's paired reply, and the terminal ends with the four `JAYPOST_` lines. If the reply doesn't arrive because the bot stopped too early, wait for the runtime's in-flight handler before `stop` and re-check. If no bot is available, say so in the task report.

- [ ] **Step 7: Commit**

```bash
git add src/commands src/cli.ts test/commands/setup-ci.test.ts test/cli.test.ts
git commit -m "feat: setup-ci pairs an owner and prints direct-mode env vars"
```

---

### Task 7: Docs and changeset

**Files:**
- Modify: `README.md`
- Create: `.changeset/direct-mode.md`
- Modify (only if they mention the renamed vars or `send`'s exit codes): `site/src/**`, `docs/openapi.yaml`

- [ ] **Step 1: README**

- Config section (`README.md:531`): the `JAYPOST_` names.
- Claude Code hook (`README.md:192`): `JAYPOST_PORT`; drop the warning about an app's own `PORT`, which no longer applies.
- All `--port` mentions that say "including `PORT`".
- New section `## CI (GitHub Actions)` after "Scripts and tools": `JAYPOST_MODE`, the exit codes (0/1/2/3, and that service mode still exits 0 on any answer), no Dismiss button and no auto-delete in direct mode, `jaypost setup-ci` and its output, and this workflow example:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 24
- run: npx jaypost send request 'Publish v123?' -o Yes -d No
  env:
    JAYPOST_MODE: direct
    JAYPOST_PROVIDER: telegram
    JAYPOST_BOT_TOKEN: ${{ secrets.JAYPOST_BOT_TOKEN }}
    JAYPOST_OWNER_ID: ${{ secrets.JAYPOST_OWNER_ID }}
- run: npx jaypost send notify 'New version published'
  env: # same four
```

- `## Commands`: add `setup-ci`.

- [ ] **Step 2: Grep the rest**

Run: `grep -rnE "\b(PROVIDER|BOT_TOKEN|OWNER_ID|PORT|HOST)\b" site/src docs/openapi.yaml`
Expected: no env-var hits left (none existed when this plan was written); fix any found.

- [ ] **Step 3: `.changeset/direct-mode.md`** (`'jaypost': minor`): direct mode, the exit codes, `setup-ci`, one line pointing at the env rename changeset.

- [ ] **Step 4: Run the full suite** (site snippet checks included)

Run: `pnpm test && pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md .changeset/direct-mode.md site docs
git commit -m "docs: direct mode, setup-ci and the JAYPOST_ env vars"
```
