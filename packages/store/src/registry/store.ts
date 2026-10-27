import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { parseToken, readTokenFile, resolveClientSecret, writeTokenFile } from '../auth/token.ts'
import type { ClientToken } from '../auth/types.ts'
import { ADMIN_KEY_ENV_VAR, REGISTRY_VERSION } from './constants.ts'
import { generateAdminKey } from './keys.ts'
import { registrySchema } from './schema.ts'
import type { BotRecord, KeyRecord, PairingRecord, Registry, SeedRecord } from './types.ts'

type Row = Record<string, SQLOutputValue>

type Identified = { readonly id: string }

const TABLE_NAMES = ['bots', 'pairings', 'keys'] as const

const COUNTER_NAMES = ['bot', 'pairing', 'key'] as const

const UPSERT_BOT_SQL = `
INSERT INTO bots (id, provider, settings, label, created_at)
VALUES (:id, :provider, :settings, :label, :createdAt)
ON CONFLICT (id) DO UPDATE SET provider = excluded.provider, settings = excluded.settings,
  label = excluded.label, created_at = excluded.created_at`

const UPSERT_PAIRING_SQL = `
INSERT INTO pairings (id, bot_id, person, code, quiet_hours, muted_until, created_at)
VALUES (:id, :botId, :person, :code, :quietHours, :mutedUntil, :createdAt)
ON CONFLICT (id) DO UPDATE SET bot_id = excluded.bot_id, person = excluded.person,
  code = excluded.code, quiet_hours = excluded.quiet_hours, muted_until = excluded.muted_until,
  created_at = excluded.created_at`

const UPSERT_KEY_SQL = `
INSERT INTO keys (id, pairing_id, hash, label, external_id, created_at)
VALUES (:id, :pairingId, :hash, :label, :externalId, :createdAt)
ON CONFLICT (id) DO UPDATE SET pairing_id = excluded.pairing_id, hash = excluded.hash,
  label = excluded.label, external_id = excluded.external_id, created_at = excluded.created_at`

const UPSERT_COUNTER_SQL = `
INSERT INTO counters (name, value) VALUES (:name, :value)
ON CONFLICT (name) DO UPDATE SET value = excluded.value`

const UPSERT_SEED_SQL = `
INSERT INTO seed (only, fingerprint, bot_id, pairing_id, key_id, is_open)
VALUES (1, :fingerprint, :botId, :pairingId, :keyId, :isOpen)
ON CONFLICT (only) DO UPDATE SET fingerprint = excluded.fingerprint, bot_id = excluded.bot_id,
  pairing_id = excluded.pairing_id, key_id = excluded.key_id, is_open = excluded.is_open`

/** Thrown inside `load` for a row that isn't valid JSON, so the message can't quote it. */
class InvalidRowError extends Error {}

/**
 * Reads and writes the registry in the db, which holds bot tokens and key hashes. Remembers the
 * registry it last loaded or saved, and a save writes only the rows that differ from it.
 */
export class RegistryStore {
  readonly #database: DatabaseSync
  #remembered: Registry | undefined

  constructor(database: DatabaseSync) {
    this.#database = database
    this.#remembered = undefined
  }

  /**
   * The registry the db holds; an empty db gives an empty registry. Invalid rows throw without
   * quoting them, since they hold bot tokens. Other db errors are rethrown.
   */
  load(): Registry {
    const raw = this.#readRaw()
    const result = raw === undefined ? undefined : registrySchema.safeParse(raw)
    // Zod's issues can quote values, and so can JSON.parse's messages.
    if (result === undefined || !result.success) {
      throw new Error(`database ${JSON.stringify(this.#path())} has an invalid registry`)
    }
    this.#remembered = result.data
    return result.data
  }

  /**
   * Writes the rows of `registry` that differ from the last one loaded or saved, in one
   * transaction; a removed bot's requests and notifications go too. Throws on failure, rolls back
   * and keeps comparing against the old registry, so a later save still applies this change.
   */
  save(registry: Registry): void {
    const previous = this.#remembered ?? this.load()
    const database = this.#database
    database.exec('BEGIN IMMEDIATE')
    try {
      writeDifference(database, previous, registry)
      database.exec('COMMIT')
    } catch (error) {
      if (database.isTransaction) {
        database.exec('ROLLBACK')
      }
      throw error
    }
    this.#remembered = registry
  }

  #path(): string {
    return this.#database.location() ?? ':memory:'
  }

  /** The registry's rows as an unchecked object; undefined when a JSON column doesn't parse. */
  #readRaw(): unknown {
    const database = this.#database
    const counters = new Map(
      database
        .prepare('SELECT name, value FROM counters')
        .all()
        .map((row) => [row.name, row.value]),
    )
    const seedRow = database.prepare('SELECT * FROM seed WHERE only = 1').get()
    try {
      return {
        version: REGISTRY_VERSION,
        lastIds: Object.fromEntries(COUNTER_NAMES.map((name) => [name, counters.get(name) ?? 0])),
        bots: readRows(database, 'bots').map(toBot),
        pairings: readRows(database, 'pairings').map(toPairing),
        keys: readRows(database, 'keys').map(toKey),
        ...(seedRow === undefined ? {} : { seed: toSeed(seedRow) }),
      }
    } catch (error) {
      if (error instanceof InvalidRowError) {
        return undefined
      }
      throw error
    }
  }
}

// rowid order is insertion order, which is the order the registry's arrays grow in.
function readRows(database: DatabaseSync, table: (typeof TABLE_NAMES)[number]): Row[] {
  return database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
}

/** `{ [name]: value }`, or nothing for a null column, so absent fields stay absent. */
function optional(name: string, value: SQLOutputValue | undefined): Record<string, unknown> {
  return value === null || value === undefined ? {} : { [name]: value }
}

function parseSettings(value: SQLOutputValue | undefined): unknown {
  if (typeof value !== 'string') {
    throw new InvalidRowError()
  }
  try {
    return JSON.parse(value)
  } catch {
    // The parser's message can quote the column.
    throw new InvalidRowError()
  }
}

function toBot(row: Row): unknown {
  return {
    id: row.id,
    provider: row.provider,
    settings: parseSettings(row.settings),
    ...optional('label', row.label),
    createdAt: row.created_at,
  }
}

function toPairing(row: Row): unknown {
  return {
    id: row.id,
    botId: row.bot_id,
    ...optional('person', row.person),
    ...optional('code', row.code),
    ...optional('quietHours', row.quiet_hours),
    ...optional('mutedUntil', row.muted_until),
    createdAt: row.created_at,
  }
}

function toKey(row: Row): unknown {
  return {
    id: row.id,
    pairingId: row.pairing_id,
    ...optional('hash', row.hash),
    ...optional('label', row.label),
    ...optional('externalId', row.external_id),
    createdAt: row.created_at,
  }
}

function toSeed(row: Row): unknown {
  return {
    fingerprint: row.fingerprint,
    botId: row.bot_id,
    pairingId: row.pairing_id,
    keyId: row.key_id,
    // Anything but 0 or 1 stays as is, so the schema rejects it.
    isOpen: row.is_open === 1 ? true : row.is_open === 0 ? false : row.is_open,
  }
}

function toBotParameters(bot: BotRecord): Record<string, SQLInputValue> {
  return {
    id: bot.id,
    provider: bot.provider,
    settings: JSON.stringify(bot.settings),
    label: bot.label ?? null,
    createdAt: bot.createdAt,
  }
}

function toPairingParameters(pairing: PairingRecord): Record<string, SQLInputValue> {
  return {
    id: pairing.id,
    botId: pairing.botId,
    person: pairing.person ?? null,
    code: pairing.code ?? null,
    quietHours: pairing.quietHours ?? null,
    mutedUntil: pairing.mutedUntil ?? null,
    createdAt: pairing.createdAt,
  }
}

function toKeyParameters(key: KeyRecord): Record<string, SQLInputValue> {
  return {
    id: key.id,
    pairingId: key.pairingId,
    hash: key.hash ?? null,
    label: key.label ?? null,
    externalId: key.externalId ?? null,
    createdAt: key.createdAt,
  }
}

/** Records in `next` that are new or differ from `previous`'s record with the same id. */
function listChanged<T extends Identified>(previous: readonly T[], next: readonly T[]): T[] {
  const previousById = new Map(previous.map((record) => [record.id, record]))
  return next.filter((record) => !isDeepStrictEqual(previousById.get(record.id), record))
}

/** Ids in `previous` that `next` no longer has. */
function listRemovedIds(previous: readonly Identified[], next: readonly Identified[]): string[] {
  const nextIds = new Set(next.map((record) => record.id))
  return previous.map((record) => record.id).filter((id) => !nextIds.has(id))
}

function deleteRows(
  database: DatabaseSync,
  table: (typeof TABLE_NAMES)[number] | 'requests' | 'notifications',
  column: 'id' | 'bot_id',
  ids: readonly string[],
): void {
  const statement = database.prepare(`DELETE FROM ${table} WHERE ${column} = :id`)
  for (const id of ids) {
    statement.run({ id })
  }
}

function upsertRows<T>(
  database: DatabaseSync,
  sql: string,
  records: readonly T[],
  toParameters: (record: T) => Record<string, SQLInputValue>,
): void {
  const statement = database.prepare(sql)
  for (const record of records) {
    statement.run(toParameters(record))
  }
}

/**
 * Removed keys go first, freeing their hashes; pairings and bots go last, after moved keys point
 * elsewhere, so their cascades only reach rows the registry dropped too.
 */
function writeDifference(database: DatabaseSync, previous: Registry, next: Registry): void {
  const removedBotIds = listRemovedIds(previous.bots, next.bots)
  deleteRows(database, 'keys', 'id', listRemovedIds(previous.keys, next.keys))
  upsertRows(database, UPSERT_BOT_SQL, listChanged(previous.bots, next.bots), toBotParameters)
  upsertRows(
    database,
    UPSERT_PAIRING_SQL,
    listChanged(previous.pairings, next.pairings),
    toPairingParameters,
  )
  upsertRows(database, UPSERT_KEY_SQL, listChanged(previous.keys, next.keys), toKeyParameters)
  deleteRows(database, 'pairings', 'id', listRemovedIds(previous.pairings, next.pairings))
  deleteRows(database, 'bots', 'id', removedBotIds)
  deleteRows(database, 'requests', 'bot_id', removedBotIds)
  deleteRows(database, 'notifications', 'bot_id', removedBotIds)
  const changedCounters = COUNTER_NAMES.filter(
    (name) => previous.lastIds[name] !== next.lastIds[name],
  )
  upsertRows(database, UPSERT_COUNTER_SQL, changedCounters, (name) => ({
    name,
    value: next.lastIds[name],
  }))
  writeSeed(database, previous.seed, next.seed)
}

function writeSeed(
  database: DatabaseSync,
  previous: SeedRecord | undefined,
  next: SeedRecord | undefined,
): void {
  if (isDeepStrictEqual(previous, next)) {
    return
  }
  if (next === undefined) {
    database.prepare('DELETE FROM seed').run()
    return
  }
  database.prepare(UPSERT_SEED_SQL).run({
    fingerprint: next.fingerprint,
    botId: next.botId,
    pairingId: next.pairingId,
    keyId: next.keyId,
    isOpen: next.isOpen ? 1 : 0,
  })
}

/** Atomically writes `key` plus a newline, readable by the owner only. */
export function writeAdminKeyFile(path: string, key: string): void {
  writeTokenFile(path, key)
}

/**
 * Reads the admin key file; writes a new key when it's missing or invalid and logs that (never the
 * key). Returns the key. Read errors other than a missing file and write errors are thrown.
 */
export function ensureAdminKey(path: string, log: (line: string) => void): string {
  const raw = readTokenFile(path)
  const existing = raw === undefined ? undefined : parseToken(raw)
  if (existing !== undefined) {
    return existing
  }
  const key = generateAdminKey()
  writeAdminKeyFile(path, key)
  log(
    raw === undefined
      ? `wrote a new admin key to ${JSON.stringify(path)}`
      : `admin key file ${JSON.stringify(path)} wasn't a valid admin key; wrote a new one`,
  )
  return key
}

/**
 * Client side: JAYPOST_ADMIN_KEY (empty counts as unset), then the file, else none; same shape and
 * messages as resolveClientToken, never quoting the value. Never throws.
 */
export function resolveAdminKey(env: NodeJS.ProcessEnv, path: string): ClientToken {
  return resolveClientSecret(env, path, {
    envVar: ADMIN_KEY_ENV_VAR,
    fileName: 'admin key file',
    valueName: 'jaypost admin key',
  })
}
