export const DATABASE_FILE_NAME = 'jaypost.db'

export const SCHEMA_VERSION = 1

export const BUSY_TIMEOUT_MS = 5_000
export const WAL_ATTEMPT_COUNT = 3

export const DATABASE_FILE_MODE = 0o600

export const DATABASE_FILE_SUFFIXES = ['', '-wal', '-shm'] as const

export const SCHEMA_SQL = `
CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE seed (
  only INTEGER PRIMARY KEY CHECK (only = 1),
  fingerprint TEXT NOT NULL, bot_id TEXT NOT NULL, pairing_id TEXT NOT NULL,
  key_id TEXT NOT NULL, is_open INTEGER NOT NULL
);
CREATE TABLE bots (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, settings TEXT NOT NULL,
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
  record TEXT NOT NULL,
  PRIMARY KEY (bot_id, id)
);
CREATE TABLE notifications (
  bot_id TEXT NOT NULL, id TEXT NOT NULL, provider TEXT NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (bot_id, id)
);
CREATE TABLE questions (
  bot_id TEXT NOT NULL, id TEXT NOT NULL,
  asked_at TEXT NOT NULL, project TEXT, text TEXT NOT NULL, options TEXT NOT NULL,
  timeout_option TEXT NOT NULL, timeout_seconds INTEGER NOT NULL,
  key_id TEXT, pairing_id TEXT,
  outcome TEXT, answer TEXT, settled_at TEXT,
  PRIMARY KEY (bot_id, id)
);
CREATE INDEX questions_asked_at ON questions (asked_at);
`
