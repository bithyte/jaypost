# SQLite storage for the service

## Why

The hosted service will run many bots. Today every bot adds a directory, `bots/<id>/`, holding
`state.json`, `audit.jsonl` and `audit.jsonl.1`, and `registry.json` is rewritten whole on every
bot, pairing or key change. The file count grows with the bot count. The goal is one SQLite file
per install instead.

## Goals

- One database file, `jaypost.db`, next to `config.json` (so in `/data` for containers), holding:
  - the registry: bots, pairings, keys, the id counters (`lastIds`) and the seed record
  - each bot's state: open requests and live notifications
  - the question log (asked and settled events) for every bot
- The same storage for every install: hosted, systemd, launchd, Quadlet, Compose, and `start` by
  hand. No file-based fallback path.
- The question log keeps the last 30 days. Older rows are deleted.
- A registry change writes only the rows it affects, not the whole registry.
- The merged admin log (`/admin/log`, `Hub.readLog`) becomes a query instead of reading and
  parsing every bot's file.

## Non-goals

- Importing or migrating existing files. jaypost is in alpha with no users; existing installs
  rerun `init`. The pre-upgrade move code (`migrateLegacyBotFiles` and the "move state.json and
  audit.jsonl into `bots/b1`" behavior) is deleted, not ported.
- Schema migrations. There's one schema version. A db with a different version is an error.
- Several processes sharing one db. If the hosted service ever runs several instances, a load
  balancer routes by API key and each instance owns its own db; that's out of scope here.
- Moving `config.json` or the admin key file into the db. Both stay files: people and installers
  write `config.json`, and installers and containers read and write `admin-key` (`readAdminKey`
  in the install targets, `admin-key rotate`).
- The client-side API token file (`token`) stays a file too.
- Detecting or cleaning up old-layout files. A service that finds `registry.json` or `bots/` but
  no `jaypost.db` just creates a fresh db and seeds it from `config.json`; bots added with
  `bot add`, extra keys and pairings from before are gone. That's accepted (no users yet).
- A command to delete the question log. Today's docs give `rm` commands; with SQLite that would
  need the `sqlite3` binary, which the image doesn't ship. 30-day pruning replaces it.

## Anti-goals

- A new runtime dependency. Use `node:sqlite` (built in; works on Node 24.22 with no flag or
  warning, and in the Node 26 single-binary build).
- Losing the "secrets on disk are 0600" property: the db holds bot tokens and key hashes.
- Error messages that quote db contents (tokens, people ids), same rule the registry file has now.

## Constraints

- Node >= 24.2 (root `engines`), ESM, `.ts` run directly. Code follows the repo's existing style in
  `packages/store`.
- The CLI touches storage while the service may be running: `bot add` writes the registry
  directly when the service isn't answering (it probes first), `owner clear` runs inside the
  running container during `init` without probing, and `log` / `audit dump` read the question
  log. The db must tolerate a second connection: WAL mode and a busy timeout.
- `StateStore` and `AuditLog` never throw today (they log and carry on; in-memory state stays
  authoritative). Keep those contracts.
- `RegistryStore.load` throws on a corrupt registry without quoting it; `save` throws and leaves
  the old data. Keep those contracts, now in terms of the db (a failed write rolls back its
  transaction).

## Decided

From the conversation:

- SQLite, one db for every install type.
- No auto-import, no migration command. Rerunning `init` is the upgrade path.
- Question log retention: 30 days.
- One machine per db; key-routed sharding later doesn't change this design.

My calls (the user didn't weigh in; change them if they're wrong):

- File name `jaypost.db`, next to `config.json`, with WAL's `-wal` and `-shm` files beside it.
- Schema version in `PRAGMA user_version`, set to 1 on create. Opening a db with another version
  throws a message naming the file and telling the user to rerun `init`.
- File mode 0600 on the db and its `-wal`/`-shm` files (create the db file 0600 before opening, or
  set the process umask around the open; builder picks).
- Pruning: delete log rows older than 30 days when the service starts and then once a day, using
  the service's injected clock. Pruning failures are logged, never thrown.
- Removing a bot deletes its pairings, keys and state rows. Its log rows stay until they age out,
  and `/admin/log` can return them (filtering by a removed bot's id stops being a `404`). This
  replaces today's "its files stay on disk but the API can't read its log".
- Pending requests and notifications keep their current shapes (`RequestRecord`,
  `NotificationRecord`); `reference` and `spans` are opaque JSON, so they go in a JSON text column.
  `SettingValues` on a bot likewise.
- `uninstall` with purge deletes `jaypost.db` and its `-wal`/`-shm` files instead of
  `registry.json`, `bots/`, and the pre-upgrade `state.json` and `audit.jsonl`. Old leftovers
  stay; nobody has them.
- Local `log` and `audit dump` keep showing only the seed bot's questions, output unchanged.
  Questions logged without a key on the seed bot still count as the seed key's, as
  `Hub#toAdminEntry` does today. Only `/admin/log` spans every bot.
- Saved state keeps the provider guard `parseState` gives today: the seed bot's provider can
  change in place under the same id (`updateSeedBot`), and a Telegram message reference must never
  reach a Discord runtime on recovery. Store the provider with each state row (or clear the bot's
  state rows when its provider changes) and skip rows whose provider doesn't match, logging it.
- `node:sqlite` must not print an ExperimentalWarning on any supported Node. It's verified quiet
  on 24.21 and 24.22; if earlier 24.x warns, raise `engines` to the first quiet version rather
  than suppressing warnings in code.

## Schema sketch

A starting point, not a contract. Column names mirror the current types.

```sql
CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL); -- bot, pairing, key
CREATE TABLE seed (
  only INTEGER PRIMARY KEY CHECK (only = 1),
  fingerprint TEXT NOT NULL, bot_id TEXT NOT NULL, pairing_id TEXT NOT NULL,
  key_id TEXT NOT NULL, is_open INTEGER NOT NULL
);
CREATE TABLE bots (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, settings TEXT NOT NULL, -- JSON
  label TEXT, created_at TEXT NOT NULL
);
CREATE TABLE pairings (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
  person TEXT, code TEXT, quiet_hours TEXT, muted_until TEXT, created_at TEXT NOT NULL
);
CREATE TABLE keys (
  id TEXT PRIMARY KEY, pairing_id TEXT NOT NULL REFERENCES pairings (id) ON DELETE CASCADE,
  hash TEXT UNIQUE, label TEXT, external_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE requests (
  bot_id TEXT NOT NULL, id TEXT NOT NULL, provider TEXT NOT NULL,
  record TEXT NOT NULL, -- JSON RequestRecord
  PRIMARY KEY (bot_id, id)
);
CREATE TABLE notifications (
  bot_id TEXT NOT NULL, id TEXT NOT NULL, provider TEXT NOT NULL,
  record TEXT NOT NULL, -- JSON NotificationRecord
  PRIMARY KEY (bot_id, id)
);
CREATE TABLE questions (
  bot_id TEXT NOT NULL, id TEXT NOT NULL,
  asked_at TEXT NOT NULL, project TEXT, text TEXT NOT NULL, options TEXT NOT NULL, -- JSON
  timeout_option TEXT NOT NULL, timeout_seconds INTEGER NOT NULL,
  key_id TEXT, pairing_id TEXT,
  outcome TEXT, answer TEXT, settled_at TEXT, -- null until settled
  PRIMARY KEY (bot_id, id)
);
CREATE INDEX questions_asked_at ON questions (asked_at);
```

The question log can be one row per question (asked inserts, settled updates) rather than one row
per event, since `log` only ever shows questions. `pending` vs `interrupted` is then derived the
same way `parseAuditLog` derives it today (no settled data, and whether the service is still
running it). Requests and notifications have no foreign key to `bots` because a bot's state can
outlive a failed start; the builder decides whether `removeBot` deletes them explicitly.

## What changes

- `packages/store`: a db module that opens the file, applies pragmas (WAL, `foreign_keys`,
  `busy_timeout`), creates the schema and checks `user_version`. `RegistryStore`, `StateStore` and
  `AuditLog` move onto it. `registry.json`, `state.json`, `audit.jsonl` paths, rotation,
  `readAuditFiles`, `removeAuditFiles`, `resolveBotFiles`/`BotFiles`, `BOTS_DIRECTORY_NAME`,
  `migrateLegacyBotFiles` and `resolveSeedAuditPath` go away or are replaced. The registry's pure
  operations (`operations.ts`, `queries.ts`, `seed.ts`) should keep working on the in-memory
  `Registry`; how a changed `Registry` turns into row writes is the builder's call.
- `packages/service`: `startService` opens the db once and hands it (or stores built on it) to
  the hub and to each bot instead of a directory. `Hub.readLog` queries. Pruning runs here.
- `apps/cli`: `bot`, `owner`, `log`, `audit dump` read and write the db.
- `packages/install`: native targets (systemd, launchd) read the log from the db; container
  targets keep running a command inside the container and parsing its stdout. `purgeServiceFiles`
  removes the db files.
- Docs that name the old files: `docs/install.md`, `docs/hosting.md`, `docs/question-log.md`
  (the hand-delete commands go; the 10 MiB rotation paragraph becomes 30-day retention), `docs/security.md`,
  `docs/commands.md`, `docs/http-api.md` (the removed-bot log note). A changeset entry.

## Left to the builder

- Module layout inside `packages/store`, and whether registry, state and log share one class or
  get one each over a shared connection.
- How registry operations become row writes (diff old vs new `Registry` in one transaction, or
  operations that return the rows they touched, or something else), as long as a change doesn't
  rewrite unrelated rows.
- What `audit dump` prints for the container targets (today: raw jsonl lines the host parses).
  Host CLI and container image are the same version in alpha, so the format can change freely.
- Whether `parseAuditLog` and the jsonl formatter survive in some form or are replaced by the
  query plus `formatAuditTable` / `formatAuditJsonLines`.
- Test strategy: real db files in a temp dir (repo style prefers real infra), `:memory:` where a
  file adds nothing.
