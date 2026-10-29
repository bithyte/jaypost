# Contact Book Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client-side contact book (`~/.config/jaypost/bots.json`) that names every bot and service this machine can reach, so `jaypost ping -b NeveuBot` works with no env vars, plus the CLI regroup (`service`, `remote`, `bots`, `join`, `admin`).

**Architecture:** A new `book` module in `@jaypost/store` owns the file and every pure change to it (immutable functions returning a new book). `@jaypost/client` gets `resolveBot`, the one place that turns `-b` / `JAYPOST_BOT` / env / book default into an endpoint and a token. Every CLI command that reaches a bot goes through it, and the admin commands resolve their service from the book's `local` and `remotes`. The local service's files move under `~/.config/jaypost/service/` by changing the default config path.

**Tech Stack:** Node >= 24.15, TypeScript run directly, pnpm workspace, `vite-plus` (vitest) tests with `expect`, zod for file schemas, commander for the CLI.

**Spec:** `docs/superpowers/specs/2026-10-29-contact-book-design.md`

## Global Constraints

- Match the surrounding code: exported functions with `/** */` contract comments, `readonly` types, discriminated unions on `kind`, `findEnvValue` for env reads (empty counts as unset). Not the class-per-module style.
- No new runtime dependencies.
- Book file: `bots.json` in `resolveJaypostDirectory(env)`, written with `writeFileAtomic(path, json, SECRET_FILE_MODE)` (mode 0600), JSON as `` `${JSON.stringify(book, null, 2)}\n` ``.
- A key or admin key never appears in an error message, `bots` output or `remote list` output. Only `admin key create` (bare, `--invite`), `admin rotate-key` and the `--exposed` remote line print one.
- Invite prefix `jpi_`; payload base64url JSON `{ "v": 1, "url": ..., "key": ... }`; never an admin key.
- No migration of old files; nothing reads `~/.config/jaypost/token` or top-level `config.json` after this.
- Env mode: if `JAYPOST_URL` or `JAYPOST_TOKEN` is set (and no `-b`/`JAYPOST_BOT`), the book isn't read; a book key never goes to an env URL and an env token never goes to a book URL.
- `--exposed` binds `0.0.0.0`; plain http; prints a warning.
- No em-dashes anywhere (code, comments, docs, messages, commits).
- Commits: conventional, lowercase summary, no `Co-Authored-By` trailer.
- Run one test file: `pnpm exec vp test <path>`. Whole suite: `pnpm test`. Types and lint: `pnpm check`.

## Review Focus

- A hand-edited or corrupt `bots.json` (bad JSON, wrong `version`, a bot missing `url`): every command fails with a message naming the file, nothing overwrites it, no key is quoted. Test in Task 1.
- `bots.json` that already exists with mode 0644: the next write leaves it 0600. Test in Task 1.
- An invite pasted with surrounding whitespace, or with the `jaypost join ` prefix still on it, still parses; a truncated one is "isn't a valid invite" without echoing it. Tests in Task 1 and Task 10.
- Aliases that differ only by case (`neveubot` vs `NeveuBot`) are the same entry for lookup, rename and save. Test in Task 1.
- `JAYPOST_TOKEN` exported in the shell while the user runs `-b NeveuBot`: the book key goes to the book url and the env token is never sent. Test in Task 3.

---

### Task 1: Book module in `@jaypost/store`

**Files:**
- Create: `packages/store/src/book/{types,constants,schema,store,operations,invite,index}.ts`
- Modify: `packages/store/src/index.ts` (re-export the book module)
- Test: `packages/store/test/book/{store,operations,invite}.test.ts`

**Interfaces:**
- Produces (types, `book/types.ts`):
  ```ts
  export type BookLocal = { readonly url: string; readonly adminKey?: string }
  export type BookRemote = { readonly name: string; readonly url: string; readonly adminKey: string }
  export type BookBot = { readonly alias: string; readonly url: string; readonly key?: string }
  export type Book = {
    readonly version: 1
    readonly default?: string
    readonly local?: BookLocal
    readonly remotes: readonly BookRemote[]
    readonly bots: readonly BookBot[]
  }
  export type BookChange =
    | { readonly kind: 'changed'; readonly book: Book }
    | { readonly kind: 'failed'; readonly message: string }
  export type Invite = { readonly url: string; readonly key: string }
  ```
- Produces (constants): `BOOK_FILE_NAME = 'bots.json'`, `BOOK_VERSION = 1`, `EMPTY_BOOK: Book` (`{ version: 1, remotes: [], bots: [] }`), `INVITE_PREFIX = 'jpi_'`, `INVITE_VERSION = 1`, `BOT_ENV_VAR = 'JAYPOST_BOT'`, `LOCAL_ALIAS = 'local'`.
- Produces (functions):
  - `readBook(path: string): Book`: missing file is `EMPTY_BOOK`; bad JSON or schema throws `contact book "<path>" isn't valid: <zod issue path>` (issue paths only, never values); other read errors rethrow.
  - `writeBook(path: string, book: Book): void`
  - `toServiceUrl(raw: string): string | undefined`: http or https, no credentials, query or fragment; returns `new URL(raw).href`. Never throws.
  - `findBot(book: Book, alias: string): BookBot | undefined` (case-insensitive)
  - `findRemote(book: Book, name: string): BookRemote | undefined` (case-insensitive name, else exact `URL.host` match)
  - `findLocalSeedBot(book: Book): BookBot | undefined` (first bot whose `url` equals `book.local.url`)
  - `saveBot(book: Book, bot: BookBot): Book`: replaces the case-insensitive alias match in place, else appends; sets `default` to `bot.alias` when the book has none.
  - `removeBot(book: Book, alias: string): BookChange`: removing the default moves `default` to the first remaining bot, or omits it.
  - `renameBot(book: Book, alias: string, newAlias: string): BookChange`: default follows; a different entry already named `newAlias` fails.
  - `setDefaultBot(book: Book, alias: string): BookChange`
  - `saveRemote(book: Book, remote: BookRemote): Book` (replace by case-insensitive name, else append)
  - `removeRemote(book: Book, name: string): BookChange` (bots on that url stay)
  - `setLocal(book: Book, local: BookLocal, seed: BookBot): Book`: sets `local`; if a bot with `url === seed.url` and the same `key` exists it's updated keeping its alias (so a renamed seed survives a reinstall), else `saveBot(book, seed)`.
  - `removeLocal(book: Book): Book`: drops `local` and every bot with its url; default fixed as in `removeBot`.
  - `encodeInvite(invite: Invite): string`, `decodeInvite(raw: string): Invite | undefined`: decode trims, strips a leading `jaypost join `, requires `INVITE_PREFIX`, `v === 1`, a valid `toServiceUrl` and a `parseToken`-valid key. Never throws.
- Failure messages: `no bot "<alias>" in your contacts`, `a bot is already named "<alias>"`, `no remote "<name>"`.

- [ ] **Step 1: Write the failing tests**

`store.test.ts` (temp dir via `mkdtempSync`):
- `readBook returns an empty book when the file is missing` → `expect(readBook(join(dir, 'bots.json'))).toEqual(EMPTY_BOOK)`
- `writeBook then readBook round-trips and the file is mode 0600` → `statSync(path).mode & 0o777` is `0o600`
- `writeBook tightens a file that was 0644` (write a file, `chmodSync(path, 0o644)`, `writeBook`, expect `0o600`)
- `readBook rejects bad json, a wrong version and a bot without url, naming the file and no key` → `expect(() => readBook(path)).toThrow(/contact book ".*bots\.json" isn't valid/)` and the message doesn't contain the fixture key `jpk_` + `'a'.repeat(43)`

`operations.test.ts` (fixture `BOT_A = { alias: 'NeveuBot', url: 'http://203.0.113.7:8787/', key: KEY_A }`):
- `saveBot on an empty book makes it the default`
- `saveBot replaces an entry whose alias differs only by case` → one bot, alias of the new one
- `removeBot of the default moves the default to the first remaining bot`
- `removeBot of the last bot leaves no default` → `'default' in book` is `false`
- `renameBot keeps the default on the renamed entry`; `renameBot onto another entry's alias fails`
- `setDefaultBot of an unknown alias fails with no bot "x" in your contacts`
- `setLocal on a reinstall updates the renamed seed in place` (seed saved as `home`, `setLocal` again with same key, expect alias `home`, one bot)
- `removeLocal drops local and its bots and fixes the default`
- `findRemote matches the name case-insensitively and the url host`
- `toServiceUrl rejects credentials, query, fragment and non-http schemes`

`invite.test.ts`:
- `decodeInvite reads what encodeInvite wrote`
- `decodeInvite accepts surrounding whitespace and a pasted "jaypost join " prefix`
- `decodeInvite rejects a truncated invite, another prefix, v 2, a bad url and a bad key` → each `toBeUndefined()`

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vp test packages/store/test/book`
Expected: FAIL, module `../../src/book/index.ts` not found.

- [ ] **Step 3: Implement the module** with the signatures above. Schema in `schema.ts` with `z.object` (strict on `version: z.literal(1)`; `z.looseObject` for entries so unknown fields survive a rewrite).

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vp test packages/store/test/book`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/book packages/store/src/index.ts packages/store/test/book
git commit -m "feat: contact book file and its pure operations"
```

---

### Task 2: Paths split and bot target resolution in `@jaypost/store`

**Files:**
- Modify: `packages/store/src/config/paths.ts`, `packages/store/src/auth/token.ts`, `packages/store/src/auth/types.ts`
- Create: `packages/store/src/book/target.ts` (export from `book/index.ts`)
- Test: `packages/store/test/config/paths.test.ts` (create), `packages/store/test/book/target.test.ts`, `packages/store/test/auth/token.test.ts`

**Interfaces:**
- Consumes: Task 1's `Book`, `BookBot`, `findBot`, `BOT_ENV_VAR`.
- Produces:
  - `resolveJaypostDirectory(env?: NodeJS.ProcessEnv): string`: `$XDG_CONFIG_HOME/jaypost` or `~/.config/jaypost`, ignores `JAYPOST_CONFIG`.
  - `resolveConfigPath` default becomes `<jaypost dir>/service/config.json`, so `resolveConfigDirectory` (and through it `InstallPaths.configDirectory`, `installFile`, `composeDirectory`, `quadletDirectory`) moves under `service/` with no other change.
  - `resolveBookPath(env?: NodeJS.ProcessEnv): string`: `join(resolveJaypostDirectory(env), BOOK_FILE_NAME)`.
  - `resolveEnvToken(env: NodeJS.ProcessEnv): ClientToken`: `JAYPOST_TOKEN` only, same messages as `resolveClientSecret`'s env branch.
  - `ClientToken`'s `source` widens to `'env' | 'file' | 'book'`.
  - ```ts
    export type BotTarget =
      | { readonly kind: 'bot'; readonly bot: BookBot }
      | { readonly kind: 'env' }
      | { readonly kind: 'failed'; readonly message: string }
    export function resolveBotTarget(env: NodeJS.ProcessEnv, book: Book, alias: string | undefined): BotTarget
    ```
    Order: `alias`, then `JAYPOST_BOT`, then env mode (`JAYPOST_URL` or `JAYPOST_TOKEN` set), then `book.default`. Unknown alias: `no bot "<alias>" in your contacts; known: a, b` (or `; it's empty`). Nothing: `no bot to send to; run "jaypost service install" or "jaypost join"`.

- [ ] **Step 1: Write the failing tests**
- `resolveConfigPath defaults under jaypost/service` → `resolveConfigPath({ HOME: '/h' })` is `'/h/.config/jaypost/service/config.json'`; `resolveBookPath({ HOME: '/h' })` is `'/h/.config/jaypost/bots.json'`; `XDG_CONFIG_HOME` and `JAYPOST_CONFIG` cases.
- `resolveBotTarget prefers the alias, then JAYPOST_BOT, then env mode, then the default` (one `expect` per layer, removing the layer above each time)
- `resolveBotTarget with an alias ignores JAYPOST_URL and JAYPOST_TOKEN` → `kind: 'bot'`
- `resolveBotTarget lists the known aliases for an unknown one`
- `resolveBotTarget on an empty book with no env says how to add a bot`
- `resolveEnvToken ignores files and reports a bad JAYPOST_TOKEN without quoting it`

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vp test packages/store/test/book/target.test.ts packages/store/test/config packages/store/test/auth`
Expected: FAIL (missing exports, old default path).

- [ ] **Step 3: Implement** the functions above.

- [ ] **Step 4: Run the store suite**

Run: `pnpm exec vp test packages/store`
Expected: PASS. Fix any store test that pinned the old `config.json` default.

- [ ] **Step 5: Commit**

```bash
git add packages/store
git commit -m "feat: service files under jaypost/service and bot target resolution"
```

---

### Task 3: `resolveBot` and `Client({ bot })` in `@jaypost/client`

**Files:**
- Create: `packages/client/src/target.ts`
- Modify: `packages/client/src/client.ts`, `packages/client/src/types.ts` (`ClientOptions.bot`, `ResolvedBot`), `packages/client/src/index.ts`
- Test: `packages/client/test/target.test.ts`, `packages/client/test/client.test.ts`

**Interfaces:**
- Consumes: `readBook`, `resolveBookPath`, `resolveBotTarget`, `resolveEnvToken`, `NO_CLIENT_TOKEN`, `DEFAULT_PORT`, `PORT_ENV_VAR` from `@jaypost/store`.
- Produces:
  ```ts
  export type ResolvedBot = {
    readonly endpoint: ServiceEndpoint
    readonly token: ClientToken
    /** The book alias, or undefined in env mode or on failure. */
    readonly alias: string | undefined
  }
  /** Never throws: a failure is an `invalid` endpoint carrying the message, with no token. */
  export function resolveBot(env: NodeJS.ProcessEnv, alias: string | undefined): ResolvedBot
  ```
  Env mode: endpoint `findEnvEndpoint(env) ?? toLocalEndpoint(<valid JAYPOST_PORT> ?? DEFAULT_PORT)`, token `resolveEnvToken(env)`. Book mode: `{ kind: 'url', url: new URL(bot.url) }`, token `{ kind: 'token', token: bot.key, source: 'book' }` or `NO_CLIENT_TOKEN`. An unreadable book becomes the `invalid` endpoint with `readBook`'s message.
- `ClientOptions.bot?: string`. With `url`, `host`, `port` or `token` it's a `RangeError("bot can't be combined with url, host, port or token")`. No options at all: `resolveBot(process.env, undefined)`. Explicit `url`/`host`/`port`: as today, token from `options.token` else `resolveEnvToken` (no file, no book). The token file lookup is gone from `Client`.

- [ ] **Step 1: Write the failing tests** (`XDG_CONFIG_HOME` pointed at a `mkdtempSync` dir inside the env object passed in; `writeBook` fixtures)
- `resolveBot sends the named bot's key to its url`
- `resolveBot with -b never uses JAYPOST_TOKEN` (env has `JAYPOST_TOKEN`, alias given → token is the book key, `source: 'book'`)
- `resolveBot in env mode never reads the book` (book default exists, `JAYPOST_TOKEN` set → endpoint `127.0.0.1:8787`, token from env)
- `resolveBot turns an unknown alias into an invalid endpoint listing the known ones`
- `resolveBot reports an unreadable book by its path, not its contents`
- `Client with bot sends that bot's key as the bearer token` (`node:http` on port 0 records `authorization`)
- `Client rejects bot combined with url`

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vp test packages/client`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement** `target.ts` and the `Client` changes.

- [ ] **Step 4: Run the client suite**

Run: `pnpm exec vp test packages/client`
Expected: PASS (update the existing token-file tests in `client.test.ts` to env or book).

- [ ] **Step 5: Commit**

```bash
git add packages/client
git commit -m "feat: resolve the target bot from the contact book in the client"
```

---

### Task 4: Install targets: exposed, `service run`, start/stop, read the API token

**Files:**
- Modify: `packages/install/src/install/{types,schema,constants,templates,systemd,launchd,quadlet,compose,native}.ts`
- Test: `packages/install/test/install/{templates,systemd,launchd,quadlet,compose}.test.ts`

**Interfaces:**
- Produces:
  - `InstallOptions.exposed?: boolean`; `installRecordSchema` gains `exposed: z.boolean().optional()` (written only when true, so `update` keeps it).
  - `EXPOSED_HOST = '0.0.0.0'` in `constants.ts`.
  - `formatComposeYaml(port: number, exposed: boolean)` publishes `"${port}:${port}"` when exposed, else `"127.0.0.1:${port}:${port}"`; `formatQuadletContainer({ ..., exposed })` same for `PublishPort`; `formatSystemdUnit({ exec, config, exposed })` adds `Environment=JAYPOST_HOST=0.0.0.0`; `formatLaunchdPlist({ ..., exposed })` adds a `JAYPOST_HOST` key.
  - Units, plists and the Dockerfile run `service run` instead of `start` (`CMD ["jaypost","service","run"]`); `findUnitExecWords` and `findPlistExecWords` strip a trailing `service run`.
  - `Target.start(record: InstallRecord): Promise<void>`, `Target.stop(record: InstallRecord): Promise<void>`: systemd and Quadlet `systemctl --user start|stop jaypost`; Compose `compose start|stop`; launchd the builder's choice of `bootstrap`/`bootout` or `kickstart`/`kill`. Failures throw `<tool> <verb> failed (exit N)` like `restart`.
  - `Target.readApiToken(record: InstallRecord): Promise<string | undefined>`: native reads `apiToken` from the record's config file (`resolveApiToken({}, readConfigFile(...))`); containers read `JAYPOST_TOKEN` from the `.env` with `readEnvFile`. Missing is `undefined`.
  - `InstallPaths.tokenFile` is removed in Task 6, not here.

- [ ] **Step 1: Write the failing tests**
- `formatComposeYaml publishes on all interfaces when exposed`, and the loopback case unchanged
- `formatSystemdUnit sets JAYPOST_HOST only when exposed and runs service run`
- `formatLaunchdPlist runs service run and sets JAYPOST_HOST when exposed`
- `findUnitExecWords strips a trailing service run`
- per target: `start and stop call <tool> with the right words` using the existing fake `exec` in each test file
- `readApiToken reads apiToken from config.json` (systemd) and `reads JAYPOST_TOKEN from .env` (compose)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vp test packages/install`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement**, passing `options.exposed ?? false` through each target's `install` and `upgrade` (upgrade reads `previous.exposed`).

- [ ] **Step 4: Run the install suite**

Run: `pnpm exec vp test packages/install`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/install
git commit -m "feat: exposed installs, service run, start and stop on every target"
```

---

### Task 5: Client commands take `-b`

**Files:**
- Modify: `apps/cli/src/cli.ts`, `apps/cli/src/commands/{ping,status,log,send,pairing-wait,types}.ts`, `packages/mcp/src/{port,index}.ts`, `packages/hook/src/setup.ts`
- Test: `apps/cli/test/commands/{ping,log,send,pairing-wait}.test.ts`, `apps/cli/test/commands/status.test.ts` (create), `packages/mcp/test/port.test.ts`, `apps/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: `resolveBot` (Task 3), `resolveJaypostDirectory` (Task 2).
- Produces:
  - `FetchStatus = (url: URL, token: string | undefined) => Promise<StatusFetch>`; `defaultFetchStatus(url: URL, token?: string)`; `WaitOptions.port` becomes `WaitOptions.url: URL`. Callers pass `toLocalEndpoint(port).url` for the local service.
  - `PingDeps`: `port` replaced by `endpoint: ServiceEndpoint`.
  - `StatusDeps`: `{ resolved: ResolvedBot; install: { readonly record: InstallRecord; readonly target: Target } | undefined; fetchStatus: FetchStatus; print }`. Prints `Bot:     <alias or "env"> (<describeEndpoint>)`; when the resolved url is loopback and an install exists, also the target, version, port and running lines as today; then key and pairing from `/status`. Exit 0 when `/status` answered, else 1. Not installed and no bot: `No bot. Run "jaypost service install" or "jaypost join".`
  - `LogDeps`/`LogArgs`: plain `log` always reads `GET /log` through the resolved bot; the `--bot`, `--pairing`, `--key`, `--all` options and the db read path leave `log` (they move to `admin log` in Task 8).
  - `-b, --bot <alias>` on `ping`, `status`, `request`, `notify`, `log`, `mcp`, `hook`; `--port` removed from all of them (kept on `openapi`). Each builds `resolveBot(process.env, options.bot)` and passes `endpoint` and `token` (for `mcp`, `readToken: () => resolved.token`).
  - `resolveMcpEndpoint` removed from `@jaypost/mcp` (and its tests); `resolveMcpPort` stays for `openapi`.
  - Hook stop markers: `join(resolveJaypostDirectory(process.env), STOP_DIRECTORY_NAME)`.
  - Hook setup message (`packages/hook/src/setup.ts`): mention `-b`/`JAYPOST_BOT` and `jaypost bots` instead of `JAYPOST_URL`.

- [ ] **Step 1: Write the failing tests**
- `ping sends to the endpoint it's given` (existing test reworked to `endpoint`)
- `status prints the bot and pairing for a remote bot without install lines`
- `status prints install lines for the local bot`
- `log reads GET /log with the bot's key`
- `waitForPairing polls the url it's given`
- cli.test: `ping -b with an unknown alias exits 1 and lists the known ones` (spawned CLI, `XDG_CONFIG_HOME` temp dir with a book), `ping --port is an unknown option`

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vp test apps/cli/test/commands packages/mcp`
Expected: FAIL

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run and check**

Run: `pnpm exec vp test apps/cli packages/mcp packages/hook && pnpm check`
Expected: PASS. `init`/`reset-owner`/`uninstall` still compile because the token-file API is removed in Task 6.

- [ ] **Step 5: Commit**

```bash
git add apps/cli packages/mcp packages/hook
git commit -m "feat: -b picks the bot for ping, status, request, notify, log, mcp and hook"
```

---

### Task 6: `service` command group and the book on install

**Files:**
- Create: `apps/cli/src/commands/service.ts` (start, stop)
- Modify: `apps/cli/src/cli.ts`, `apps/cli/src/commands/{init,uninstall,update,reset-owner,types,index}.ts`, `packages/install/src/install/{paths,types}.ts`, `packages/store/src/auth/{token,index}.ts`, `packages/store/src/index.ts`
- Test: `apps/cli/test/commands/{init,update,manage}.test.ts`, `apps/cli/test/commands/service.test.ts` (create), `apps/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: Task 1 (`readBook`, `writeBook`, `setLocal`, `removeLocal`, `findLocalSeedBot`, `LOCAL_ALIAS`), Task 2 (`resolveBookPath`), Task 4 (`exposed`, `start`, `stop`, `readApiToken`).
- Produces:
  - Commands: `service install [target] [--exposed] [--port N] [--provider NAME] [--token|--no-token]` (was `init`), `service uninstall`, `service start`, `service stop`, `service run` (was `start`; `main`'s final `process.exit` skip checks `argv[0] === 'service' && argv[1] === 'run'`). `init`, `uninstall` and `start` are gone at top level.
  - `InitArgs.exposed?: boolean`; `InitDeps` gains `bookPath: string` and `hostname: string` (from `os.hostname()`).
  - `chooseAuth` takes the saved token from `existing ? await target.readApiToken(existing.record) : undefined` instead of the token file; the rest of its rules stay.
  - Right after `writeInstall`, `service install` writes `setLocal(book, { url }, { alias: LOCAL_ALIAS, url, key? })` with `url = toLocalEndpoint(port).url.href`. After the pairing wait returns (any result), it tries `target.readAdminKey(installed)` and, on success, writes `local.adminKey`. A failure there is a note, not a failed install.
  - With `--exposed`: a warning before installing (`--exposed listens on all interfaces over plain http; keys cross the network in the clear. Use it on a LAN or behind a TLS proxy.`), and after pairing:
    ```
    To manage this service from another machine, run there:

      jaypost remote add <hostname> http://<hostname>:<port> <admin key>
    ```
  - Done lines: drop the token-file line; print `Your bot is saved as "local" in <bookPath>.` and, when a token exists, `Agents in containers need JAYPOST_TOKEN set to its key from that file.`
  - `runUninstall`: after `remove`, `writeBook(removeLocal(book))`; if the default changed to another bot, print `Default bot is now "<alias>".` The purge prompt drops "API token".
  - `runUpdate`: `readAuth` uses `target.readApiToken(previous)`.
  - `runResetOwner`: token from `findLocalSeedBot(readBook(bookPath))?.key`, else `resolveEnvToken(env)`. `resolveResetOwnerToken` is removed. Its "Not installed" hint names `jaypost service install`.
  - `runServiceStart(deps)`, `runServiceStop(deps)` with `ServiceControlDeps = { paths; targets; print; printError }`: no install prints `Not installed. Run "jaypost service install".` and returns 1; otherwise calls the target and prints `Started.` / `Stopped.`.
  - Removed: `InstallPaths.tokenFile`, `resolveTokenFile`, `writeTokenFile`, `removeTokenFile`, `resolveClientToken` and `TOKEN_FILE_NAME` (keep `readTokenFile` and `resolveClientSecret`, which read the admin key file).

- [ ] **Step 1: Write the failing tests**
- `service install writes local and the seed bot to the book before waiting for pairing` (fake `wait` that asserts `readBook(bookPath)` has the seed)
- `service install saves the admin key to the book once the service answers`
- `service install reuses the token the existing install's service holds` (fake target `readApiToken` returns a token; expect `install` called with it)
- `service install --exposed passes exposed and prints the remote add line with the hostname`
- `service uninstall removes local and its bots from the book and names the new default`
- `service start and stop call the target and fail when nothing is installed`
- `update keeps the token the service holds`
- cli.test: `init is an unknown command`, `service --help lists install, uninstall, start, stop and run`

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vp test apps/cli/test/commands/init.test.ts apps/cli/test/commands/service.test.ts apps/cli/test/commands/update.test.ts apps/cli/test/commands/manage.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement.** Keep `init.ts` as the file name (`runInit`), only the command moves.

- [ ] **Step 4: Run everything**

Run: `pnpm test && pnpm check && grep -rn "tokenFile\|resolveTokenFile" packages apps --include=*.ts`
Expected: PASS, and grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add apps/cli packages/install packages/store
git commit -m "feat: service install, uninstall, start, stop and run write the contact book"
```

---

### Task 7: `remote add|remove|list`

**Files:**
- Create: `apps/cli/src/commands/remote.ts`
- Modify: `apps/cli/src/cli.ts`, `apps/cli/src/commands/{types,index}.ts`
- Test: `apps/cli/test/commands/remote.test.ts`

**Interfaces:**
- Consumes: `readBook`, `writeBook`, `saveRemote`, `removeRemote`, `findRemote`, `toServiceUrl`, `parseToken`; `AdminCaller`, `describeEndpoint` from `@jaypost/client`; `formatTable` from `commands/admin.ts`.
- Produces:
  - `BookDeps = { bookPath: string; prompt: Prompts; isInteractive: boolean; print; printError }` (shared by Tasks 7, 9, 10).
  - `runRemoteAdd(args: { name: string; url: string; adminKey: string }, deps: BookDeps & { fetchTimeoutMs?: number }): Promise<number>`: bad url: `"<url>" isn't an http or https URL`; bad key: `that isn't a valid admin key` (no echo); checks with `new AdminCaller({ endpoint, adminKey }).listBots()`, failing with its message (unauthorized, unreachable); same name asks `Replace remote "<name>"?` on a TTY, fails with `a remote is already named "<name>"` otherwise. Prints `Added remote "<name>" (<describeEndpoint>).`
  - `runRemoteRemove(args: { name: string }, deps: BookDeps): Promise<number>`
  - `runRemoteList(deps: BookDeps): Promise<number>`: `formatTable(['NAME', 'URL'], ...)`, `No remotes.` when empty, never the admin key.

- [ ] **Step 1: Write the failing tests** (`node:http` fake answering `/admin/bots` 200 or 401)
- `remote add checks the admin key and saves the remote`
- `remote add saves nothing when the service rejects the admin key`
- `remote add of an existing name fails off a terminal`
- `remote list shows names and urls but no admin key` → output doesn't contain the fixture key
- `remote remove of an unknown name fails`

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vp test apps/cli/test/commands/remote.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement** and wire `remote` in `cli.ts` (`isInteractive: process.stdin.isTTY === true`).

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vp test apps/cli/test/commands/remote.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli
git commit -m "feat: remote add, remove and list"
```

---

### Task 8: `admin` group, `-s`, rotate-key, admin log, key create `--save`/`--invite`

**Files:**
- Modify: `apps/cli/src/cli.ts` (`addAdminCommands` builds `program.command('admin')`), `apps/cli/src/commands/{admin-access,admin,key,log,types}.ts`
- Test: `apps/cli/test/commands/{admin,log}.test.ts`, `apps/cli/test/commands/key.test.ts` (create), `apps/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: Task 1 (`readBook`, `writeBook`, `findRemote`, `saveRemote`, `saveBot`, `findBot`, `encodeInvite`), Task 7 (`BookDeps`).
- Produces:
  - Commands: `admin bot add|list|remove`, `admin key create|list|label|revoke`, `admin pairing create|list|remove`, `admin rotate-key`, `admin log`. `-s, --service <name>` is defined on `admin` and read with `optsWithGlobals()`; it works before or after the subcommand. The old top-level `bot`, `key`, `pairing`, `admin-key rotate` are gone; hidden `admin-key show` stays at top level.
  - `AdminDeps` gains `bookPath: string`, `service: string | undefined`, `isInteractive: boolean`.
  - `AdminEndpoint`'s remote variant gains `name: string | undefined` (undefined for env).
  - `resolveAdminEndpoint` order: `-s` (`findRemote`, unknown: `no remote "<name>"; known: ...`) → `JAYPOST_URL` + `JAYPOST_ADMIN_KEY` (as today) → local install (admin key `book.local.adminKey`, else `target.readAdminKey(record)` which is then saved to `book.local`) → the only remote when there's exactly one → with no install and no remotes, today's config-port fallback (a service started by hand with `service run`) → otherwise `several remotes; pick one with -s: a, b`.
  - `runAdminKeyRotate` writes the new key to `book.local` or the named remote; env keeps today's `Set JAYPOST_ADMIN_KEY to the new key.`
  - `runAdminLog(args: AdminLogArgs, deps)`: `AdminLogArgs = { since?; project?; limit?; json?; bot?; pairing?; key?; all? }`; no filter flag means `all`. Against the local service when it doesn't answer, it falls back to the target's `readAuditLog` (seed bot only) and says so on stderr.
  - `KeyCreateArgs` gains `save?: boolean`, `as?: string`, `invite?: boolean`. Both `--save` and `--invite`: `give at most one of --save and --invite`, exit 2. `--as` without `--save`: exit 2.
    - `--save`: alias `args.as` ?? the bot's label ?? its display name ?? its id. The bot id is `args.bot`, else `listKeys()` entry for the new key id's `bot`; label and display name from `listBots()`. Alias taken: asks `Replace "<alias>" in your contacts?` on a TTY, else fails with `a bot is already named "<alias>"; pick another with --as`. Saves `{ alias, url: endpoint.url.href, key }` with `saveBot` and prints `Saved as "<alias>" in your contacts.` after the usual key lines.
    - `--invite`: only when the endpoint is `remote`; local fails with `invites need a remote; add one with "jaypost remote add" and use -s`. Prints, instead of the `Key ...:` line, `Send this to <label or "them"> (it holds their key, send it privately):`, a blank line, `  jaypost join <encodeInvite({ url, key })>`, then the pairing code lines as today. `--json` adds `"invite": "jpi_..."` to the created key object.

- [ ] **Step 1: Write the failing tests** (fake admin service on `node:http`, book in a temp dir)
- `admin commands pick the remote named by -s`
- `admin without -s uses the local install and saves its admin key to the book`
- `admin without -s and two remotes asks for -s`
- `admin rotate-key writes the new key to the named remote`
- `admin log with no flag reads every bot's questions`
- `key create prints the key and leaves the book alone`
- `key create --save stores the key under the bot's label`
- `key create --save --as fails off a terminal when the alias is taken`
- `key create --invite prints a join line that decodes to the remote url and key`
- `key create --invite against the local service fails`
- cli.test: `jaypost key list is an unknown command`, `jaypost admin key list -s x` and `jaypost admin -s x key list` both reach the remote `x`

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vp test apps/cli/test/commands/admin.test.ts apps/cli/test/commands/key.test.ts apps/cli/test/commands/log.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run everything**

Run: `pnpm test && pnpm check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli
git commit -m "feat: admin command group with -s, key create --save and --invite"
```

---

### Task 9: `bots` list, default, rename, remove

**Files:**
- Create: `apps/cli/src/commands/bots.ts`
- Modify: `apps/cli/src/cli.ts`, `apps/cli/src/commands/index.ts`
- Test: `apps/cli/test/commands/bots.test.ts`

**Interfaces:**
- Consumes: Task 1 operations, `BookDeps` (Task 7), `formatTable`, `describeEndpoint`.
- Produces:
  - `runBotsList(deps: BookDeps): Promise<number>`: `formatTable(['', 'ALIAS', 'SERVICE'], ...)` with `*` in the first column for the default; empty: `No bots. Run "jaypost service install" or "jaypost join".`
  - `runBotsDefault(args: { alias: string }, deps)`, `runBotsRename(args: { alias: string; newAlias: string }, deps)`: print the `BookChange` failure message and return 1, else write and print `Default bot is now "<alias>".` / `Renamed "<old>" to "<new>".`
  - `runBotsRemove(args: { alias: string; yes?: boolean }, deps)`: asks `Remove "<alias>" from your contacts?` unless `yes`; removing the default with others left: on a TTY `prompt.select` for the next default, else keep `removeBot`'s pick and print `Default bot is now "<alias>".`
  - `jaypost bots` with no subcommand runs the list.

- [ ] **Step 1: Write the failing tests**
- `bots lists aliases with the default marked and no keys`
- `bots default switches the default`; `bots rename keeps the default`
- `bots remove of the default off a terminal picks the first remaining bot and says so`
- `bots on an empty book says how to add one`

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vp test apps/cli/test/commands/bots.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement** and wire `bots` in `cli.ts`.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vp test apps/cli/test/commands/bots.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli
git commit -m "feat: bots list, default, rename and remove"
```

---

### Task 10: `join`

**Files:**
- Create: `apps/cli/src/commands/join.ts`
- Modify: `apps/cli/src/cli.ts`, `apps/cli/src/commands/{types,index}.ts`
- Test: `apps/cli/test/commands/join.test.ts`

**Interfaces:**
- Consumes: `decodeInvite`, `saveBot`, `findBot`, `readBook`, `writeBook` (Task 1); `FetchStatus`, `WaitForPairing` with `url` (Task 5); `BookDeps` (Task 7); `formatPairingText`.
- Produces:
  - `JoinDeps = BookDeps & { fetchStatus: FetchStatus; wait: WaitForPairing; progress: Progress; signal?: AbortSignal }`
  - `runJoin(args: { invite: string; as?: string }, deps: JoinDeps): Promise<number>`:
    1. `decodeInvite`; undefined: `that isn't a valid invite; ask for a new one`, exit 1.
    2. `fetchStatus(new URL(url), key)`: `unauthorized` → `the service rejected the key in this invite`, `unreachable` → `couldn't reach <describeEndpoint>`; nothing saved, exit 1.
    3. Alias: `args.as` ?? `status.displayName` without a leading `@` ?? the url's host. Taken by a different entry: TTY asks `Replace "<alias>" in your contacts?`, else fails with a hint to use `--as`.
    4. `writeBook(saveBot(book, { alias, url, key }))`; print `Added <alias> (<describeEndpoint>) to your contacts` plus `, set as default.` when the book had no bots, else `.`.
    5. Paired: print `Try: jaypost ping` (with `-b <alias>` when it isn't the default), exit 0. Unpaired: `deps.wait({ url, token: key, isRunning: async () => true, logsHint: '', progress, signal })`; `paired` → the Try line, 0; `interrupted` → 130 (entry stays saved); `notStarted`/`stopped` → `the service stopped answering; the key works once you send the code`, 1; `unauthorized` → the rejected-key message, 1.

- [ ] **Step 1: Write the failing tests** (fake `fetchStatus` and `wait`)
- `join saves the bot under its display name and makes it the default on an empty book`
- `join waits for pairing and ends with the try line`
- `join with --as uses that alias and keeps the existing default`
- `join saves nothing when the service rejects the key`
- `join rejects a truncated invite without echoing it`
- `join keeps the entry when interrupted while waiting`

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vp test apps/cli/test/commands/join.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement** and wire `join <invite> [--as <alias>]` in `cli.ts` with `waitForPairing` and the setup signals.

- [ ] **Step 4: Run everything**

Run: `pnpm test && pnpm check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli
git commit -m "feat: join a bot from an invite"
```

---

### Task 11: Docs and glossary

**Files:**
- Modify: `README.md`, `docs/{commands,hosting,install,pairing,scripts,mcp,claude-code,ci,security,question-log}.md`, `docs/openapi.yaml` (admin key location text, regenerate with `pnpm openapi`), `packages/service/src/server/openapi.ts`, `GLOSSARY.md`, `install.sh`, `apps/site` pages, `claude-plugin` docs, and every user-facing message still saying `jaypost init`, `jaypost uninstall`, `jaypost start`, `jaypost key create`, `JAYPOST_TOKEN ... token file` or `~/.config/jaypost/token`.

**Interfaces:**
- Consumes: the final command names from Tasks 5 to 10.
- Glossary adds: **Contact book** (the client's `bots.json`), **Contact** (one book entry, an alias for one API key; the CLI lists them under `jaypost bots`; _Avoid_: bot, which is the chat app account), **Local service**, **Remote**, **Invite** (avoid confusing it with a pairing code).

- [ ] **Step 1: Find every stale mention**

Run: `grep -rn "jaypost init\|jaypost uninstall\|jaypost start\b\|jaypost key \|jaypost bot \|jaypost pairing \|admin-key rotate\|config/jaypost/token\|--port" README.md docs apps packages install.sh claude-plugin GLOSSARY.md --include=*.md --include=*.ts --include=*.yaml --include=*.sh --include=*.astro`
Expected: a list to work through (CLI `--port` mentions stay only for `service install` and `openapi`).

- [ ] **Step 2: Update the docs and messages.** `hosting.md` gets the VM flow (`service install --exposed`, the printed `remote add` line, `admin -s`), handing keys out with `admin key create --invite` and `join`, and CI keys still from bare `admin key create`. `security.md` says where keys live (`bots.json`, 0600) and that `--exposed` is plain http.

- [ ] **Step 3: Re-run the grep and the suite**

Run: the Step 1 grep, then `pnpm test && pnpm check`
Expected: only intended mentions left; PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: contact book, service, remote, bots, join and admin commands"
```
