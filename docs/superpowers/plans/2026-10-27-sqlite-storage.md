# SQLite Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `registry.json` and every bot's `bots/<id>/state.json` and `audit.jsonl(.1)` with one `jaypost.db` next to `config.json`.

**Architecture:** A new `database` module in `packages/store` opens the file (WAL, foreign keys, busy timeout, schema check). `RegistryStore`, `StateStore` and `AuditLog` keep their roles and most of their method shapes but take a `DatabaseSync` instead of a path. The service opens the db once and hands it to the hub and every bot; the CLI opens it per command. Local `log`/`audit dump` keep speaking the old jsonl line format, generated from rows, so the host-side parser and container plumbing don't change.

**Tech Stack:** Node `node:sqlite` (`DatabaseSync`), TypeScript run directly, zod, `vite-plus/test`.

**Spec:** `docs/superpowers/specs/2026-10-27-sqlite-storage-design.md`

## Global Constraints

- No new runtime dependency; `node:sqlite` only.
- Db file `jaypost.db` in `dirname(configPath)`; `-wal`/`-shm` beside it. All three mode 0600.
- `PRAGMA user_version = 1`; any other non-zero version is an error naming the file.
- Question log keeps 30 days (`asked_at` older than now minus 30 days is deleted), pruned at service start and every 24 h.
- No import of old files, no detection of them, no migration code. `migrateLegacyBotFiles` is deleted.
- Error messages never quote db contents (tokens, people ids); name the file instead.
- `StateStore` and `AuditLog` never throw (log and carry on). `RegistryStore.load` throws on corrupt data without quoting; `save` throws and leaves the db as it was.
- Local `log` and `audit dump` output is unchanged and covers the seed bot only.
- Match the surrounding repo style (free functions and `#private` classes as in `packages/store`), not a different house style. No em-dashes anywhere. Commits: conventional, lowercase, no Co-Authored-By trailer.
- Run a single test file with `node_modules/.bin/vp test <path>`; the whole suite with `node_modules/.bin/vp test`; types and lint with `node_modules/.bin/vp check`.

## Review Focus

1. CLI touching the db while the service holds it (`bot add` racing a start, `owner clear` inside a running container, `log` while questions are being written): reads must succeed under WAL and a write must wait, not fail at once. Test in Task 1.
2. Seed bot's provider changed in place (same bot id, Telegram to Discord): saved requests and notifications from the old provider are skipped, deleted and logged, never handed to the new runtime. Test in Task 3.
3. A `settled` event whose `asked` row doesn't exist (pruned, or the insert failed): nothing is written, nothing throws. Test in Task 4.
4. A file at the db path that isn't SQLite, or a db with another schema version: startup fails with a message naming the path and nothing from its contents. Test in Task 1.
5. `jaypost log` on a machine where the service has never run: prints the empty-log message and does not create `jaypost.db`. Test in Task 4 (`readSeedAuditLog`) and Task 6 (CLI).

---

### Task 1: Database module

**Files:**
- Create: `packages/store/src/database/constants.ts`, `packages/store/src/database/database.ts`, `packages/store/src/database/index.ts`
- Modify: `packages/store/src/index.ts` (re-export), possibly root and `apps/cli` `package.json` `engines`
- Test: `packages/store/test/database/database.test.ts`

**Interfaces:**
- Produces:
  - `DATABASE_FILE_NAME = 'jaypost.db'`, `SCHEMA_VERSION = 1`, `BUSY_TIMEOUT_MS = 5_000`
  - `resolveDatabasePath(configPath: string): string`
  - `openDatabase(path: string): DatabaseSync` (creates dir and file, applies pragmas, creates or checks schema; throws on failure, closing what it opened)
  - `removeDatabaseFiles(path: string): void` (db, `-wal`, `-shm`; missing is fine)
  - Tables exactly as the spec's schema sketch, with `provider TEXT NOT NULL` on `requests` and `notifications` and the `questions_asked_at` index. Keep the `CREATE TABLE` SQL in `constants.ts` as `SCHEMA_SQL`.

- [ ] **Step 1: Check the Node floor.** Run `node_modules/.bin/vp env exec --node 24.2.0 node -e "new (require('node:sqlite').DatabaseSync)(':memory:')"` and look at stderr. No `ExperimentalWarning`: leave `engines` alone. A warning: find the first 24.x that's quiet and set `"node": ">=<that version>"` in the root `package.json` and every workspace `package.json` that has `engines`. Don't suppress warnings in code.

- [ ] **Step 2: Write the failing tests** (temp dirs via `mkdtempSync`, as `test/state/store.test.ts` does):
  - `resolves jaypost.db next to the config`: `resolveDatabasePath('/data/config.json')` is `/data/jaypost.db`.
  - `creates the schema at version 1`: after `openDatabase`, `PRAGMA user_version` is 1 and `sqlite_master` lists `counters, seed, bots, pairings, keys, requests, notifications, questions`.
  - `keeps the db and its wal files owner-only`: open, insert a row into `counters`, then `statSync(...).mode & 0o777` is `0o600` for the db, `-wal` and `-shm`, even with `process.umask(0o022)` set for the test (restore it after).
  - `reopens an existing db without touching its rows`.
  - `lets a second connection read while the first holds a write transaction`: connection A runs `BEGIN IMMEDIATE` and inserts; connection B (another `openDatabase` on the same path) reads `counters` without throwing and doesn't see A's row; A commits; B now sees it.
  - `refuses another schema version`: set `user_version = 2` through a raw `DatabaseSync`, then `openDatabase` throws a message containing the quoted path and `schema version 2`.
  - `refuses a file that isn't sqlite without quoting it`: write `SECRET-TOKEN-123` to the path; `openDatabase` throws, the message contains the quoted path and not `SECRET-TOKEN-123`.
  - `removes the db and its wal files, missing ones too`.

- [ ] **Step 3: Run** `node_modules/.bin/vp test packages/store/test/database/database.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 4: Implement `openDatabase`.** Create the file 0600 before SQLite opens it (`openSync(path, 'a', 0o600)` then `fchmodSync` like `writeFileAtomic` does, then close); SQLite gives `-wal`/`-shm` the db file's mode, which the test proves. Pragmas in order: `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = BUSY_TIMEOUT_MS`. `user_version` 0 with no tables: run `SCHEMA_SQL` and set `user_version = 1` in one transaction. Any SQLite error during open becomes `database ${JSON.stringify(path)} can't be opened: ${error.message}` (SQLite's messages don't quote file contents); version mismatch: `database ${JSON.stringify(path)} has schema version ${version}, this jaypost reads ${SCHEMA_VERSION}`. Close the handle before throwing.

- [ ] **Step 5: Run the test file.** Expected: PASS. Run `node_modules/.bin/vp check`. Expected: clean.

- [ ] **Step 6: Commit** `feat: sqlite database module for the service's storage`

---

### Task 2: Registry in the db

**Files:**
- Modify: `packages/store/src/registry/store.ts`, `paths.ts`, `constants.ts`, `index.ts`, `packages/store/src/index.ts`
- Modify: `packages/service/src/daemon/service.ts`, `packages/service/src/daemon/types.ts` (`HubOptions.store` stays `RegistryStore`), `apps/cli/src/commands/bot.ts`, `apps/cli/src/commands/owner.ts`
- Test: `packages/store/test/registry/store.test.ts`, and fix `packages/service/test/daemon/service.test.ts`, `packages/service/test/server/admin.test.ts`, `apps/cli/test/commands/{owner,admin,manage,init}.test.ts` where they write or read `registry.json`

**Interfaces:**
- Consumes: `openDatabase`, `resolveDatabasePath` (Task 1).
- Produces:
  - `new RegistryStore(database: DatabaseSync)`; `load(): Registry`; `save(registry: Registry): void`. The store remembers the registry it last loaded or saved and `save` writes only the difference against it, in one transaction: inserted, changed (compare with `isDeepStrictEqual` from `node:util`) and deleted rows of `bots`, `pairings`, `keys`; `counters` and `seed` only when they differ. Deleting a bot also deletes its `requests` and `notifications` rows. On a throw the transaction rolls back and the remembered registry stays the old one.
  - `load` builds the `Registry` from rows (`settings` parsed from JSON, `is_open` to boolean, null columns omitted, not `undefined`) and validates it with the existing `registrySchema`; JSON or schema failure throws `database ${JSON.stringify(path)} has an invalid registry`, where the path comes from `database.location()` (if that method is missing on the Node floor, take the path as a second constructor argument instead). An empty db loads `createEmptyRegistry()`.
  - `resolveSeedAuditPath` and the `REGISTRY_FILE_NAME`/`resolveRegistryPath` exports are deleted. `migrateLegacyBotFiles` and its call in `loadSeededRegistry` are deleted. `resolveBotFiles`, `BOTS_DIRECTORY_NAME` stay until Task 5.
  - `startService` opens the db with `openDatabase(resolveDatabasePath(configPath))`, builds `RegistryStore` on it, and `RunningService.stop` closes the db after `hub.stop()` and `server.close()` settle. A throw between open and the hub existing closes the db.
  - `bot add` (offline path) and `owner get|clear` open the db, use `RegistryStore`, and close it in `finally`.

- [ ] **Step 1: Rewrite the registry store tests**: drop the file-based and `migrateLegacyBotFiles` cases; keep the admin key cases unchanged. New cases:
  - `loads an empty registry from a new db`
  - `round-trips a registry with bots, pairings, keys, counters and a seed`: `assert` `load()` on a fresh `RegistryStore` over the same db deep-equals what was saved, with omitted optional fields still omitted.
  - `writes only the rows a change touches`: save a registry with bots b1 and b2; change b2's label in the db by raw SQL; save a registry that only adds a pairing on b1; a fresh load shows b2's raw-SQL label (proof b2's row wasn't rewritten).
  - `removing a bot deletes its pairings, keys, requests and notifications`: seed `requests`/`notifications` rows for b1 and b2 by raw SQL; save a registry from `removeBot(registry, 'b1')`; only b2's rows remain.
  - `a failed save changes nothing and the next save still applies`: save a registry, then save one with two keys sharing a `hash` (UNIQUE violation); it throws; a fresh load equals the first registry; then saving a valid change succeeds and loads back.
  - `refuses a corrupt registry without quoting it`: raw-SQL insert a bot with `settings` = `'{"token":"SECRET-1'`; `load()` throws, message names the db path, doesn't contain `SECRET-1`.

- [ ] **Step 2: Run** `node_modules/.bin/vp test packages/store/test/registry/store.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the store as described in Interfaces. Use prepared statements with named parameters; wrap a save in `BEGIN`/`COMMIT` with `ROLLBACK` in the catch.

- [ ] **Step 4: Run the registry tests.** Expected: PASS.

- [ ] **Step 5: Switch the callers** (`service.ts`, `bot.ts`, `owner.ts`) as in Interfaces, and update the service and CLI tests that wrote `registry.json` to seed and inspect through `RegistryStore` over `openDatabase(resolveDatabasePath(configPath))` instead.

- [ ] **Step 6: Run** `node_modules/.bin/vp test` and `node_modules/.bin/vp check`. Expected: all pass, clean.

- [ ] **Step 7: Commit** `feat: keep the registry in the sqlite db`

---

### Task 3: Bot state in the db

**Files:**
- Modify: `packages/store/src/state/store.ts`, `index.ts`, `constants.ts`, `packages/store/src/index.ts`
- Modify: `packages/service/src/daemon/bot.ts`, `packages/service/src/daemon/types.ts`, `packages/service/src/daemon/hub.ts` (pass the db), `packages/service/src/daemon/service.ts` (`HubOptions` gains `database`)
- Test: `packages/store/test/state/store.test.ts`, delete `packages/store/test/state/parser.test.ts`, fix `packages/service/test/daemon/*.test.ts`

**Interfaces:**
- Consumes: `openDatabase` (Task 1); the hub's db from Task 2's `startService`.
- Produces:
  - `new StateStore(database: DatabaseSync, botId: string, providerName: string, log: (line: string) => void)` with the same methods and contracts as today: `load(): SavedState`, `addRequest`, `removeRequest`, `addNotification`, `removeNotification`, `freeze()`. Each change is one `INSERT OR REPLACE` or `DELETE` on `requests`/`notifications` keyed by `(bot_id, id)` with `provider = providerName`; nothing rewrites other rows.
  - `load` reads this bot's rows. Rows with another `provider` are deleted and logged once: `ignoring saved state for provider ${JSON.stringify(provider)}`. A row whose `record` fails JSON parse or the request/notification schema (split `stateFileSchema` in `state/schema.ts` into exported `requestRecordSchema` and `notificationRecordSchema`) is deleted and logged: `ignoring a saved request|notification: invalid or missing fields`. Never quote the record.
  - Every failure (load or write) is logged as today and never thrown; in-memory state stays authoritative.
  - `HubOptions.database: DatabaseSync`; `BotOptions.database: DatabaseSync` (keep `directory` for the audit file until Task 5).
  - Delete `parseState`, `resolveStatePath`, `STATE_FILE_NAME`, `STATE_VERSION`, `stateFileSchema`, `StateParseResult`.

- [ ] **Step 1: Rewrite the state store tests**:
  - `loads nothing for a bot with no rows`
  - `keeps added requests and notifications across a reopen`: add one of each, open a new `StateStore` on the same db and bot, `load()` deep-equals `{ requests: [REQUEST], notifications: [NOTIFICATION] }`.
  - `removes only the given record`
  - `keeps each bot's state apart`: rows added for b1 don't load for b2.
  - `drops state saved for another provider`: add a request as provider `telegram`; load as `discord` returns empty, logs the provider line once, and a second `telegram` load is also empty (rows deleted).
  - `drops an invalid row without quoting it`: raw-SQL insert a request row whose record is `'{"id":"r9","text":"SECRET-2"}'` (no `reference`); load skips it, logged line doesn't contain `SECRET-2`.
  - `freeze ignores later changes`
  - `logs and keeps going when a write fails`: close the db, then two `addRequest` calls don't throw and log two lines.

- [ ] **Step 2: Run** `node_modules/.bin/vp test packages/store/test/state/store.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the store; then `startBot` builds `new StateStore(options.database, record.id, provider.name, log)`, and the hub passes its db.

- [ ] **Step 4: Run** `node_modules/.bin/vp test` and `node_modules/.bin/vp check`. Expected: pass, clean.

- [ ] **Step 5: Commit** `feat: keep bots' pending requests and notifications in the sqlite db`

---

### Task 4: Question log in the db (store package)

**Files:**
- Modify: `packages/store/src/audit/store.ts`, `constants.ts`, `types.ts`, `index.ts`, `packages/store/src/index.ts`
- Test: `packages/store/test/audit/store.test.ts` (and `parser.test.ts` if it writes through `AuditLog`)

**Interfaces:**
- Consumes: `openDatabase`, `resolveDatabasePath` (Task 1), `RegistryStore` (Task 2), `parseAuditLog` (unchanged).
- Produces:
  - `AUDIT_RETENTION_MS = 30 * 86_400_000`
  - `new AuditLog(database: DatabaseSync, botId: string, options?: { log?: (line: string) => void })` implementing `AuditSink`. `asked`: `INSERT OR IGNORE` a `questions` row. `settled`: `UPDATE ... SET outcome, answer, settled_at WHERE bot_id = ? AND id = ? AND outcome IS NULL`; no row, no effect. Failures logged, never thrown.
  - `type BotAuditEntry = { readonly botId: string; readonly entry: AuditEntry }`
  - `readAuditEntries(database: DatabaseSync, now: Date, botId?: string): { readonly entries: readonly BotAuditEntry[]; readonly skippedCount: number }`: every bot's rows (or one bot's), ordered by `asked_at` then `rowid`; `entry` built exactly as `parseAuditLog`'s `toEntry` does (status = outcome, else `interrupted` when past `timeoutSeconds`, else `pending`; no `bot` field). A row whose `options` isn't a JSON string array counts in `skippedCount`. Reads removed bots' rows too.
  - `formatAuditLines(database: DatabaseSync, botId: string): string`: the bot's rows as the current jsonl format (`AskedRecord` line per row, plus a `SettledRecord` line for settled ones, `v: AUDIT_FORMAT_VERSION`, each line ending `\n`), in asked order, so `parseAuditLog(formatAuditLines(db, id), now)` gives the same entries as `readAuditEntries(db, now, id)` mapped to `.entry`.
  - `readSeedAuditLog(configPath: string): string`: `''` when `resolveDatabasePath(configPath)` doesn't exist (and creates nothing); otherwise opens it, finds `seed.botId` via `RegistryStore`, returns `formatAuditLines` for it (`''` with no seed), closes the db. Throws on a corrupt db.
  - `pruneAuditLog(database: DatabaseSync, before: Date): number`: deletes rows with `asked_at < before.toISOString()`, returns the count.
  - Delete `readAuditFiles`, `removeAuditFiles`, `resolveAuditPath`, `AUDIT_FILE_NAME`, `ROTATED_SUFFIX`, `MAX_AUDIT_LOG_BYTES`, `AuditLogOptions.maxBytes` once Tasks 5 and 6 drop their uses; in this task keep them exported so the build stays green.

- [ ] **Step 1: Rewrite the audit store tests** (fixed `NOW`, `SentRequest` fixtures as today):
  - `logs a settled question with its answer`: `asked` then `settled` with an answer; `readAuditEntries(db, NOW)` deep-equals one `BotAuditEntry` with status `answered`, `answer`, `settledAt`, `key`, `pairing`.
  - `marks an unsettled question pending, then interrupted after its timeout`
  - `keeps the first settlement`: two `settled` calls, the first wins.
  - `ignores a settlement with no asked question`: `settled` for unknown id, no row, no throw, no log line.
  - `reads one bot or every bot, oldest first`
  - `round-trips through the jsonl format`: `parseAuditLog(formatAuditLines(db, 'b1'), NOW).entries` deep-equals `readAuditEntries(db, NOW, 'b1').entries.map(({ entry }) => entry)` for a mix of settled, pending and project-less questions.
  - `prunes questions asked before the cutoff`: rows at NOW-31d, NOW-29d; `pruneAuditLog(db, new Date(NOW - AUDIT_RETENTION_MS))` returns 1 and the newer row remains.
  - `reads the seed bot's log next to the config`: `readSeedAuditLog` returns only the seed bot's lines.
  - `reads nothing and creates no db when the service never ran`: `readSeedAuditLog` on an empty temp dir returns `''` and `existsSync(dbPath)` is false.
  - `logs and keeps going when a write fails`: closed db, `asked` doesn't throw, logs once.

- [ ] **Step 2: Run** `node_modules/.bin/vp test packages/store/test/audit/store.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** as in Interfaces; `options` and `timeout_seconds` stored as JSON text and integer.

- [ ] **Step 4: Run** the audit tests, then `node_modules/.bin/vp check`. Expected: PASS, clean.

- [ ] **Step 5: Commit** `feat: keep the question log in the sqlite db`

---

### Task 5: Service uses the db log; daily pruning

**Files:**
- Modify: `packages/service/src/daemon/bot.ts`, `hub.ts`, `types.ts`, `service.ts`, `constants.ts`
- Test: `packages/service/test/daemon/service.test.ts`, `packages/service/test/server/admin.test.ts`

**Interfaces:**
- Consumes: `AuditLog`, `readAuditEntries`, `pruneAuditLog`, `AUDIT_RETENTION_MS` (Task 4); db on `HubOptions` (Task 3).
- Produces:
  - `startBot` builds `new AuditLog(options.database, record.id, { log })`. `BotOptions.directory` is deleted. `HubOptions.configPath` is deleted if nothing else uses it.
  - `Hub.readLog(query)`: `readAuditEntries(db, now, query.bot)`, each mapped through `#toAdminEntry(botId, entry)`, then `selectAuditEntries`. No `notFound` for an unknown `bot` id; an unknown id just returns no entries.
  - `Hub#readLog(keyId, botId, query)`: same reader for one bot, `.entry` only (no `bot` field in `/log` output), same seed-line rule as today.
  - `PRUNE_INTERVAL_MS = 86_400_000` in `service/src/daemon/constants.ts`. `startService` prunes once before the hub starts, using `options.now`, and then on a `setInterval(..., PRUNE_INTERVAL_MS).unref()` cleared in `stop` before the db closes. A prune that throws logs `failed to prune the question log: ${message}` and the service keeps running. A non-zero count logs `pruned ${count} questions older than 30 days`.
  - Delete `resolveBotFiles`, `BotFiles`, `BOTS_DIRECTORY_NAME` and their exports.

- [ ] **Step 1: Update and add service tests:**
  - `serves every bot's log from the db, removed bots included`: ask on b1 and b2, remove b2 through the admin API, `GET /admin/log` returns both bots' questions with `bot` set; `GET /admin/log?bot=b2` is 200 with b2's question.
  - `a key's /log has no bot field`: `GET /log` entries deep-equal the expected entry without `bot`.
  - `prunes questions older than 30 days at start`: pre-insert a row asked 31 days before the injected `now`; after `startService`, the row is gone and a `pruned 1 questions` line was logged.
  - `stop closes the db`: after `stop()`, `openDatabase` on the same path then a write succeeds (no lock left), and the old handle's `isOpen` is false.
  - Drop assertions about `bots/<id>/` directories and `audit.jsonl` files.

- [ ] **Step 2: Run** `node_modules/.bin/vp test packages/service`. Expected: FAIL.

- [ ] **Step 3: Implement** as in Interfaces.

- [ ] **Step 4: Run** `node_modules/.bin/vp test` and `node_modules/.bin/vp check`. Expected: pass, clean.

- [ ] **Step 5: Commit** `feat: read the admin log from the db and prune it daily`

---

### Task 6: CLI and install targets read the db; purge removes it

**Files:**
- Modify: `apps/cli/src/commands/log.ts`, `audit.ts`, `packages/store/src/audit/constants.ts` (`MIN_AUDIT_VERSION`), `packages/install/src/install/systemd.ts`, `launchd.ts`, `native.ts`, and the store's audit exports (delete the file helpers from Task 4's list)
- Test: `apps/cli/test/commands/log.test.ts`, `apps/cli/test/cli.test.ts` (audit dump), `packages/install/test/install/{systemd,launchd}.test.ts`, native purge test wherever `purgeServiceFiles` is covered

**Interfaces:**
- Consumes: `readSeedAuditLog`, `resolveDatabasePath`, `removeDatabaseFiles`.
- Produces:
  - `log` (local, no install) and `audit dump` call `readSeedAuditLog(resolveConfigPath(env))`; systemd and launchd `readAuditLog` call `readSeedAuditLog(resolveConfigFile(record))`. Quadlet and Compose unchanged (they run `audit dump` inside).
  - `MIN_AUDIT_VERSION = '0.10.0'` with comment `Oldest service version whose question log this CLI reads (the sqlite db).` so a CLI pointed at an older install says to run `init`.
  - `purgeServiceFiles` removes `config.json`, the admin key and `removeDatabaseFiles(resolveDatabasePath(configFile))`; its lines for `registry.json`, `bots/`, `state.json` and the audit files go, and its JSDoc says what it removes now.

- [ ] **Step 1: Update tests:**
  - `log` tests seed questions through `AuditLog` on `openDatabase(resolveDatabasePath(configPath))` with a `RegistryStore` seed, instead of writing `audit.jsonl`; existing expected output strings stay as they are (proof output didn't change).
  - `log prints the empty message and creates no db when the service never ran`: spawn the CLI with `JAYPOST_CONFIG` in an empty temp dir; output is today's empty-log text; no `jaypost.db` afterwards.
  - `audit dump` test: prints the seed bot's jsonl lines, not other bots'.
  - systemd/launchd `readAuditLog` tests read from the db.
  - purge test: `jaypost.db`, `-wal`, `-shm` are gone afterwards; config and admin key gone.
  - `log` against an install record at `0.9.0` prints the run-init message.

- [ ] **Step 2: Run** `node_modules/.bin/vp test apps/cli packages/install`. Expected: FAIL.

- [ ] **Step 3: Implement** as in Interfaces and delete the now-unused audit file helpers and constants.

- [ ] **Step 4: Run** `node_modules/.bin/vp test` and `node_modules/.bin/vp check`. Expected: pass, clean. `grep -rn "registry.json\|audit.jsonl\|state.json\|resolveBotFiles\|readAuditFiles" packages apps --include=*.ts` finds nothing outside tests that assert their absence.

- [ ] **Step 5: Commit** `feat: cli and install targets read the question log from the db`

---

### Task 7: Docs and changeset

**Files:**
- Modify: `docs/install.md`, `docs/hosting.md`, `docs/question-log.md`, `docs/security.md`, `docs/commands.md`, `docs/http-api.md`, `docs/openapi.yaml` if it documents the removed-bot `404` on `/admin/log`, `packages/store/package.json` description if it names files
- Create: `.changeset/sqlite-storage.md`

**Interfaces:** none.

- [ ] **Step 1: Update docs.** Every mention of `registry.json`, `state.json`, `audit.jsonl`, `bots/<id>/` becomes `jaypost.db` next to `config.json` (the data volume for containers). In `question-log.md`: the 10 MiB rotation paragraph becomes "questions older than 30 days are deleted once a day"; the hand-delete `rm` commands go. `hosting.md`: drop the "install from before this release is moved in place" paragraph; say an older install needs `init` again and starts with an empty registry. `http-api.md` and `hosting.md`: a removed bot's questions stay readable through `/admin/log` until they're 30 days old. `security.md`: `jaypost.db` holds bot tokens, key hashes and people ids, mode 0600. No em-dashes.

- [ ] **Step 2: Write the changeset** (`minor` for the `jaypost` package, same front-matter shape as the other files in `.changeset/`), in the user's voice: one short paragraph saying storage moved to one `jaypost.db`, old files aren't read, rerun `jaypost init`, log keeps 30 days.

- [ ] **Step 3: Check.** `grep -rn "registry.json\|audit.jsonl\|state.json\|bots/b1" docs README.md` finds nothing stale; `node_modules/.bin/vp check` clean.

- [ ] **Step 4: Commit** `docs: describe the sqlite db and 30-day question log`
