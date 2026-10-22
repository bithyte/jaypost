# Wire Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One module, `src/wire/`, owns every HTTP request and response shape, the wire limits and the route table; the server, `Caller`, the 405 handler, the token guard and the OpenAPI generator read it instead of restating it.

**Architecture:** Plain zod schemas and hand-written response types in `src/wire/`, with guards the client parses responses through. `approval/parser.ts` and `notify/parser.ts` keep only the formatting transform on top of the wire shape schemas. `ROUTES` is plain data: Fastify handlers stay hand-written, but the not-found handler, the token guard and the OpenAPI `paths` are derived from it. The OpenAPI generator stays in `src/server/openapi.ts` and turns wire schemas into components with a local zod registry.

**Tech Stack:** TypeScript on Node >= 24.2, zod 4.6 (`z.toJSONSchema`, `.meta`, `z.registry`), Fastify 5, vite-plus (`vp test`, `vp check`, `vp pack`), `yaml`.

**Spec:** `docs/superpowers/specs/2026-10-21-wire-contract-design.md`

## Where the code moved since the spec

The client-protocol refactor (0f721ec..54e44ec) landed after the spec was written. Read the spec's client references through this table:

| Spec says | Now |
|---|---|
| `isStateBody` in `client/http.ts:205` | still `client/http.ts:211`, called from `client/caller.ts:81,110,142` |
| `isOutcome` in `client/http.ts:235` | `client/http.ts:241`, called from `requestApi` |
| `readLimit` in `client/attachment.ts`, `/status` check in `hook/runner.ts:55-66` | gone; `Caller.#fetchStatus` (`caller.ts:206`) parses with `statusInfoSchema`, the hook reads `caller.status()` |
| `commands/pairing-wait.ts:26` uses the status schema | goes through `Caller.status()`; only `StatusInfo` types remain (`commands/types.ts`, `commands/pairing-text.ts`, `daemon/service.ts`, three tests) |
| `test/client/http.test.ts:356-364` | deleted; `test/client/caller.test.ts:651` (`an unreadable state body is unreadable`) covers it and stays |
| `mcp/server.ts`, `mcp/types.ts` use `StateBody`/`Answer` | they don't; MCP only needs the limit fixes |

## Decisions this plan takes

- **zod in the library: already there.** `caller.ts` imports `statusInfoSchema`, so today's `dist/index.cjs` already does `require("zod")`. The spec's first open question is moot; nothing to measure.
- **`expiresAt` stays `z.string()`** with `.meta({ format: 'date-time', description: 'When the timeout fires.' })`. `z.iso.datetime()` adds a 400-character `pattern` to the OpenAPI document and rejects hand-rolled servers. Answers the spec's second open question.
- **`AskBody`/`NotifyBody` are `ReadonlyBody<z.input<...>>`** with a local `type ReadonlyArrays<V> = V extends readonly (infer U)[] ? readonly U[] : V` and `type ReadonlyBody<T> = { readonly [K in keyof T]: ReadonlyArrays<T[K]> }` in `wire/types.ts`. `.readonly()` on the array schema is out: it emits `readOnly: true` into the OpenAPI document.
- **`AttachmentBody` stays the exclusive `{ name, text } | { name, data }`**, hand-written in `wire/types.ts`. `Caller` assigns it into `AskBody.attachment`, so the compiler checks it against the schema input.
- **The attachment transform's output type is inferred**, not annotated with approval's `Attachment`; `approval/types.ts` keeps `Attachment` and the two are structurally equal. `wire/` never imports `approval/`.
- **approval's `Outcome` becomes `export type Outcome = Answer`** (imported from `wire/`), so the `/request` response and the service's result are one type.
- **`StatusInfo` is renamed `StatusBody`** everywhere (hand-written in `wire/types.ts`); `server/schema.ts` is deleted.
- **The token guard becomes one global `onRequest` hook** that looks up `request.routeOptions.url` and the method in `ROUTES`, treating `HEAD` as `GET`. Fastify serves `HEAD` for every `GET` route and today's per-route guard covers it (checked: `HEAD /status` answers 401); a lookup on the raw method would open `HEAD /request/:id` and its long-poll.
- **`findAllowedMethods` prefers a literal path over a `{param}` path**, so `PUT /request/async` stays `Allow: POST` as today.
- **The `.d.ts` check is "no zod types", not "no `zod`".** Today's `dist/index.d.ts` already starts with an unused `import { z } from "zod"` (`index.d.cts`: `import "zod"`), a bundler leftover. Task 6 asserts no `z.` and no `Zod` identifiers.
- **`ApiPath` stays hand-written** in `client/types.ts`.

## Global Constraints

- Node >= 24.2, zod 4.6. No new runtime or dev dependency.
- No wire format change: same paths, methods, status codes, fields, headers and error messages. Every zod error message stays byte-identical and the first issue reported stays the same; `test/approval/parser.test.ts` and `test/notify/parser.test.ts` pass unchanged through every task.
- `src/wire/` imports only `zod` and `src/format/index.ts`. Nothing in it imports `approval`, `server`, `client`, `yaml`, `fastify` or `config`.
- Never put `id` in `.meta()`: request schemas are built per request and `z.globalRegistry` throws on a duplicate id. Component names come from a registry local to `createOpenApiDocument`.
- No runtime parsing of responses on the server; no request body parsed twice.
- `docs/openapi.yaml` stays generated by `vp run openapi` and checked by `test/server/openapi.test.ts`. OpenAPI component names stay (`Outcome`, `PendingRequest`, `RequestState`, `Status`, `ApprovalRequest`, `NotifyRequest`, `Attachment`, `Error`).
- The library bundle exports exactly `Client`, `JaypostError`, `escapeMarkdown`, `formatCodeBlock` and contains no grammy, fastify, yaml or friends.
- Repo style, not the class-per-module rule: plain exported functions and `type`s, no semicolons, single quotes, width 100, `vite-plus/test`.
- `pnpm test` and `pnpm check` pass at the end of every task.
- Commits: conventional, lowercase summary, no Co-Authored-By trailer.

## Review Focus

1. `HEAD /status` and `HEAD /request/abc` against a service with a token and no `authorization` header: 401 as today, handler not run. Test in Task 3.
2. `PUT /request/async`: 405 with `Allow: POST`, not `GET, DELETE`; `GET /request/async` still reaches the get handler and answers 404 `unknown request`. Tests in Task 3.
3. `/request/`, `/request/a/b` and `//` with a wrong method: 404 `not found`, not 405, and the server keeps serving. Test in Task 3.
4. A daemon (older, or hand-rolled) whose `/status` has extra fields or no limits, or whose `expiresAt` isn't ISO: the client still reads it and keeps the extra fields. Test in Task 2.
5. A body the shape schema accepts but formatting rejects (`format: 'markdown'` with a text that's only an empty code span): the wire schema passes it and `parseApprovalRequest` still answers `text must not be blank after formatting`. Test in Task 4.

---

### Task 1: Wire limits

**Files:**
- Create: `src/wire/constants.ts`, `src/wire/index.ts`
- Modify: `src/approval/constants.ts`, `src/approval/index.ts`, `src/approval/parser.ts`, `src/client/attachment.ts`, `src/client/caller.ts`, `src/client/http.ts`, `src/hook/project.ts`, `src/hook/runner.ts`, `src/mcp/server.ts`, `src/provider/settings.ts`, `src/server/openapi.ts`
- Test (imports only): `test/client/caller.test.ts`, `test/commands/send.test.ts`, `test/mcp/server.test.ts`, `test/provider/settings.test.ts`, `test/server/server.test.ts`

**Interfaces:**
- Produces (`src/wire/constants.ts`, re-exported from `src/wire/index.ts`): `MAX_OPTION_LENGTH = 64`, `MAX_PROJECT_LENGTH = 100`, `MAX_ATTACHMENT_NAME_LENGTH = 255`, `MAX_ATTACHMENT_BYTES = 10_485_760`, `DEFAULT_TIMEOUT_SECONDS = 300`, `MAX_TIMEOUT_SECONDS = 86_400`, `MAX_WAIT_SECONDS = 120`, with their JSDoc moved verbatim.

A pure move; the existing suite is the test.

- [ ] **Step 1: Move the seven constants** out of `src/approval/constants.ts` into `src/wire/constants.ts`, drop them from `src/approval/index.ts` (no re-export), and point every importer in the file list at `../wire/index.ts` (tests: `../../src/wire/index.ts`).
- [ ] **Step 2: Replace the MCP literals** in `src/mcp/server.ts`: `.max(255)` in `attachmentNameSchema` becomes `.max(MAX_ATTACHMENT_NAME_LENGTH)`; the `timeout_option` description's `(max 64 chars)` becomes `` (max ${MAX_OPTION_LENGTH} chars) ``. The strings the SDK sees don't change.
- [ ] **Step 3: Verify nothing still reaches the limits through approval**

Run: `grep -rnE "\b(MAX_OPTION_LENGTH|MAX_PROJECT_LENGTH|MAX_ATTACHMENT_NAME_LENGTH|MAX_ATTACHMENT_BYTES|DEFAULT_TIMEOUT_SECONDS|MAX_TIMEOUT_SECONDS|MAX_WAIT_SECONDS)\b" src test scripts | grep -v "^src/wire/"`
Expected: every hit is a use or an import from `wire`; none in `src/approval/constants.ts` or `src/approval/index.ts`.

- [ ] **Step 4: Run** `pnpm test && pnpm check && git diff --exit-code docs/openapi.yaml`. Expected: all pass, YAML untouched.
- [ ] **Step 5: Commit** `refactor: move wire limits into src/wire`

---

### Task 2: Response schemas, types and guards

**Files:**
- Create: `src/wire/types.ts`, `src/wire/schema.ts`, `src/wire/parser.ts`; extend `src/wire/index.ts`
- Delete: `src/server/schema.ts`
- Modify: `src/server/types.ts`, `src/server/index.ts`, `src/server/server.ts`, `src/server/openapi.ts` (import only), `src/client/http.ts`, `src/client/caller.ts`, `src/client/types.ts`, `src/client/client.ts`, `src/client/index.ts`, `src/index.ts`, `src/approval/types.ts`, `src/commands/types.ts`, `src/commands/pairing-text.ts`, `src/daemon/service.ts`
- Test: `test/wire/schema.test.ts` (new); `test/server/server.test.ts`; `StatusInfo` → `StatusBody` in `test/commands/pairing-wait.test.ts`, `test/commands/manage.test.ts`

**Interfaces:**
- Produces (`src/wire/types.ts`): `Answer` and `StateBody` exactly as in the spec; `StatusBody` as a plain union mirroring today's `statusInfoSchema` (`paired: true` branch; `paired: false` branch with `code: string` and optional `instructions`; both with optional `provider`, `displayName`, `bot`, `maxAttachmentBytes`, `maxTextLength`, `maxOptionCount`), all fields `readonly`; `NotifyResult = { readonly ok: true }`.
- Produces (`src/wire/schema.ts`): `answerSchema: z.ZodType<Answer>`, `pendingStateSchema` (the pending branch, exported for the OpenAPI registry), `stateBodySchema: z.ZodType<StateBody>` (`z.discriminatedUnion('state', ...)` of `z.object`s, not loose), `statusBodySchema: z.ZodType<StatusBody>` (today's `statusInfoSchema` body, `z.looseObject` branches), `notifyResultSchema: z.ZodType<NotifyResult>` (`z.object({ ok: z.literal(true) })`).
- Produces (`src/wire/parser.ts`): `isAnswer(body: unknown): body is Answer`, `isStateBody(body: unknown): body is StateBody`, `parseStatusBody(body: unknown): StatusBody | undefined` (returns the parsed data, extra fields kept). Each is `safeParse(...).success` and never throws.
- `src/index.ts` exports `type Answer` from `./wire/index.ts`; `client/index.ts` stops exporting `Answer`.

- [ ] **Step 1: Write `test/wire/schema.test.ts`** (imports from `../../src/wire/index.ts`)

```ts
test('isAnswer accepts an answer with extra fields', () => {
  expect(isAnswer({ answer: 'Yes', timedOut: false, extra: 1 })).toBe(true)
})
test.each([null, 'Yes', {}, { answer: 'Yes' }, { answer: 1, timedOut: false }, { answer: 'Yes', timedOut: 'no' }])(
  'isAnswer rejects %j', (body) => expect(isAnswer(body)).toBe(false))
test('isStateBody accepts the three states', ...)
  // { id: 'a', state: 'pending', expiresAt: '2026-10-22T10:00:00.000Z' },
  // { id: 'a', state: 'done', answer: 'Yes', timedOut: true }, { id: 'a', state: 'cancelled', extra: 1 }
test('isStateBody accepts an expiresAt that is not ISO', ...)   // Review Focus 4: expiresAt 'tomorrow' -> true
test.each([...])('isStateBody rejects %j', ...)
  // { id: 'x', state: 'pending' }, { state: 'cancelled' }, { id: 1, state: 'cancelled' },
  // { id: 'x', state: 'done', answer: 'Yes' }, { id: 'x', state: 'open' }, null
test('parseStatusBody keeps extra fields', ...)                  // Review Focus 4:
  // { paired: false, code: 'ABCD-EFGH', extra: 'kept' } -> toEqual the same object
test('parseStatusBody accepts a status without limits', ...)     // { paired: true } -> { paired: true }
test.each([...])('parseStatusBody rejects %j', ...)              // -> undefined:
  // { paired: false }, { nope: 1 }, { paired: 'yes' }, { paired: true, maxTextLength: '3900' }
```

- [ ] **Step 2: Run** `pnpm exec vp test test/wire/schema.test.ts`. Expected: FAIL, the guards aren't exported.
- [ ] **Step 3: Add the types, schemas and guards** listed under Interfaces. Move `statusInfoSchema`'s body into `statusBodySchema`, delete `src/server/schema.ts`, drop `statusInfoSchema` and `StatusInfo` from `src/server/index.ts` and `src/server/types.ts`. No `.meta` yet (Task 5).
- [ ] **Step 4: Run** the new test. Expected: PASS.
- [ ] **Step 5: Point the client at the guards.** In `http.ts` delete `isStateBody` and `isOutcome`; `requestApi` uses `isAnswer`. `caller.ts` imports `isStateBody` and `parseStatusBody` from `../wire/index.ts` (`#fetchStatus` returns `unreadable(...)` on `undefined`); its status result type becomes `StatusBody`. Delete `Answer` and `StateBody` from `client/types.ts` and import them from `wire`.
- [ ] **Step 6: Type the server's responses.** `toStateBody(id, state): StateBody`; the `/status` handler builds `const body: StatusBody = { ...status(), ... }` and returns it; `createApiServer`'s `status` parameter is `() => StatusBody`; `/notify` returns a `NotifyResult`. In `approval/types.ts`, `Outcome` becomes `export type Outcome = Answer`. Rename `StatusInfo` to `StatusBody` in the remaining files from the list.
- [ ] **Step 7: Add the contract test** to `test/server/server.test.ts`, on `startReal` (the real `ApprovalService` server at `:573`):

```ts
test('every response body passes its wire guard', async () => {
  // POST /request answered by the messenger         -> isAnswer(body)
  // POST /request/async                             -> isStateBody(body) && body.state === 'pending'
  // GET /request/<id>?wait=0 while pending, after answer -> isStateBody, states 'pending' then 'done'
  // DELETE /request/<id> on a second pending one    -> isStateBody, state 'cancelled'
  // GET /status paired, and with the unpaired stub  -> parseStatusBody(body) !== undefined
  // POST /notify                                    -> notifyResultSchema.safeParse(body).success
})
```

- [ ] **Step 8: Run** `pnpm test && pnpm check`. Expected: all pass; `git diff --exit-code docs/openapi.yaml` clean.
- [ ] **Step 9: Commit** `refactor: parse responses with wire schemas`

---

### Task 3: Route table

**Files:**
- Create: `src/wire/routes.ts`; extend `src/wire/types.ts`, `src/wire/index.ts`
- Modify: `src/server/server.ts`, `src/server/constants.ts` (delete `REQUEST_ID_PATH_PATTERN`)
- Test: `test/wire/routes.test.ts` (new), `test/server/server.test.ts`

**Interfaces:**
- Produces (`src/wire/types.ts`):

```ts
export type RouteMethod = 'GET' | 'POST' | 'DELETE'
/** Response bodies by OpenAPI name; NotifyResult is inlined, the rest are components. */
export type ResponseSchemaName = 'Outcome' | 'PendingRequest' | 'RequestState' | 'Status' | 'NotifyResult'
/** Shared OpenAPI responses; their descriptions live in the generator. */
export type SharedResponseName =
  | 'BadRequest' | 'Unauthorized' | 'PayloadTooLarge' | 'NotSupported'
  | 'SendFailed' | 'NotPaired' | 'UnknownRequest'
export type RouteResponse =
  | { readonly kind: 'json'; readonly description: string; readonly schema: ResponseSchemaName; readonly locationDescription?: string }
  | { readonly kind: 'yaml'; readonly description: string }
  | { readonly kind: 'error'; readonly description: string }
  | { readonly kind: 'shared'; readonly name: SharedResponseName }
export type Route = { /* spec's Route */ readonly query?: 'wait' }
```

- Produces (`src/wire/routes.ts`): `ROUTES: readonly Route[]` and `findAllowedMethods(path: string): readonly RouteMethod[] | undefined`.

`ROUTES` holds, in this order: `POST /request` (`request`), `POST /request/async` (`requestAsync`), `GET /request/{id}` (`getRequest`, `query: 'wait'`), `DELETE /request/{id}` (`cancelRequest`), `POST /notify` (`notify`), `GET /status` (`status`), `GET /openapi.yaml` (`openapi`, `needsToken: false`). Copy `summary`, `description`, `body` and every response (status codes, descriptions, `Location` header text, inline 400/500 error descriptions, shared refs) verbatim from `src/server/openapi.ts:140-312`; `body` is `'ask'` for the two request routes and `'notify'` for `/notify`.

`findAllowedMethods`: split on `/`; a table path matches when segment counts are equal and each segment is equal or the table segment is `{...}` and the concrete one is non-empty. If any literal path matches exactly, return its methods only; else the methods of the matching parameterised path; else `undefined`. Methods come in table order.

- [ ] **Step 1: Write `test/wire/routes.test.ts`**

```ts
test.each([
  ['/request', ['POST']], ['/request/async', ['POST']], ['/request/abc', ['GET', 'DELETE']],
  ['/request/a%2Fb', ['GET', 'DELETE']], ['/notify', ['POST']], ['/status', ['GET']],
  ['/openapi.yaml', ['GET']],
])('%s allows %j', (path, methods) => expect(findAllowedMethods(path)).toEqual(methods))
test.each(['/other', '//', '/request/', '/request/a/b', ''])('%j has no route', (path) =>
  expect(findAllowedMethods(path)).toBeUndefined())   // Review Focus 3
```

- [ ] **Step 2: Run** `pnpm exec vp test test/wire/routes.test.ts`. Expected: FAIL, not exported.
- [ ] **Step 3: Implement** the types, `ROUTES` and `findAllowedMethods`. Run the test. Expected: PASS.
- [ ] **Step 4: Write the server tests.** In `test/server/server.test.ts`, delete `405 on POST /openapi.yaml` (`:202`), `POST /status is 405 with Allow: GET` (`:329`), `GET /notify is 405 with Allow: POST` (`:408`), `the new routes answer 405 with Allow` (`:753`), and trim `404 on GET /other, 405 on GET /request` (`:209`) to its 404 half. Keep `:274` and `:475`. Add:

```ts
const ALLOW: Readonly<Record<string, string>> = {
  '/request': 'POST', '/request/async': 'POST', '/request/{id}': 'GET, DELETE',
  '/notify': 'POST', '/status': 'GET', '/openapi.yaml': 'GET',
}
test('a wrong method gets 405 with the allowed methods', ...)
  // keys of ALLOW equal the distinct ROUTES paths; for each, PUT <path with {id} -> abc>
  // answers 405, header allow === ALLOW[path], body { error: 'method not allowed' }
test('every route in the table is registered', ...)
  // app.hasRoute({ method, url: path.replaceAll(/\{(\w+)\}/g, ':$1') }) for every entry
test('GET /request/async is a request id, not a 405', ...)          // Review Focus 2: 404 { error: 'unknown request' }
test('HEAD on a GET route needs the token', ...)                    // Review Focus 1, TOKEN_AUTH, no header:
  // HEAD /status and HEAD /request/abc answer 401; service.get / waitFor not called;
  // HEAD /openapi.yaml answers 200
```

- [ ] **Step 5: Run** them. Expected: the 405 test passes for most paths already; the HEAD test passes too (pins today's behaviour before the guard moves). If anything else fails, fix the test, not the server.
- [ ] **Step 6: Drive the server from the table.** The not-found handler: `findAllowedMethods(path)`; defined means 405 with `Allow: methods.join(', ')`, else 404. Replace the per-route `guard` with one `app.addHook('onRequest', ...)` registered only when `auth.kind === 'token'`: it finds the `ROUTES` entry whose Fastify path (`{id}` → `:id`) equals `request.routeOptions.url` and whose method equals `request.method === 'HEAD' ? 'GET' : request.method`; no entry, or `needsToken: false`, means pass. Same 401, header, body and log line as today. Delete `REQUEST_ID_PATH_PATTERN`.
- [ ] **Step 7: Run** `pnpm test && pnpm check`. Expected: all pass.
- [ ] **Step 8: Commit** `refactor: derive 405s and the token guard from the route table`

---

### Task 4: Request shape schemas

**Files:**
- Modify: `src/wire/schema.ts`, `src/wire/constants.ts`, `src/wire/types.ts`, `src/wire/index.ts`, `src/approval/parser.ts`, `src/approval/constants.ts`, `src/approval/index.ts`, `src/notify/parser.ts`, `src/client/types.ts`, `src/client/attachment.ts`, `src/client/caller.ts`, `src/client/http.ts`
- Test: `test/wire/schema.test.ts`

**Interfaces:**
- Produces (`src/wire/types.ts`): `WireLimits` as in the spec; `AttachmentBody` (moved from `client/types.ts` unchanged); `AskBody = ReadonlyBody<z.input<ReturnType<typeof createAskBodySchema>>>`, `NotifyBody` likewise (see Decisions).
- Produces (`src/wire/schema.ts`): `createAskBodySchema(limits: WireLimits)` (fields, the options/`timeoutOption` `superRefine`, `maxOptionCount` cap; no formatting), `createNotifyBodySchema(limits: WireLimits)` (`text`, `project`, `format`, `attachment`), `createAttachmentSchema(maxAttachmentBytes: number)` (moved whole, decode included). `createTextSchema`, `createProjectSchema`, `createFormatSchema` move here and stay internal to `wire/`.
- Moves to `src/wire/constants.ts`: `ATTACHMENT_NAME_FORBIDDEN_PATTERN`, `BASE64_PATTERN`, `ASCII_WHITESPACE_PATTERN`. The error-message constants (`TEXT_ERROR` ... `ATTACHMENT_DATA_ERROR`, minus `WAIT_ERROR` and `BLANK_FORMATTED_ERROR`) move to `src/wire/schema.ts` as module constants.
- Changes (`src/approval/parser.ts`): `createApprovalRequestSchema(maxTextLength, maxAttachmentBytes, maxOptionCount?)` keeps its signature and becomes `createAskBodySchema({ maxTextLength, maxAttachmentBytes, ...(maxOptionCount === undefined ? {} : { maxOptionCount }) }).transform(...)` with today's transform body. `createNotifyRequestSchema` likewise on `createNotifyBodySchema`. `parseApprovalRequest`, `parseNotifyRequest`, `checkProjectText`, `BLANK_FORMATTED_ERROR`, `parseWaitSeconds` and the `options must be an array` special case stay in approval. `approval/index.ts` stops exporting `createAttachmentSchema`, `createFormatSchema`, `createProjectSchema`, `createTextSchema`.

- [ ] **Step 1: Add to `test/wire/schema.test.ts`**

```ts
const LIMITS = { maxTextLength: 1000, maxAttachmentBytes: 2048 }
test('the ask shape leaves formatting to the parser', ...)   // Review Focus 5:
  // createAskBodySchema(LIMITS).safeParse({ text: '`   `', format: 'markdown', options: ['A'], timeoutOption: 'A' }).success === true
  // (the parser half is test/approval/parser.test.ts:148 `blank after formatting`, which must keep passing)
test('the ask shape keeps the timeoutOption rule', ...)
  // { text: 'x', options: ['A'], timeoutOption: 'B' } -> first issue message 'timeoutOption must be one of options'
test('the attachment schema decodes base64', ...)
  // createAttachmentSchema(16).parse({ name: 'a.txt', data: 'aGk=' }) -> { name: 'a.txt', content: Uint8Array [104, 105] }
```

- [ ] **Step 2: Run** `pnpm exec vp test test/wire/schema.test.ts`. Expected: FAIL, not exported.
- [ ] **Step 3: Move the schemas** as listed. The `superRefine` stays on the ask shape schema so issue order doesn't change; the transforms in approval and notify are unchanged code.
- [ ] **Step 4: Point the client at the wire types.** Delete `AskBody` and `AttachmentBody` from `client/types.ts`; `caller.ts`, `attachment.ts` and `http.ts` import them from `../wire/index.ts`. `toAskBody` must compile with `question.options: readonly string[]` unchanged.
- [ ] **Step 5: Run** `pnpm exec vp test test/wire test/approval/parser.test.ts test/notify/parser.test.ts`. Expected: PASS, and `git diff --stat test/approval test/notify` is empty.
- [ ] **Step 6: Run** `pnpm test && pnpm check && git diff --exit-code docs/openapi.yaml`. Expected: all pass, YAML untouched.
- [ ] **Step 7: Commit** `refactor: move request body shapes into src/wire`

---

### Task 5: OpenAPI from the table and the schemas

**Files:**
- Modify: `src/wire/schema.ts` (`.meta`), `src/server/openapi.ts`, `docs/openapi.yaml` (regenerated)
- Test: `test/server/openapi.test.ts`

**Interfaces:**
- Consumes: `ROUTES`, `Route`, `RouteResponse` (Task 3); `answerSchema`, `pendingStateSchema`, `stateBodySchema`, `statusBodySchema`, `notifyResultSchema` (Task 2); `createAskBodySchema`, `createNotifyBodySchema`, `createAttachmentSchema` (Task 4); `MAX_WAIT_SECONDS`, `MAX_OPTION_LENGTH`, `DEFAULT_TIMEOUT_SECONDS`, `MAX_TIMEOUT_SECONDS` (Task 1).
- `createOpenApiDocument(options: OpenApiOptions)` and `formatOpenApiYaml` keep their signatures. `document.paths` becomes `Record<string, Record<string, Operation>>`-shaped; tests that index it still compile (no `noUncheckedIndexedAccess`).

- [ ] **Step 1: Replace `background paths are documented`** in `test/server/openapi.test.ts`:

```ts
test('paths match the route table', ...)
  // Object.entries(paths) flattened to `${METHOD} ${path}` equals ROUTES mapped the same way (same set, no extras);
  // operation.security is [] exactly where needsToken is false and absent elsewhere;
  // operationId equals the route's; every path with {id} has the RequestId parameter;
  // getRequest has the wait query parameter { name: 'wait', in: 'query', schema: { type: 'number', minimum: 0 } };
  // requestAsync 202 has a Location header
test('a done state documents typed replies', ...)
  // the done branch of RequestState: properties.answer.description === 'The tapped option, the typed reply, or `timeoutOption`.'
```

- [ ] **Step 2: Run** `pnpm exec vp test test/server/openapi.test.ts`. Expected: the done-state test FAILS (`The tapped option, or \`timeoutOption\`.`); the paths test passes.
- [ ] **Step 3: Move the descriptions onto the schemas** with `.meta({ description })`, copying the text from `BODY_DESCRIPTIONS`, `ATTACHMENT_DESCRIPTIONS`, `toTextDescription` (plus `minLength: 1` on `text`), the `toAttachmentSchema` description (built from `maxAttachmentBytes`, 0 means the not-supported sentence), `toStatusSchema`'s two field descriptions (one shared field schema per field, used in both branches), the `Outcome` answer description (one shared `answer` field schema, also used by the done branch, which is the fix), and `expiresAt`'s. The factories compute their descriptions from `WireLimits`.
- [ ] **Step 4: Rewrite the generator.** `paths` from `ROUTES` grouped by path in table order, each method lower-cased; `requestBody` from `body` (`'ask'` → `ApprovalRequest`, `'notify'` → `NotifyRequest`); `parameters` from `{id}` (RequestId ref) and `query: 'wait'` (today's object, description from `MAX_WAIT_SECONDS`); `security: []` when `needsToken` is false; responses by `kind`: `json` → component ref, or the inline schema for `NotifyResult`; `error` → `errorResponse(description)`; `shared` → `#/components/responses/<name>` ref; `yaml` → today's `application/yaml` string content. Components: a local `z.registry<{ id: string }>()` with `ApprovalRequest`, `NotifyRequest`, `Attachment`, `Outcome`, `PendingRequest`, `RequestState`, `Status`, converted in one `z.toJSONSchema(registry, { io: 'input', uri: (id) => \`#/components/schemas/${id}\` })`, with `$schema` and `$id` dropped from each. The body schemas build their own attachment instance, so set `properties.attachment` to the `Attachment` ref afterwards (`attachmentReference()` stays). Delete `BODY_DESCRIPTIONS`, `ATTACHMENT_DESCRIPTIONS`, `toAttachmentSchema`, `toBodySchema`, `toStatusSchema`, `toTextDescription`.
- [ ] **Step 5: Diff before regenerating.** Write a throwaway script in the scratchpad that parses the committed `docs/openapi.yaml` and `formatOpenApiYaml(<the options scripts/openapi.ts uses>)` with `yaml`'s `parse` and prints every JSON pointer where they differ. Run it with `node`.
Expected, and nothing else: `type: string` or `type: boolean` added next to `const` (`PendingRequest`, `RequestState` branches, `Status` `paired`, the notify `ok`), and `/components/schemas/RequestState/oneOf/1/properties/answer/description` changed. Fix the generator or the `.meta` text until that's all.
- [ ] **Step 6: Regenerate** with `vp run openapi`, run `pnpm test && pnpm check`. Expected: all pass, including the golden test and the done-state test.
- [ ] **Step 7: Commit** `refactor: generate the OpenAPI document from the wire module` (`docs/openapi.yaml` included).

---

### Task 6: Library bundle checks

**Files:**
- Modify: `test/pack.test.ts`

- [ ] **Step 1: Extend `cjs build exposes the client to require()`**: add `|yaml` to the forbidden-module regex on `index.cjs` (today's bundle has no `yaml` substring at all), and for both `index.d.ts` and `index.d.cts` assert `not.toMatch(/\bz\.|\bZod[A-Z]/)` with a one-line comment that a bare `import "zod"` is a bundler leftover the check tolerates.
- [ ] **Step 2: Run** `pnpm exec vp test test/pack.test.ts`. Expected: PASS. If the `.d.ts` check fails, a zod type reached a public declaration: find it (usually a `z.infer` alias where a hand-written type should be) and fix the source, not the test.
- [ ] **Step 3: Run** `pnpm test && pnpm check`. Expected: all pass.
- [ ] **Step 4: Commit** `test: keep yaml and zod types out of the library bundle`
