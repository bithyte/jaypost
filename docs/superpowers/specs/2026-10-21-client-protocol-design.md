# Client protocol design

## Intent

Everything jaypost does on the caller side of its own HTTP API (MCP server, Claude Code hook, `send`, `test`, the pairing wait, the public `Client`) goes through `src/client/`, but that module is shallow. Its interface is wide (`src/client/index.ts:1-43` exports 10 functions, 10 constants and 16 types) and each function does one HTTP step, so every caller re-assembles the protocol itself:

- Token handling. 14 of the 22 `kind === 'token'` checks in `src/` are caller-side `ClientToken` checks, in 7 files: `mcp/server.ts` (5: 201, 238, 300, 348, 479), `mcp/questions.ts:41`, `commands/send.ts:94`, `hook/runner.ts:134`, `commands/test.ts:21,30`, `commands/status.ts:51,59`, `commands/reset-owner.ts:58,78`. `toTokenOption` is copied in `send.ts:93-95` and `hook/runner.ts:133-135`, and each entry point repeats the `unusable` check first (`mcp/server.ts:185-188` four times, `send.ts:11-14`, `hook/runner.ts:16-19`, `test.ts:11-14`).
- Attachment prepare-then-check: near clones in `mcp/server.ts:468-485` and `send.ts:78-91`, a third in `Client.#prepare` (`client/client.ts:97-117`).
- Ask-body assembly: `client/client.ts:54-66`, `mcp/server.ts:496-507`, `send.ts:21-30`, `hook/runner.ts:98-108`, and raw JSON in `test.ts:23-27`.
- Background questions: only MCP has them, with its own `?wait=` long-poll loop over `MAX_WAIT_SECONDS` (`mcp/server.ts:415-442`) and its own DELETE on shutdown (`mcp/questions.ts:24-45`). The library `Client` has no background methods.
- Error discrimination by string compare: `mcp/server.ts:304` checks `result.message === describeUnknownRequest(...)` to decide whether a question is gone.
- `/status` read through three code paths: `commands/pairing-wait.ts:17-34` (global `fetch` plus `statusInfoSchema`, used by `init`, `status` and `reset-owner`), `hook/runner.ts:55-69` (ad hoc `maxTextLength` check) and `client/attachment.ts:35-48,73-78` (ad hoc `maxAttachmentBytes` check, one extra GET per attachment call).
- Two callers skip the module entirely and use global `fetch`: `commands/test.ts:17` and `commands/pairing-wait.ts:19`.

This spec deepens `src/client/` into the one caller-side protocol module: a small interface (ask, ask in background, wait, cancel, notify, status) with typed failures, and an implementation that owns tokens, attachments, body assembly, HTTP timeouts, long-polling, version-skew detection and `/status` parsing. The MCP server, hook, CLI commands and public `Client` become thin adapters that translate their own inputs and outputs.

## Goals

- One class in `src/client/` that every in-repo caller of the daemon's HTTP API uses; no caller outside `src/client/` builds a request body, a bearer header, a `/request/{id}` path or an HTTP timeout.
- Failures come back as data with a `reason` kind, so adapters switch on kinds instead of comparing message strings.
- The token is resolved through one token source per operation; the `unusable` check lives in one place.
- `/status` is parsed by one code path, with the existing `statusInfoSchema` (`src/server/schema.ts:7`), at most once per operation.
- Background questions (ask, wait with long-poll, cancel) become part of the module's interface instead of MCP's private code.
- Every user-visible message stays byte-for-byte the same as today (the copy in `src/client/constants.ts` and `src/client/http.ts:262-291`), except `jaypost test`, see below.

## Non-goals

- Resolving the port or host. The module takes a resolved port (and optional host); where that comes from is `2026-10-21-service-location-design.md`.
- Shared request/response schemas, a route table or OpenAPI changes. That's `2026-10-21-wire-contract-design.md`. This module may later take its body types and guards from there, but doesn't wait for it.
- Any change to the daemon, the HTTP API, the MCP tool schemas or the CLI flags.
- Retries, reconnects or a client-side queue.

## Anti-goals

- A transport port or fake HTTP client at the external interface. The daemon is local-substitutable (tests already start `createApiServer` or a `node:http` stub on port 0), so the transport seam stays internal.
- Keeping `callApi`, `postApi`, `requestApi`, `prepareAttachment` and friends exported "for flexibility". If they stay in `client/index.ts`, callers keep bypassing the deep interface and the clones come back.
- Messages compared as strings anywhere outside `src/client/`.
- Breaking the published `Client` (`src/index.ts:2-9`, README "From Node", CHANGELOG 0.3.0 onward).

## Decided by me (owner can override)

- The deep module is a class, `Caller`, in `src/client/caller.ts`, constructed per adapter with `{ port, host?, readToken, now? }`. One-shot adapters (send, hook, test, pairing wait) build one per run; MCP builds one per server.
- The token source is a function, `readToken: () => ClientToken`, called once per operation. That covers all current behaviours: MCP re-reads on every tool call (`cli.ts:459`), send and hook pass a value resolved once (`cli.ts:143,153`), `init` passes the token it just chose and never `JAYPOST_TOKEN` (`commands/init.ts:322-328`), and `Client` uses its explicit token or looks one up per call (`client/client.ts:148-161`).
- Results are `{ kind: 'failed', reason, message }` for every failure, with `message` holding today's copy. Adapters that only print keep doing `if (result.kind === 'failed')`; adapters that care switch on `reason`.
- Question states use the wire's names (`pending`, `done`, `cancelled`) so MCP's `structuredContent.state` maps one to one.
- `/status` is parsed with `statusInfoSchema`, imported from `src/server/schema.ts` directly, not `src/server/index.ts` (which re-exports `createApiServer` and would drag fastify into the library bundle built from `src/index.ts`, see `vite.config.ts` `pack`). This puts zod into the library's runtime import graph for the first time (today only server, parser and config modules import it). zod is already in `dependencies`, so npm installs don't change; there's some load cost I haven't measured. When the wire-contract module exists, switch the import.
- No caching across operations. Each operation does at most one `/status` GET (attachment checks only); the hook calls `status()` once and passes the limit into its own formatting. MCP is long-lived and can outlive a `jaypost init` that switches provider, so a cached limit could go stale.
- The public `Client` keeps its constructor, `request`, `notify`, `JaypostError` and its thrown messages, and becomes an adapter over `Caller`. That makes this refactor non-breaking for npm users; it needs at most a patch changeset.
- `jaypost test` goes through `Caller.ask` and prints the answer the way `send request` does. Today it prints `response.status` and the raw body (`commands/test.ts:33`); that output changes. It also fixes what I think is a latent bug: `test` sends no `timeout`, so the daemon answers at 300 s, which is exactly undici's default headers timeout for global `fetch` (README:287 warns about this for other callers). I haven't reproduced it.
- `hook/runner.ts` keeps its own `unusable` check before reading stdin (`runner.ts:16-19`). That's deliberate ordering (don't read input that can't be sent), tested by "an unusable token fails without reading stdin or calling the service", not protocol.
- `pairing-wait` keeps its injected `FetchStatus` seam (`commands/types.ts:35`), since `waitForPairing` tests drive it with scripted sequences. Only `defaultFetchStatus` becomes an adapter over `Caller.status`, mapping `unauthorized` to `UNAUTHORIZED_STATUS` and every other failure to `UNREACHABLE_STATUS`, with `STATUS_TIMEOUT_MS` kept.
- `describeUnauthorized` stays exported: `init`, `status` and `reset-owner` print it from pairing-wait's `'unauthorized'` result, which is pairing's own type.

## Constraints

- Repo style: no semicolons, single quotes, width 100 (`vite.config.ts` `fmt`), `vp check` passes. Classes use `#private` fields like `Client` and `OpenQuestions`.
- `node:http`, not global `fetch`, for every call (`client/http.ts:41-44` explains why; "does not use global fetch" in `test/client/http.test.ts:200` guards it).
- Tests use `vite-plus/test` like the rest of the suite, against real servers on port 0.
- Library entry stays free of fastify, grammY, discord.js and the MCP SDK.

## Left to the builder

- Exact `FailureReason` names, and whether `httpTimeout` and `unreachable` merge, as long as every adapter that branches today gets a kind to branch on.
- File split inside `src/client/` (whether `http.ts` and `attachment.ts` survive as internal files or fold into `caller.ts`).
- Whether MCP's `ServiceAddress` (`mcp/types.ts:7-10`) is replaced by `CallerOptions` or builds one.
- Which protocol-only MCP, hook and send tests collapse, within the rule in "Tests".
- Where each adapter's input mapping lives (`toQuestion` in send, the snake_case mapping in MCP).

## Proposed interface

```ts
// src/client/types.ts (additions)
export type CallerOptions = {
  readonly port: number
  /** Default `127.0.0.1`. */
  readonly host?: string
  /** Called once per operation, before any I/O; `unusable` fails that operation only. */
  readonly readToken: () => ClientToken
  /** Milliseconds; default `performance.now`. Drives the wait deadline and the too-old check. */
  readonly now?: () => number
}

/** Aborting `signal` ends the operation with reason `cancelled`. */
export type CallOptions = { readonly signal: AbortSignal }

/** `AskRequest` without the per-call bits; the attachment is read and checked before sending. */
export type Question = Omit<AskRequest, 'attachment' | 'signal'> & {
  readonly attachment?: AttachmentSource
}
export type Message = Omit<Notification, 'attachment' | 'signal'> & {
  readonly attachment?: AttachmentSource
}

/** `rejected` is a 400 with the daemon's own text; `attachment` is a local read or size failure. */
export type FailureReason =
  | 'unusableToken'
  | 'unreachable'
  | 'cancelled'
  | 'httpTimeout'
  | 'unauthorized'
  | 'rejected'
  | 'tooOld'
  | 'notSupported'
  | 'notPaired'
  | 'sendFailed'
  | 'unknownRequest'
  | 'unreadable'
  | 'attachment'
  | 'unexpected'

/** `message` is the copy shown today, ready for an agent or a terminal. */
export type Failure = {
  readonly kind: 'failed'
  readonly reason: FailureReason
  readonly message: string
}

export type Pending = { readonly kind: 'pending'; readonly id: string; readonly expiresAt: string }
export type Done = { readonly kind: 'done'; readonly answer: string; readonly timedOut: boolean }
export type QuestionState =
  | Pending
  | (Done & { readonly id: string })
  | { readonly kind: 'cancelled'; readonly id: string }
  | Failure

// src/client/caller.ts
/** Every call jaypost makes to its own daemon. Never throws; aborts come back as `cancelled`. */
export declare class Caller {
  constructor(options: CallerOptions)
  ask(question: Question, call: CallOptions): Promise<Done | Failure>
  askInBackground(question: Question, call: CallOptions): Promise<Pending | Failure>
  /** Long-polls until settled or `waitSeconds` passes; 0 checks once, omitted waits until settled. */
  waitFor(id: string, call: CallOptions & { readonly waitSeconds?: number }): Promise<QuestionState>
  cancel(id: string, call: CallOptions & { readonly timeoutMs?: number }): Promise<QuestionState>
  notify(message: Message, call: CallOptions): Promise<{ readonly kind: 'sent' } | Failure>
  status(
    call: CallOptions & { readonly timeoutMs?: number },
  ): Promise<{ readonly kind: 'status'; readonly status: StatusInfo } | Failure>
}
```

`client/index.ts` then exports `Caller`, `Client`, `JaypostError`, `describeUnauthorized`, `DEFAULT_ATTACHMENT_NAME`, the message constants tests assert on, and the types above plus today's public ones. `http.ts` and `attachment.ts` become internal.

An adapter then reads like this (send, after the change):

```ts
const caller = new Caller({ port: deps.port, readToken: () => deps.token })
const result = await caller.ask(toQuestion(args), { signal: deps.signal })
if (result.kind === 'failed') {
  deps.printError(`jaypost: ${result.message}`)
  return 1
}
```

## Tests

New: `test/client/caller.test.ts`, importing from `src/client/index.ts`, against `createApiServer` on port 0 (as `test/client/client.test.ts` does) and small `node:http` stubs for old-daemon shapes. It absorbs:

- From `test/client/http.test.ts` (23 tests on `callApi`/`requestApi`): transport (unreachable, reset, fractional timeout, timeout, abort, keepalive, no global fetch), 401/404/501/502/503 copy, the over-300 s too-old checks, unreadable bodies. Rewritten through `ask`/`notify`/`waitFor`, asserting `reason` and `message`. Then delete the file.
- From `test/client/attachment.test.ts` (16 tests, imports `src/client/attachment.ts` directly): path/text/bytes/stream reads, caps, stalled stdin abort, too-old and not-supported limits, "fails before uploading". Rewritten through `ask`/`notify`. Then delete the file.
- New coverage that only MCP has today: `askInBackground` then `waitFor` (done, pending after `waitSeconds`, `0` checks once, cancelled), `waitFor` on an unknown id gives `unknownRequest`, `cancel`, `status` parse and its unreadable case, `unusableToken` makes no request.

Trimmed, not moved: `test/client/client.test.ts` keeps what pins the public contract (throws `JaypostError`, `RangeError` on a bad token, abort rejects with the signal's reason, token lookup per call, `JAYPOST_TOKEN` beats the file, project default). Tests that only re-prove body fields (`format`, `allowText`, attachment delivery) go once `caller.test.ts` covers them. `test/mcp/server.test.ts` keeps tool-level tests (schemas, snake_case mapping, `isError`, `structuredContent`, progress, open-question bookkeeping, stdout, stdin close); protocol-only ones such as "an old service is reported for background asks" and "an unknown id is a tool error" can shrink to one representative each. `test/hook/runner.test.ts`, `test/commands/send.test.ts` and `test/commands/pairing-wait.test.ts` stay as adapter tests.

Rewritten: the three `runTest` tests in `test/commands/manage.test.ts:328-381` stub global `fetch` with `vi.stubGlobal`, which stops working once `test` uses `node:http`. They move to a real server on port 0.

## Migration steps

1. Add `Caller` in `src/client/caller.ts` over the existing `http.ts` and `attachment.ts` internals. Turn `describeStatus` into a `{ reason, message }` mapper (keeping `http.ts`'s current exports working on `.message`), move `isStateBody` and the long-poll loop in, and parse `/status` with `statusInfoSchema`. Add `caller.test.ts`. No caller changes yet.
2. Move MCP onto `Caller`: the four tools, `OpenQuestions.cancelAll` (an `unusableToken` cancel is the existing skip), and `wait_for_answer` settling on `reason === 'unknownRequest'`. Delete `pollState`, `prepare`, `toAskBody`, `describeUnreadable` and `PollResult`. `ServiceAddress` becomes `CallerOptions` or builds one; builder's call.
3. Move `commands/send.ts` onto `Caller`; delete its `prepare` and `toTokenOption`.
4. Move `hook/runner.ts` onto `Caller` (`status()` for `maxTextLength`, then `ask` or `notify`); delete its `toTokenOption`.
5. Make `defaultFetchStatus` an adapter over `Caller.status`; existing `pairing-wait.test.ts` stays green.
6. Move `commands/test.ts` onto `Caller.ask` and rewrite its three tests against a real server.
7. Rebuild the public `Client` on `Caller`, translating `Failure` to `JaypostError` and an abort to the signal's reason. Trim `client.test.ts` duplicates.
8. Shrink `client/index.ts` to the interface above. Delete `http.test.ts` and `attachment.test.ts` now that `caller.test.ts` covers them. Afterwards `grep -rn "kind === 'token'" src` should hit `client/`, the daemon/install side, and the spots in `status.ts`, `reset-owner.ts` and `init.ts` that hand a raw token to `waitForPairing` or pick the 401 copy. Folding those into a token source for pairing is a possible follow-up, not part of this spec.

## Open questions

- Should the public `Client` gain `askInBackground`, `waitFor` and `cancel`? It's additive (a minor changeset, a README "From Node" update; that section says `Client` covers "the same two endpoints"). I'd do it in a follow-up once `Caller` has settled, but it's your call.
- Should `JaypostError` carry the `reason` (an additive readonly field), so library users can branch on `notPaired` or `unauthorized` without parsing messages?
- Should `Caller` itself be exported from the npm package, or stay in-repo with `Client` as the only public adapter? I lean towards in-repo only, to keep the published surface small.
- Is a per-operation `/status` read fine for MCP, or do you want a short TTL cache there? I've assumed no cache.
