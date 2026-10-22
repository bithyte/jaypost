# Client Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One class, `Caller` in `src/client/caller.ts`, does every call jaypost makes to its own daemon (ask, ask in background, wait, cancel, notify, status) with `reason`-tagged failures; MCP, hook, `send`, `test`, the pairing wait and the public `Client` become thin adapters over it.

**Architecture:** `http.ts` and `attachment.ts` stay as internal files; their failures gain a `reason` (type `Failure`). `Caller` resolves the token once per operation, reads and checks attachments, builds bodies, picks HTTP timeouts, long-polls and parses `/status` with `statusInfoSchema`. Adapters move one at a time, each task green; the last task shrinks `client/index.ts` so nothing else can reach the internals.

**Tech Stack:** TypeScript on Node >= 24.2, vite-plus (`vp test`, `vp check`), `node:http`, zod (`statusInfoSchema`), MCP SDK.

**Spec:** `docs/superpowers/specs/2026-10-21-client-protocol-design.md`

## Global Constraints

- Every user-visible message stays byte-for-byte today's (copy in `src/client/constants.ts` and `src/client/http.ts:262-291`), except `jaypost test` output (Task 7).
- `node:http` for every call, never global `fetch`.
- `statusInfoSchema` imported from `src/server/schema.ts` directly, never `src/server/index.ts` (library bundle must stay free of fastify).
- Library entry (`src/index.ts`) stays free of fastify, grammY, discord.js and the MCP SDK; its exports and `Client` behaviour don't change.
- No daemon, HTTP API, MCP tool schema or CLI flag changes. No retries, no caching across operations.
- `readToken` is called exactly once per `Caller` operation, before any I/O; `unusable` fails that operation with no request sent.
- Repo conventions win over `~/.claude/rules/ts-coding-style.md`: free functions plus classes with `#private` fields and no `public` keyword (like `Client`, `OpenQuestions`), `vite-plus/test` (`expect`, `test`, `vi`), no semicolons, single quotes, width 100.
- Tests run against `createApiServer` on port 0 or `node:http` stubs on port 0; no fetch stubs.
- `pnpm test` and `pnpm check` pass at the end of every task.
- Commits: conventional, lowercase summary; no Co-Authored-By trailer.

## Review Focus

1. Ctrl-C while `send --attachment -` is still reading a stalled stdin: expect the call to end promptly with reason `cancelled` and today's message (`couldn't read attachment from stdin: ...`). Test in Task 1.
2. An old daemon whose `/status` is `{"paired":true}` (parses, no limits): attachment calls fail with `ATTACHMENT_TOO_OLD_MESSAGE` (not "unreadable"), and the hook falls back to `MAX_HOOK_TEXT_LENGTH`. Tests in Task 1 and Task 5.
3. `waitFor` with `waitSeconds: 0` on a pending question makes exactly one GET, with `?wait=0`, and returns `pending`. Test in Task 2.
4. A request id that needs encoding (`a/b`): the GET goes to `/request/a%2Fb`, a 404 is `unknownRequest`, and MCP still settles it. Test in Task 2.
5. `jaypost test` with the daemon down: exits 1 and prints `jaypost service not reachable on 127.0.0.1:<port> (run jaypost status)`, no throw. Test in Task 7.

---

### Task 1: Failure reasons and `Caller.ask`, `notify`, `status`

**Files:**
- Modify: `src/client/types.ts`, `src/client/http.ts`, `src/client/attachment.ts`, `src/client/index.ts`
- Create: `src/client/caller.ts`
- Test: `test/client/caller.test.ts` (new); delete `test/client/http.test.ts`, `test/client/attachment.test.ts`

Deleting the two old test files moves up from spec step 8: adding `reason` breaks every whole-object `toEqual` in them, and `caller.test.ts` covers the same code through the public interface from this task on.

**Interfaces:**
- Produces (`src/client/types.ts`, exported from `index.ts`): `CallerOptions`, `CallOptions`, `Question`, `Message`, `FailureReason`, `Failure`, `Pending`, `Done`, `QuestionState`, exactly as in the spec's "Proposed interface".
- Changes: `ApiResult`, `AskResult` and `AttachmentResult` failure variants become `Failure` (so they carry `reason`).
- Produces (`src/client/attachment.ts`, internal):
  - `readAttachment(source: AttachmentSource, signal: AbortSignal): Promise<ReadAttachment | Failure>` with `type ReadAttachment = { readonly kind: 'read'; readonly body: AttachmentBody; readonly byteLength: number; readonly label: string }`
  - `checkAttachmentLimit(read: ReadAttachment, maxAttachmentBytes: number | undefined): AttachmentResult`
  - `prepareAttachment` stays (re-implemented on the two above plus its own `/status` GET) until Task 9.
- Produces (`src/client/caller.ts`, exported from `index.ts`):
  - `class Caller { constructor(options: CallerOptions); ask(question, call): Promise<Done | Failure>; notify(message, call): Promise<{ readonly kind: 'sent' } | Failure>; status(call & { timeoutMs? }): Promise<{ readonly kind: 'status'; readonly status: StatusInfo } | Failure> }`
  - `StatusInfo` type from `src/server/types.ts` (type-only import, erased).

- [ ] **Step 1: Write `test/client/caller.test.ts`**

Helpers at the top: `startStub(handler)` and `freePort()` (copy from `http.test.ts`), `startApi({ maxAttachmentBytes?, notifications? })` over `createApiServer` (like `startRealServer` in `client.test.ts`, recording `ApprovalRequest`s and `NotifyRequest`s), `caller(port, token: ClientToken = NO_CLIENT_TOKEN, now?)` returning `new Caller({ port, readToken: () => token, ...(now ? { now } : {}) })`, `CALL = { signal: new AbortController().signal }`, `clock(values)` from `http.test.ts`. Import everything from `src/client/index.ts`.

Port each `http.test.ts` and `attachment.test.ts` test, going through `caller.ask`/`notify`/`status` and asserting whole results with `reason`. Expected `reason` per case (message unchanged from the old test):

| Case | Call | reason |
|---|---|---|
| unreachable port, connection reset, fractional timeout `1.0005` | ask | `unreachable` |
| stub never answers, `status({ ...CALL, timeoutMs: 50 })` | status | `httpTimeout` (`didn't answer within 0.05 s`) |
| caller abort mid-request | ask | `cancelled` (`'cancelled'`), socket closed |
| 401 without / with token (message never contains the token) | ask | `unauthorized` |
| 400 `{"error":"options must be unique"}` | ask | `rejected` |
| 404 on `/notify` | notify | `tooOld` |
| 501 notify / 501 `attachments not supported` on ask and notify | both | `notSupported` |
| 503 | ask | `notPaired` |
| 502 | ask | `sendFailed` |
| 500, and 404 with non-JSON `<html>nope</html>` | ask | `unexpected` |
| 200 non-JSON body, `{"answer":1}` | ask | `unreadable` |
| timed out at 300 s on a 900 s ask (`now: clock([0, 300_000])`) | ask | `tooOld` (`TIMEOUT_TOO_OLD_MESSAGE`) |
| missing file, directory, over cap by stat, unreadable file (chmod 000), stdin over cap, over the service limit | ask/notify | `attachment` |
| `/status` `{"paired":true}` with an attachment | ask | `tooOld` (`ATTACHMENT_TOO_OLD_MESSAGE`) |
| `maxAttachmentBytes: 0` | ask | `notSupported` (`ATTACHMENT_NOT_SUPPORTED_MESSAGE`) |

Keep as-is in substance: `test('does not use global fetch', ...)` (stub `fetch` to reject, `notify` returns `{ kind: 'sent' }`), `test('sockets use tcp keepalive', ...)`, the three non-flagged too-old cases (`[0, 900_000]`, `108_000` with `[0, 86_400_000]`, `timedOut: false` early, `300`/`undefined`) returning `{ kind: 'done', answer: 'Decline', timedOut: true }` (or `false`), the bearer header sent only with a `token` `ClientToken`, `stdin over the cap` pulling at most 11 chunks, and `a file over the service limit fails before uploading` (stub `seen` is exactly `['GET /status']`).

New tests:

```ts
test('ask returns the answer and sends every field', async () => {
  const { port, requests } = await startApi({ maxAttachmentBytes: 1000 })
  const result = await caller(port).ask(
    { text: 'Deploy?', options: ['Approve'], allowText: true, timeoutOption: 'Approve',
      timeout: 60, project: 'api', format: 'markdown', attachment: { name: 'a.diff', text: 'x' } },
    CALL,
  )
  expect(result).toEqual({ kind: 'done', answer: 'Approve', timedOut: false })
  // assert requests[0] carries project, format, allowText, timeout 60 and the attachment bytes
})
test('notify omits unset fields', ...)              // stub records body: exactly { text: 'done' }
test('an unusable token makes no request', ...)      // ask, notify and status each return
                                                     // { kind: 'failed', reason: 'unusableToken', message: 'bad token' }; stub saw nothing
test('readToken runs once per operation', ...)       // ask with attachment: readToken spy called 1 time, stub saw GET /status then POST /request
test('status parses the daemon status', ...)         // stub {"paired":true,"bot":"b","maxTextLength":3900}:
                                                     // { kind: 'status', status: { paired: true, bot: 'b', maxTextLength: 3900 } }
test('an unreadable status is unreadable', ...)      // stub {"nope":1}: { kind: 'failed', reason: 'unreadable', message: 'jaypost service sent an unreadable answer: {"nope":1}' }
test('an abort during a stalled stdin read is cancelled', ...) // Review Focus 1:
  // { kind: 'failed', reason: 'cancelled', message: expect.stringMatching(/^couldn't read attachment from stdin: /) }
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vp test test/client/caller.test.ts`
Expected: FAIL, `Caller` is not exported from `src/client/index.ts`.

- [ ] **Step 3: Add the types to `src/client/types.ts`**

As in the spec, plus `ApiResult = { kind: 'ok'; body: unknown } | Failure`, `AskResult = { kind: 'ok'; outcome: Answer } | Failure`, `AttachmentResult = { kind: 'ok'; attachment: AttachmentBody } | Failure`. Import `AskRequest`/`Notification` locally for `Question`/`Message`.

- [ ] **Step 4: Give `http.ts` failures a reason**

`describeStatus` becomes `toStatusFailure(status, path, text, sentToken): Failure` and `describeTransportFailure` becomes `toTransportFailure(port, options, timeout): Failure`, same branch order, reasons from the table above (`/request/async` 404 is `tooOld`, `/request/{id}` 404 is `unknownRequest`). `parseOk` and `requestApi`'s unreadable cases are `unreadable`; the early-timeout case is `tooOld`. `describeUnauthorized` and `describeUnknownRequest` stay exported.

- [ ] **Step 5: Split `attachment.ts`**

`readAttachment` is today's `describeSource` + `readSource`, returning `label` with the read; on failure, reason `signal.aborted ? 'cancelled' : 'attachment'`, message unchanged. `checkAttachmentLimit` is today's lines 43-52 (`undefined` limit `tooOld`, `0` `notSupported`, over `attachment`). `prepareAttachment` becomes `readAttachment` → `callApi('/status')` → `readLimit` → `checkAttachmentLimit`.

- [ ] **Step 6: Implement `Caller` in `src/client/caller.ts`**

Fields `#port`, `#host` (`options.host ?? HOST`), `#readToken`, `#now` (`options.now ?? (() => performance.now())`). Each public method calls `#readToken()` once; `unusable` returns `{ kind: 'failed', reason: 'unusableToken', message: token.message }`; `token` becomes `{ token: token.token }` on the `ApiOptions`. A private `#attach(source, token, signal)` does `readAttachment` → `#fetchStatus` → `checkAttachmentLimit`; a private `#fetchStatus(token, signal, timeoutMs)` does `callApi('GET', '/status')` + `statusInfoSchema.safeParse`, unreadable on parse failure, and backs both `status()` and `#attach`. Bodies omit unset fields (spread pattern as in `client.ts:56-65`). Timeouts: ask via `requestApi` (passes `now: this.#now`), notify `toSendTimeoutMs(hasAttachment)`, status `call.timeoutMs ?? FETCH_GRACE_MS`. Export `Caller` and the new types from `index.ts`.

- [ ] **Step 7: Delete `test/client/http.test.ts` and `test/client/attachment.test.ts`; run tests and check**

Run: `pnpm test && pnpm check`
Expected: PASS. MCP, send, hook and client tests stay green untouched (they assert messages, not whole failure objects).

- [ ] **Step 8: Commit**

```bash
git add src/client test/client
git commit -m "refactor: add Caller with typed failures for ask, notify and status"
```

### Task 2: Background questions on `Caller`

**Files:**
- Modify: `src/client/caller.ts`, `src/client/http.ts` (move nothing out yet; `isStateBody` stays there)
- Test: `test/client/caller.test.ts`

**Interfaces:**
- Consumes: Task 1's `Caller`, `Failure`, `Pending`, `Done`, `QuestionState`.
- Produces on `Caller`:
  - `askInBackground(question: Question, call: CallOptions): Promise<Pending | Failure>`
  - `waitFor(id: string, call: CallOptions & { readonly waitSeconds?: number }): Promise<QuestionState>`
  - `cancel(id: string, call: CallOptions & { readonly timeoutMs?: number }): Promise<QuestionState>`

- [ ] **Step 1: Write the failing tests**

Against `startApi()` with a real `ApprovalService` and a recording messenger (as in `test/mcp/server.test.ts:129-150`), using `service.tap(id, 0)` to answer:

```ts
test('askInBackground then waitFor returns the answer', ...)
  // { kind: 'pending', id, expiresAt: expect.any(String) }, then after tap
  // waitFor(id, CALL) → { kind: 'done', id, answer: 'Approve', timedOut: false }
test('waitFor reports pending once waitSeconds passes', ...)       // waitSeconds 0.2 → { kind: 'pending', id, expiresAt }
test('waitFor with waitSeconds 0 checks once', ...)                // Review Focus 3: stub records urls; exactly
                                                                   // ['GET /request/x?wait=0'], result pending
test('waitFor on an unknown id is unknownRequest', ...)            // id 'a/b' (Review Focus 4): stub saw '/request/a%2Fb?wait=...',
  // { kind: 'failed', reason: 'unknownRequest', message: "jaypost doesn't know request a%2Fb (the service restarted, or the answer expired after 24 h)" }
test('cancel returns cancelled and waitFor then sees it', ...)    // { kind: 'cancelled', id } twice
test('askInBackground on an old service is tooOld', ...)          // stub 404 → BACKGROUND_TOO_OLD_MESSAGE
test('an unreadable state body is unreadable', ...)               // stub 200 {"id":"x","state":"pending"} on GET
test('an unusable token makes no background request', ...)       // askInBackground, waitFor, cancel: unusableToken, stub saw nothing
```

The `a%2Fb` message pins today's behaviour (MCP encodes the id before building the path, and the 404 copy quotes the path segment).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vp test test/client/caller.test.ts`
Expected: FAIL, `askInBackground` is not a function.

- [ ] **Step 3: Implement the three methods**

`askInBackground`: same attachment/body path as `ask`, `POST /request/async` with `toSendTimeoutMs(hasAttachment)`; body must pass `isStateBody` with `state === 'pending'`, else `unreadable` with `` `jaypost service sent an unreadable answer: ${JSON.stringify(body)}` ``. `waitFor`: today's `pollState` (`mcp/server.ts:415-442`) moved in, path `` `/request/${encodeURIComponent(id)}` ``, deadline from `this.#now()` (read once at start, then per loop for `isDue`); no `waitSeconds` cap here (MCP keeps its own). `cancel`: `DELETE` same path, `call.timeoutMs ?? FETCH_GRACE_MS`, state body required. A private `toQuestionState(body: StateBody): QuestionState` maps `state` to `kind` (`done` keeps `id`, `answer`, `timedOut`).

- [ ] **Step 4: Run tests and check**

Run: `pnpm test && pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client test/client
git commit -m "refactor: add background questions to Caller"
```

### Task 3: MCP server on `Caller`

**Files:**
- Modify: `src/mcp/server.ts`, `src/mcp/questions.ts`, `src/mcp/types.ts`, `src/mcp/index.ts`
- Test: `test/mcp/server.test.ts`

**Interfaces:**
- Consumes: `Caller`, `CallerOptions`, `Question`, `QuestionState`, `AttachmentSource`, `DEFAULT_ATTACHMENT_NAME` from `../client/index.ts`.
- Produces:
  - `createMcpServer(caller: Caller, signal: AbortSignal, options?: McpServerOptions): McpServer`
  - `runMcp(options: CallerOptions): Promise<number>` (`cli.ts:457` keeps passing `{ port, readToken }`)
  - `OpenQuestions.cancelAll(caller: Caller, timeoutMs?: number): Promise<void>`
  - `ServiceAddress` and `PollResult` deleted (types and `index.ts` export).

- [ ] **Step 1: Update tests to the new signatures**

`createMcpServer(address, ...)` calls (`server.test.ts:648`, `:846`) pass `new Caller(address)`; `cancelAll({ port, readToken }, 100)` becomes `cancelAll(new Caller({ port, readToken }), 100)` (three tests). Add one test:

```ts
test('an unknown id settles the open question', ...)
  // in-process like 'a long ask sends progress': openQuestions = new OpenQuestions(),
  // openQuestions.add('nope'), createMcpServer(new Caller({ port, readToken }), signal,
  // { openQuestions }) on startApi(); wait_for_answer { request_id: 'nope' } → isError;
  // then openQuestions.cancelAll(new Caller({ port: recordingStubPort, readToken })) → stub saw []
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vp test test/mcp/server.test.ts`
Expected: FAIL on type/arg mismatch (`createMcpServer` reads `address.readToken`).

- [ ] **Step 3: Move the tools onto `Caller`**

Each tool: `const callSignal = AbortSignal.any([extra.signal, signal])`, then one `caller` call, `toErrorResult(result.message)` on `failed`. `toAskBody` becomes `toQuestion(args: AskArguments): Question` (snake_case mapping, attachment through the existing `toAttachmentSource`). `ask_for_permission` wraps `caller.ask` in `startProgress` (it now also covers the attachment read; harmless). `wait_for_answer` keeps its `MAX_TIMEOUT_SECONDS` cap and progress, calls `caller.waitFor(args.request_id, { signal, waitSeconds })`, settles on `result.reason === 'unknownRequest'` or any non-`pending` state; `toWaitResult` switches on `kind`. `cancelAll` maps ids to `caller.cancel(id, { signal: new AbortController().signal, timeoutMs })`; an unusable token returns `unusableToken` per id with no request, which is the skip. Delete `pollState`, `prepare`, `Prepared`, `toAskBody`, `describeUnreadable`, `PollResult`, `ServiceAddress`; drop now-unused client imports.

- [ ] **Step 4: Run tests and check**

Run: `pnpm test && pnpm check`
Expected: PASS, every existing MCP test unchanged except the signature edits.

- [ ] **Step 5: Commit**

```bash
git add src/mcp test/mcp
git commit -m "refactor: route mcp tools through Caller"
```

### Task 4: `send` on `Caller`

**Files:**
- Modify: `src/commands/send.ts`
- Test: `test/commands/send.test.ts` (no changes expected)

**Interfaces:**
- Consumes: `Caller`, `Question`, `Message`.
- Produces: `runSendRequest`/`runSendNotify` signatures unchanged.

- [ ] **Step 1: Rewrite both functions as in the spec's adapter example**

`new Caller({ port: deps.port, readToken: () => deps.token })`; a private `toQuestion(args: SendRequestArgs): Question` drops `json`; `runSendNotify` passes `{ text, project?, format?, attachment? }`. Failure prints `` `jaypost: ${result.message}` ``. Delete `prepare`, `Prepared`, `toTokenOption` and the `unusable` checks.

- [ ] **Step 2: Run tests and check**

Run: `pnpm exec vp test test/commands/send.test.ts && pnpm check`
Expected: PASS with no test edits (the unusable-token test still sees `jaypost: <message>` and no request).

- [ ] **Step 3: Commit**

```bash
git add src/commands/send.ts
git commit -m "refactor: route send through Caller"
```

### Task 5: Hook on `Caller`

**Files:**
- Modify: `src/hook/runner.ts`
- Test: `test/hook/runner.test.ts`

**Interfaces:**
- Consumes: `Caller` (`status`, `ask`, `notify`).
- Produces: `runHook` signature unchanged.

- [ ] **Step 1: Write the failing test (Review Focus 2)**

```ts
test('an old status without maxTextLength keeps the default cap', ...)
  // stub: GET /status → {"paired":true}, POST /notify → {} ; a Notification event whose message
  // is longer than MAX_HOOK_TEXT_LENGTH; the posted text is cut to MAX_HOOK_TEXT_LENGTH
```

Run: `pnpm exec vp test test/hook/runner.test.ts`. It may already pass (today's ad hoc check behaves the same); keep it as the regression pin either way.

- [ ] **Step 2: Move the runner onto `Caller`**

Keep the `unusable` check before `readInput` (spec decision). Build one `Caller` in `runHook` and pass it down. `resolveMaxLength(project, caller, signal)`: `caller.status({ signal })`; `kind === 'status'` and `typeof status.maxTextLength === 'number'` gives `Math.min(MAX_HOOK_TEXT_LENGTH, maxTextLength - (project.length + 4))`, else `MAX_HOOK_TEXT_LENGTH`. `notify`: `caller.notify({ project, text }, { signal })`. `askPermission`: `caller.ask({ project, text, options, timeoutOption: ASK_IN_TERMINAL_OPTION, timeout: args.timeout ?? DEFAULT_TIMEOUT_SECONDS }, { signal })`, then `decidePermission(event, question.options, { answer: result.answer, timedOut: result.timedOut })`. Delete `toTokenOption` and the `callApi`/`postApi`/`requestApi`/`FETCH_GRACE_MS` imports.

- [ ] **Step 3: Run tests and check**

Run: `pnpm test && pnpm check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/hook test/hook
git commit -m "refactor: route the hook through Caller"
```

### Task 6: Pairing wait status over `Caller.status`

**Files:**
- Modify: `src/commands/pairing-wait.ts`
- Test: `test/commands/pairing-wait.test.ts` (no changes expected)

**Interfaces:**
- Consumes: `Caller.status`.
- Produces: `defaultFetchStatus(port: number, token?: string): Promise<StatusFetch>` unchanged; `FetchStatus` seam unchanged.

- [ ] **Step 1: Make `defaultFetchStatus` an adapter**

`new Caller({ port, readToken: () => (token === undefined ? NO_CLIENT_TOKEN : { kind: 'token', token, source: 'file' }) })`, then `status({ signal: new AbortController().signal, timeoutMs: STATUS_TIMEOUT_MS })`. `status` → `{ kind: 'answered', status }`; `reason === 'unauthorized'` → `UNAUTHORIZED_STATUS`; any other failure → `UNREACHABLE_STATUS`. Drop the `statusInfoSchema` import and the `try/catch`.

- [ ] **Step 2: Run tests and check**

Run: `pnpm exec vp test test/commands/pairing-wait.test.ts test/commands/init.test.ts test/commands/manage.test.ts && pnpm check`
Expected: PASS with no test edits.

- [ ] **Step 3: Commit**

```bash
git add src/commands/pairing-wait.ts
git commit -m "refactor: read pairing status through Caller"
```

### Task 7: `jaypost test` on `Caller.ask`

**Files:**
- Modify: `src/commands/test.ts`
- Test: `test/commands/manage.test.ts:328-381`
- Create: `.changeset/test-command-answer.md`

**Interfaces:**
- Consumes: `Caller.ask`.
- Produces: `runTest(fallbackPort, installFile, token)` signature unchanged.

- [ ] **Step 1: Rewrite the three `runTest` tests against a real stub**

A `node:http` stub on port 0 recording `{ url, authorization }` and answering per test; `writeInstall(paths.installFile, { target: 'systemd', port: stubPort, version: '1.0.0' })` instead of `seed()`; `console.log`/`console.error` spied as today. No `vi.stubGlobal`.

```ts
test('test command takes port from install.json first and prints the answer', ...)
  // runTest(1, installFile, NO_CLIENT_TOKEN) → 0; stub saw POST /request, no authorization;
  // console.log called with 'Decline' (stub answers {"answer":"Decline","timedOut":true})
test('test sends the token and explains a 401', ...)      // → 1, Bearer token seen, console.error(TOKEN_REJECTED_MESSAGE)
test('test with an unusable token fails before calling', ...) // → 1, stub saw nothing, console.error('bad token here')
test('test with the service down reports it', ...)        // Review Focus 5: freePort in install.json → 1,
  // console.error(`jaypost service not reachable on 127.0.0.1:${port} (run jaypost status)`)
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vp test test/commands/manage.test.ts`
Expected: FAIL (the first prints `200 {...}`, the last prints the old `could not reach` copy).

- [ ] **Step 3: Rewrite `runTest`**

Port lookup unchanged. `new Caller({ port, readToken: () => token }).ask({ text: 'This is a test', options: ['Approve', 'Decline'], timeoutOption: 'Decline' }, { signal: new AbortController().signal })`. `failed` → `console.error(result.message)`, return 1. Done → `console.log(result.answer)`, return 0. Delete the `unusable` check, `fetch`, `describeUnauthorized` import and `try/catch`.

- [ ] **Step 4: Write the changeset**

```md
---
'jaypost': patch
---

`jaypost test` now prints the answer, the way `jaypost send request` does, instead of the HTTP status and raw body. It no longer goes through `fetch`, so a test left unanswered for the full 300 s doesn't hit fetch's headers timeout.
```

- [ ] **Step 5: Run tests and check**

Run: `pnpm test && pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/commands/test.ts test/commands/manage.test.ts .changeset/test-command-answer.md
git commit -m "refactor: send jaypost test through Caller"
```

### Task 8: Public `Client` over `Caller`

**Files:**
- Modify: `src/client/client.ts`
- Test: `test/client/client.test.ts`

**Interfaces:**
- Consumes: `Caller.ask`, `Caller.notify`.
- Produces: `Client`, `JaypostError`, `ClientOptions` and thrown messages unchanged.

- [ ] **Step 1: Rebuild `Client`**

Constructor validates the token as today, then sets `#caller = new Caller({ port, host, readToken: () => this.#readToken() })`. `#readToken(): ClientToken` returns `{ kind: 'token', token: this.#token, source: 'env' }` for an explicit token (`Caller` ignores `source`), else `resolveClientToken(process.env, resolveTokenFile(process.env))`. `request`: `caller.ask({ ...fields, project: request.project ?? this.#project }, { signal })`; then `if (signal.aborted) throw signal.reason`; `failed` → `throw new JaypostError(result.message)`; return `{ answer, timedOut }`. `notify` the same over `caller.notify`. Delete `#prepare`, `#post`, `#resolveToken`.

- [ ] **Step 2: Trim `client.test.ts`**

Delete (covered in `caller.test.ts`): `request sends format when set`, `notify sends format when set`, `format is omitted by default`, the `allowText is sent...` test(s), `request with a path attachment delivers the file bytes`, `notify with a text attachment delivers it`, and `startRealServer` if nothing else uses it. Keep the rest, including `an attachment against an old service throws the upgrade message` and `a missing attachment file throws JaypostError` (they pin the throw).

- [ ] **Step 3: Run tests and check**

Run: `pnpm test && pnpm check`
Expected: PASS, including `test/pack.test.ts` (library bundle).

- [ ] **Step 4: Commit**

```bash
git add src/client/client.ts test/client/client.test.ts
git commit -m "refactor: build the public Client on Caller"
```

### Task 9: Shrink `client/index.ts`

**Files:**
- Modify: `src/client/index.ts`, `src/client/http.ts`, `src/client/attachment.ts`, `src/client/types.ts`

**Interfaces:**
- Produces (`src/client/index.ts`, complete):
  - Values: `Caller`, `Client`, `JaypostError`, `describeUnauthorized`, `DEFAULT_ATTACHMENT_NAME`, `ATTACHMENT_NOT_SUPPORTED_MESSAGE`, `ATTACHMENT_TOO_OLD_MESSAGE`, `BACKGROUND_TOO_OLD_MESSAGE`, `TIMEOUT_TOO_OLD_MESSAGE`, `TOKEN_REJECTED_MESSAGE`, `TOKEN_REQUIRED_MESSAGE` (add any other constant a test imports).
  - Types: `Answer`, `AskRequest`, `AttachmentInput`, `AttachmentSource`, `ClientOptions`, `Notification`, `CallerOptions`, `CallOptions`, `Question`, `Message`, `FailureReason`, `Failure`, `Pending`, `Done`, `QuestionState`.

- [ ] **Step 1: Cut the exports and dead code**

Remove from `index.ts` everything not listed above (`prepareAttachment`, `callApi`, `postApi`, `requestApi`, `isOutcome`, `isStateBody`, `toFetchTimeoutMs`, `toSendTimeoutMs`, `describeUnknownRequest`, `ATTACHMENT_GRACE_MS`, `FETCH_GRACE_MS`, `LEGACY_MAX_TIMEOUT_SECONDS`, the `Api*`, `AskBody`, `AskOptions`, `AskResult`, `AttachmentBody`, `AttachmentResult`, `StateBody` types). Delete `prepareAttachment` and `readLimit` from `attachment.ts`; unexport `http.ts` helpers that only `caller.ts` uses where nothing else in `src/client/` imports them.

- [ ] **Step 2: Run tests, check, and grep**

Run: `pnpm test && pnpm check`
Expected: PASS.

Run: `grep -rn "kind === 'token'" src`
Expected: hits only in `src/client/`, the daemon/install side (`auth`, `daemon`, `install`), and `commands/status.ts`, `commands/reset-owner.ts`, `commands/init.ts` (spec step 8 lists these as a follow-up).

Run: `grep -rnE "Bearer |postApi|callApi|requestApi|prepareAttachment|fetch\(" src --include=*.ts | grep -v "^src/client/\|^src/server/"`
Expected: no hits except non-daemon `fetch` calls (the `update` module's release and npm lookups); anything else is a caller still bypassing `Caller`.

- [ ] **Step 3: Commit**

```bash
git add src/client
git commit -m "refactor: shrink the client module to Caller and Client"
```
