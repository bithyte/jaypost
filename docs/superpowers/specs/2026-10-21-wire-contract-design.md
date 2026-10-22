# jaypost wire contract design

## Intent

The HTTP API's shapes are written down in too many places. Request bodies are fine: the zod schemas in `src/approval/parser.ts:165` and `src/notify/parser.ts:14` validate on the server and feed the OpenAPI document through `z.toJSONSchema` (`src/server/openapi.ts:88`, `:323`, `:372`). Everything else is copied by hand:

- Response bodies, three times. The server builds them in `toStateBody` (`src/server/server.ts:17-26`) and inline returns (`:176`, `:251`). The client declares them as `Answer` and `StateBody` (`src/client/types.ts:68`, `:125-137`) and checks them with hand-written guards `isStateBody` and `isOutcome` (`src/client/http.ts:205`, `:235`). The OpenAPI document spells them out again as `Outcome`, `PendingRequest` and `RequestState` (`src/server/openapi.ts:328-371`).
- The `/status` body has a zod schema (`src/server/schema.ts:7`) that only the server and `commands/pairing-wait.ts:26` use. The client reads the same fields with ad hoc checks in `src/client/attachment.ts` (`readLimit`) and `src/hook/runner.ts:55-66`.
- The request shape again as the client's `AskBody` (`src/client/types.ts:103-112`) and `AttachmentBody` (`:36-38`).
- The route list three times: Fastify registrations (`src/server/server.ts:106-252`), the 405 table in the not-found handler (`:57-70`, plus `REQUEST_ID_PATH_PATTERN` in `src/server/constants.ts`), and the OpenAPI `paths` (`src/server/openapi.ts:140-312`).

The copies already drifted once. Free-text replies (86cba2e, #10) updated the `Outcome` answer description to mention typed replies but missed the `done` branch of `RequestState`, which still says "The tapped option, or `timeoutOption`" (`src/server/openapi.ts:360`, `docs/openapi.yaml:294`).

The co-change shows up in history. `git log --stat` on free-text replies (#10), markdown (#13), attachments (#17) and 24 h/background questions (#11) shows each one touching all of `approval/parser.ts`, `client/types.ts`, `client/client.ts`, `commands/send.ts`, `mcp/server.ts`, `mcp/types.ts` and `server/openapi.ts`. The API token (75e967d, #3) touched all of those but `approval/parser.ts`; the Discord provider (8b16b97, #3) touched `approval/parser.ts`, `client/types.ts`, `mcp/server.ts` and `server/openapi.ts` only. Part of that is inherent: a new field needs a CLI flag in `send.ts` and an MCP argument whatever we do. This refactor removes the copies of the shapes, not those.

The goal is one deep module, `src/wire/`, that owns every request and response shape plus the route table. The server, the client, the MCP server, the hook and the OpenAPI generator read it instead of restating it. That gives locality (a new field or route is one edit, and the compiler or a test finds the rest) and leverage (one schema serves validation, client parsing, types and docs).

## Goals

- One zod schema per request body and per response body, in `src/wire/`.
- One route table in `src/wire/`. The 405 handler and the OpenAPI `paths` are generated from it, and a test fails if a table entry has no Fastify handler.
- The client parses responses with the wire schemas. `isStateBody`, `isOutcome`, `readLimit` and the hook's inline `/status` check go away.
- The server's response objects are typed against the wire types, so a server-side shape change that the client doesn't know about is a type error.
- Wire limits (`MAX_OPTION_LENGTH`, `MAX_PROJECT_LENGTH`, `MAX_ATTACHMENT_NAME_LENGTH`, `MAX_ATTACHMENT_BYTES`, `DEFAULT_TIMEOUT_SECONDS`, `MAX_TIMEOUT_SECONDS`, `MAX_WAIT_SECONDS`) live in `src/wire/constants.ts`, and the MCP input schemas take every limit from there.

## Non-goals

- No change to the wire format: same paths, methods, status codes, fields and error messages. The README error table stays true.
- Not restructuring the client's call functions (`callApi`, `postApi`, `requestApi`) or who calls them. That's `2026-10-21-client-protocol-design.md`, which consumes the schemas and types from here.
- No MCP tool renames and no change to MCP argument names or descriptions beyond the limit fixes below.
- Not generating a client from the OpenAPI document, and no HTTP API versioning.

## Anti-goals

- A generic routing framework or Fastify plugin. The table is plain data; handlers stay hand-written in `server.ts`.
- zod types leaking into the published `.d.ts`. `Answer` is part of the library's public entry (`src/index.ts`), and its declaration must stay a plain object type.
- Parsing request bodies twice, or validating responses at runtime on the server. Attachment bodies can be 14 MiB (`MAX_BODY_BYTES`).
- `yaml`, `fastify` or the OpenAPI generator reaching the library bundle through the wire module.

## Decided by me (owner can override)

- **The module is `src/wire/`**: `constants.ts` (limits), `schema.ts` (zod schemas), `routes.ts` (table and `findAllowedMethods`), `parser.ts` (response guards), `types.ts`, `index.ts`. It imports only `zod` and `src/format/` (for `MESSAGE_FORMATS`), both already reachable from the library.
- **zod in the library.** Today `import { Client } from 'jaypost'` loads no npm package at all; I walked the runtime import graph from `src/index.ts` and it's `node:` built-ins only. After this it loads zod. zod is already in `dependencies` (`package.json`, `^4.6.7`), so installs don't grow, and `vp pack` keeps dependencies external, so `dist/index.{js,cjs}` doesn't grow either. The cost is the import: `import('zod')` took about 40 ms cold on this machine, unbundled. `zod/mini` measured the same, so it's not worth the split. The standalone binary already bundles zod through the server and MCP code, so it doesn't change. See Open questions.
- **OpenAPI generation stays in `src/server/openapi.ts`** and reads `ROUTES` and the wire schemas. Keeping it out of `src/wire/` keeps `yaml` and `config/VERSION` out of the client's graph.
- **zod to OpenAPI stays on zod's built-in `z.toJSONSchema`** with `io: 'input'`, as today. No `zod-openapi` or similar dependency. Descriptions move from the `BODY_DESCRIPTIONS`/`ATTACHMENT_DESCRIPTIONS` merge (`src/server/openapi.ts:28-57`) and `toStatusSchema` (`:104-123`) onto the schemas with `.meta({ description })`, so those post-processing functions go.
- **Response types are hand-written in `src/wire/types.ts`** and each schema is annotated against its type (`z.ZodType<StateBody>`), so drift is a type error and the `.d.ts` stays readable. Request body types (`AskBody`, `NotifyBody`) are `z.input<...>` since they're internal.
- **The request schemas split at the formatting step.** `src/wire/` owns the shape: field types, the options/`timeoutOption` rules, and the attachment schema including its base64 decode and size check. The attachment decode moves whole because it is also the base64 validity check, and splitting it would change which issue is reported first. `approval/parser.ts` and `notify/parser.ts` keep the transform that needs `toFormattedText` and `formatProjectText` and produces `ApprovalRequest`/`NotifyRequest`.
- **The server doesn't parse its own responses.** `toStateBody` returns `StateBody`, `/request` returns `Answer`, `/status` returns `StatusBody`. Compile-time plus one contract test (see Tests).
- **MCP input schemas stay separate.** They use snake_case names, agent-facing descriptions and a `path` attachment variant the HTTP API doesn't have (`src/mcp/server.ts:93-162`), so deriving them from the HTTP schemas would cost more than it saves. They do take every limit from `src/wire/constants.ts`. Today two are literals: `.max(255)` for the attachment name (`:130`) and "max 64 chars" in the `timeout_option` description (`:152`).
- **OpenAPI schema names stay** (`Outcome`, `PendingRequest`, `RequestState`, `Status`, `ApprovalRequest`, `NotifyRequest`), so `docs/openapi.yaml` readers don't see renames.

## Constraints

- Node >= 24.2, zod 4.6 (already a dependency). No new runtime or dev dependency.
- Follow the repo's style, not the class-per-module rule: plain exported functions and `type`s, no semicolons, single quotes, width 100, `vp check` clean. Tests use `vite-plus/test` like the rest of `test/`.
- Every zod error message stays byte-identical, and so does which issue is reported first. `test/approval/parser.test.ts` and `test/notify/parser.test.ts` must pass unchanged through every step.
- `docs/openapi.yaml` stays generated by `vp run openapi` and checked by `test/server/openapi.test.ts:13`.
- `test/pack.test.ts` keeps passing: the library bundle doesn't contain grammy, fastify and friends, and exports exactly `Client`, `JaypostError`, `escapeMarkdown`, `formatCodeBlock`.

## Proposed interface

```ts
// src/wire/types.ts
/** Per-install limits; every request schema and the OpenAPI document take them. */
export type WireLimits = {
  readonly maxTextLength: number
  readonly maxAttachmentBytes: number
  readonly maxOptionCount?: number
}

/** The tapped option or typed reply, or `timeoutOption` with `timedOut` set. */
export type Answer = { readonly answer: string; readonly timedOut: boolean }

/** Body of POST /request/async, GET and DELETE /request/{id}. */
export type StateBody =
  | { readonly id: string; readonly state: 'pending'; readonly expiresAt: string }
  | { readonly id: string; readonly state: 'done'; readonly answer: string; readonly timedOut: boolean }
  | { readonly id: string; readonly state: 'cancelled' }

export type AskBody = z.input<ReturnType<typeof createAskBodySchema>>
export type NotifyBody = z.input<ReturnType<typeof createNotifyBodySchema>>

export type RouteMethod = 'GET' | 'POST' | 'DELETE'

/** One method on one path; read by the server, its 405 handler and the OpenAPI generator. */
export type Route = {
  readonly method: RouteMethod
  /** OpenAPI form: `/request/{id}`. */
  readonly path: string
  readonly operationId: string
  readonly summary: string
  readonly description?: string
  /** False only for GET /openapi.yaml. */
  readonly needsToken: boolean
  readonly body?: 'ask' | 'notify'
  readonly responses: Readonly<Record<number, RouteResponse>>
}

// src/wire/index.ts
export function createAskBodySchema(limits: WireLimits) // shape + option rules, no formatting
export function createNotifyBodySchema(limits: WireLimits)
export function createAttachmentSchema(maxAttachmentBytes: number)
export const answerSchema: z.ZodType<Answer>
export const stateBodySchema: z.ZodType<StateBody>
export const statusBodySchema: z.ZodType<StatusBody> // today's statusInfoSchema

/** True for a body the schema accepts; extra fields are allowed. Never throws. */
export function isAnswer(body: unknown): body is Answer
export function isStateBody(body: unknown): body is StateBody
export function parseStatusBody(body: unknown): StatusBody | undefined

export const ROUTES: readonly Route[]
/** Methods the table allows on a concrete path like `/request/abc`; undefined if none. */
export function findAllowedMethods(path: string): readonly RouteMethod[] | undefined
```

`RouteResponse` names a body schema (or `error`/`yaml`) plus a description. Its exact shape is the builder's.

## Tests

New, at the wire interface (`test/wire/`, importing from `src/wire/index.ts`):

- `schema.test.ts`: `isAnswer`, `isStateBody` and `parseStatusBody` accept each documented shape (with extra fields) and reject missing or wrong-typed fields. This replaces `isStateBody accepts the three states and rejects the rest` in `test/client/http.test.ts:356-364`, which is deleted.
- `routes.test.ts`: `findAllowedMethods` for each table path, a parameterised path, an unknown path and a malformed one like `//`.

Changed:

- `test/server/server.test.ts`: the per-route 405 tests (`:202`, `:209`, `:329`, `:408`, `:753`) become one test that loops over `ROUTES` and checks a wrong method gets 405 with the table's `Allow`. Add a test that every `ROUTES` entry is registered (`app.hasRoute`). Add one contract test: drive each route on a real server (pending, done, cancelled, status paired/unpaired, notify) and check the body passes the matching wire guard. `:274` (malformed target) and `:475` (405 stays open with a token) stay.
- `test/server/openapi.test.ts`: `background paths are documented` (`:92`) becomes "paths match `ROUTES` exactly: every path and method, no others, `security: []` only where `needsToken` is false". The golden test at `:13` and the request-body tests stay.
- `test/pack.test.ts`: add `yaml` to the forbidden-module regex, and check `index.d.ts`/`index.d.cts` don't mention `zod`.
- `test/client/http.test.ts:349` and `test/client/client.test.ts:115` (unreadable answer) stay as they are; they're client behaviour.

## Migration steps

Each step leaves `vp test` and `vp check` green.

1. Create `src/wire/constants.ts` and move the seven limits there from `src/approval/constants.ts`. Update importers (`approval`, `mcp/server.ts`, `client/http.ts`, `client/attachment.ts`, `server/openapi.ts`, `server/constants.ts`, `hook/project.ts`, `hook/runner.ts`, `provider/settings.ts`) directly, no re-export from `approval`. Replace the two MCP literals. `docs/openapi.yaml` unchanged.
2. Add `answerSchema`, `stateBodySchema`, `statusBodySchema` (moved from `src/server/schema.ts`, which is deleted), the response types and the guards. Point `client/http.ts`, `mcp/server.ts`, `mcp/types.ts`, `client/attachment.ts`, `hook/runner.ts` and `commands/pairing-wait.ts` at them; delete the old guards and `StateBody`/`Answer`/`StatusInfo` declarations. `src/index.ts` exports `Answer` from the new place. Type the server's response objects. Move the guard test to `test/wire/` and add the contract test.
3. Add `ROUTES` and `findAllowedMethods`. The not-found handler and the token guard read the table; delete `REQUEST_ID_PATH_PATTERN`. Swap in the table-driven 405 test and the `hasRoute` test.
4. Move the request shape schemas into `src/wire/schema.ts`. `approval/parser.ts` and `notify/parser.ts` build their transforms on `createAskBodySchema`/`createNotifyBodySchema`. Client `AskBody`/`AttachmentBody` become wire types. Parser tests pass untouched.
5. Generate OpenAPI `paths` from `ROUTES` and the response schemas from the wire schemas; move descriptions onto the schemas with `.meta`. Before running `vp run openapi`, parse the old and new YAML and diff the objects. Allowed differences: key order, a `type` next to `const`, and the `RequestState` done-answer description fix. Then regenerate `docs/openapi.yaml` and update the openapi tests.
6. Extend `test/pack.test.ts` as above.

## Interaction with the other specs

- `2026-10-21-client-protocol-design.md` doesn't wait for this. Its first step moves `isStateBody` into a new `src/client/caller.ts` and parses `/status` with `statusInfoSchema` imported from `src/server/schema.ts`. If it lands first, step 2 here repoints those two at `src/wire/` and deletes the moved guard. Either order works; the zod load cost it mentions is the one measured above.
- `2026-10-21-provider-runtime-contract-design.md` removes the "notifications not supported" 501 (`src/server/server.ts:229-231`). After step 3, that's one edit to the `/notify` entry's 501 description in `ROUTES` (today `NotSupported` in `src/server/openapi.ts:401-403` covers both). Whichever lands second makes it.

## Open questions

- Is about 40 ms of zod import at `import 'jaypost'` acceptable? If not, the fallback is to keep hand-written guards in the client and pin them to the schemas with a test that feeds both the same fixtures. That's a second copy again, but a checked one.
- Should `expiresAt` be `z.iso.datetime()` (stricter on the client, emits `format: date-time` like today's hand-written doc) or stay `z.string()`? The server always sends `toISOString()`, so I lean stricter, but it would reject a hand-rolled server that sends something else.

## Left to the builder

- The exact shape of `RouteResponse`, and how the table maps OpenAPI `{id}` to Fastify `:id`.
- Whether `z.input` gives `AskBody` readonly arrays. If it doesn't, callers passing `readonly string[]` won't compile, and a `Readonly` mapping or `.readonly()` on the array schema is needed. I haven't checked how zod 4.6 types `.readonly()` on the input side.
- Whether the attachment's input type stays an exclusive `{ name, text } | { name, data }` for callers (a hand-written alias checked against the schema) or becomes the schema's `{ name, text?, data? }`. Changing the schema to a union would change its error messages, which isn't allowed.
- Whether `ApiPath` in `src/client/types.ts` gets derived from `ROUTES`; the client-protocol spec may make it moot.
