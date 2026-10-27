import { closeSync, fchmodSync, mkdirSync, openSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  BUSY_TIMEOUT_MS,
  WAL_ATTEMPT_COUNT,
  DATABASE_FILE_MODE,
  DATABASE_FILE_NAME,
  DATABASE_FILE_SUFFIXES,
  SCHEMA_SQL,
  SCHEMA_VERSION,
} from './constants.ts'

const openedPaths = new WeakMap<DatabaseSync, string>()

/** Path of the database file: `jaypost.db` in the same directory as the config file. */
export function resolveDatabasePath(configPath: string): string {
  return join(dirname(configPath), DATABASE_FILE_NAME)
}

/**
 * Opens the database at `path`, creating the directory, the owner-only file and the schema when
 * missing. Sets WAL, foreign keys and a busy timeout so a second connection can read while one
 * writes. Throws if the file isn't a usable database or has another schema version; the message
 * never quotes file contents, and the handle is closed first.
 */
export function openDatabase(path: string): DatabaseSync {
  createOwnerOnlyFile(path)
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(path)
    // First, so the WAL switch below waits on a racing opener instead of failing.
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    enableWal(database)
    database.exec('PRAGMA foreign_keys = ON')
    ensureSchema(database)
  } catch (error) {
    closeQuietly(database)
    if (error instanceof SchemaVersionError) {
      throw new Error(
        `database ${JSON.stringify(path)} has schema version ${error.version}, this jaypost reads ${SCHEMA_VERSION}`,
      )
    }
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`database ${JSON.stringify(path)} can't be opened: ${reason}`)
  }
  openedPaths.set(database, path)
  return database
}

/**
 * The path `openDatabase` was given for `database`, as the caller wrote it (location() resolves
 * symlinks, so it can name another path). Undefined for handles opened elsewhere.
 */
export function findDatabasePath(database: DatabaseSync): string | undefined {
  return openedPaths.get(database)
}

/** Deletes the database and its `-wal` and `-shm` files; missing files are fine. */
export function removeDatabaseFiles(path: string): void {
  for (const suffix of DATABASE_FILE_SUFFIXES) {
    rmSync(`${path}${suffix}`, { force: true })
  }
}

class SchemaVersionError extends Error {
  public readonly version: number

  public constructor(version: number) {
    super(`schema version ${version}`)
    this.version = version
  }
}

// SQLite gives the -wal and -shm files the main file's mode, so fixing it up front covers all
// three even under a loose umask.
function createOwnerOnlyFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const fd = openSync(path, 'a', DATABASE_FILE_MODE)
  try {
    fchmodSync(fd, DATABASE_FILE_MODE)
  } finally {
    closeSync(fd)
  }
}

// Switching a fresh file to WAL can fail with SQLITE_BUSY right away (the busy handler isn't
// consulted when two openers collide there), but the winner finishes the switch in moments.
function enableWal(database: DatabaseSync): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      database.exec('PRAGMA journal_mode = WAL')
      return
    } catch (error) {
      if (attempt === WAL_ATTEMPT_COUNT || !String(error).includes('locked')) {
        throw error
      }
    }
  }
}

function ensureSchema(database: DatabaseSync): void {
  if (readVersion(database) === SCHEMA_VERSION) {
    return
  }
  // IMMEDIATE takes the write lock first, so a racing opener sees our schema after waiting.
  database.exec('BEGIN IMMEDIATE')
  try {
    const version = readVersion(database)
    if (version === 0 && !hasTables(database)) {
      database.exec(SCHEMA_SQL)
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    } else if (version !== SCHEMA_VERSION) {
      throw new SchemaVersionError(version)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function readVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get()
  return Number(row?.user_version ?? 0)
}

function hasTables(database: DatabaseSync): boolean {
  return (
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get() !== undefined
  )
}

function closeQuietly(database: DatabaseSync | undefined): void {
  try {
    database?.close()
  } catch {
    // Best effort: the open error is the one worth reporting.
  }
}
