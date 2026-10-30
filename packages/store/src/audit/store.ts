import { existsSync } from 'node:fs'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { AuditSink, MessageEnding, RequestCaller, SentRequest } from '@jaypost/core'
import { openDatabase, resolveDatabasePath } from '../database/index.ts'
import { RegistryStore } from '../registry/store.ts'
import { AUDIT_FORMAT_VERSION } from './constants.ts'
import type {
  AskedRecord,
  AuditEntry,
  AuditLogOptions,
  BotAuditEntry,
  SettledRecord,
} from './types.ts'

type Row = Record<string, SQLOutputValue>

const INSERT_ASKED_SQL = `
INSERT OR IGNORE INTO questions
  (bot_id, id, asked_at, project, text, options, timeout_option, timeout_seconds, key_id, contact_id)
VALUES
  (:botId, :id, :askedAt, :project, :text, :options, :timeoutOption, :timeoutSeconds, :keyId, :contactId)
`

const SETTLE_SQL = `
UPDATE questions SET outcome = :outcome, answer = :answer, settled_at = :settledAt
WHERE bot_id = :botId AND id = :id AND outcome IS NULL
`

const SELECT_ALL_SQL = 'SELECT * FROM questions ORDER BY asked_at, rowid'

const SELECT_BOT_SQL = 'SELECT * FROM questions WHERE bot_id = ? ORDER BY asked_at, rowid'

const PRUNE_SQL = 'DELETE FROM questions WHERE asked_at < ?'

/**
 * Keeps one bot's questions in the db: a row when asked, filled in when settled (the first
 * settlement wins; one with no asked row changes nothing). Never throws: a failed write is
 * reported through `log` and the next one retries.
 */
export class AuditLog implements AuditSink {
  readonly #database: DatabaseSync
  readonly #botId: string
  readonly #log: (line: string) => void

  constructor(database: DatabaseSync, botId: string, options: AuditLogOptions = {}) {
    this.#database = database
    this.#botId = botId
    this.#log = options.log ?? console.error
  }

  public asked(id: string, request: SentRequest, at: Date): void {
    this.#write(() => {
      this.#database.prepare(INSERT_ASKED_SQL).run({
        botId: this.#botId,
        id,
        askedAt: at.toISOString(),
        project: request.project ?? null,
        text: request.question,
        options: JSON.stringify(request.options),
        timeoutOption: request.timeoutOption,
        timeoutSeconds: request.timeoutSeconds,
        keyId: request.caller?.key ?? null,
        contactId: request.caller?.pairing ?? null,
      })
    })
  }

  public settled(
    id: string,
    ending: MessageEnding,
    at: Date,
    _caller: RequestCaller | undefined,
  ): void {
    this.#write(() => {
      this.#database.prepare(SETTLE_SQL).run({
        botId: this.#botId,
        id,
        outcome: ending.kind,
        answer: 'answer' in ending ? ending.answer : null,
        settledAt: at.toISOString(),
      })
    })
  }

  #write(run: () => void): void {
    try {
      run()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#log(`failed to write audit log: ${message}`)
    }
  }
}

/**
 * Every bot's questions (or one bot's), oldest first, built like `parseAuditLog` builds entries.
 * A row whose options aren't a JSON string array is counted in `skippedCount`. Removed bots'
 * rows are included. Throws on a db error.
 */
export function readAuditEntries(
  database: DatabaseSync,
  now: Date,
  botId?: string,
): {
  readonly entries: readonly BotAuditEntry[]
  readonly skippedCount: number
} {
  const rows =
    botId === undefined
      ? database.prepare(SELECT_ALL_SQL).all()
      : database.prepare(SELECT_BOT_SQL).all(botId)
  const entries: BotAuditEntry[] = []
  let skippedCount = 0
  for (const row of rows) {
    const options = parseOptions(row.options)
    if (options === undefined) {
      skippedCount += 1
      continue
    }
    entries.push({ botId: String(row.bot_id), entry: toEntry(row, options, now) })
  }
  return { entries, skippedCount }
}

/**
 * One bot's questions in the jsonl format: an asked line per row plus a settled line for settled
 * ones, in asked order, each ending in a newline. Rows with bad options are left out.
 */
export function formatAuditLines(database: DatabaseSync, botId: string): string {
  return database
    .prepare(SELECT_BOT_SQL)
    .all(botId)
    .flatMap((row) => {
      const options = parseOptions(row.options)
      return options === undefined ? [] : toRecords(row, options)
    })
    .map((record) => `${JSON.stringify(record)}\n`)
    .join('')
}

/**
 * The seed bot's questions as jsonl, `''` when the db doesn't exist yet (it is not created) or
 * has no seed. Throws on a corrupt db.
 */
export function readSeedAuditLog(configPath: string): string {
  const databasePath = resolveDatabasePath(configPath)
  if (!existsSync(databasePath)) {
    return ''
  }
  const database = openDatabase(databasePath)
  try {
    const seed = new RegistryStore(database).load().seed
    return seed === undefined ? '' : formatAuditLines(database, seed.botId)
  } finally {
    database.close()
  }
}

/** Deletes questions asked before `before`; returns how many. Throws on a db error. */
export function pruneAuditLog(database: DatabaseSync, before: Date): number {
  return Number(database.prepare(PRUNE_SQL).run(before.toISOString()).changes)
}

function parseOptions(raw: SQLOutputValue | undefined): readonly string[] | undefined {
  if (typeof raw !== 'string') {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A row that isn't JSON is counted as skipped by the caller.
    return undefined
  }
  return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
    ? (parsed as readonly string[])
    : undefined
}

function toEntry(row: Row, options: readonly string[], now: Date): AuditEntry {
  const askedAt = String(row.asked_at)
  const timeoutSeconds = Number(row.timeout_seconds)
  const isOverdue = now.getTime() - Date.parse(askedAt) > timeoutSeconds * 1000
  return {
    id: String(row.id),
    askedAt,
    ...(row.project === null ? {} : { project: String(row.project) }),
    text: String(row.text),
    options,
    timeoutOption: String(row.timeout_option),
    timeoutSeconds,
    status: row.outcome === null ? (isOverdue ? 'interrupted' : 'pending') : String(row.outcome),
    ...(row.answer === null ? {} : { answer: String(row.answer) }),
    ...(row.settled_at === null ? {} : { settledAt: String(row.settled_at) }),
    ...callerFields(row),
  }
}

function toRecords(row: Row, options: readonly string[]): readonly (AskedRecord | SettledRecord)[] {
  const caller = callerFields(row)
  const asked: AskedRecord = {
    v: AUDIT_FORMAT_VERSION,
    event: 'asked',
    id: String(row.id),
    at: String(row.asked_at),
    ...(row.project === null ? {} : { project: String(row.project) }),
    text: String(row.text),
    options,
    timeoutOption: String(row.timeout_option),
    timeoutSeconds: Number(row.timeout_seconds),
    ...caller,
  }
  if (row.outcome === null) {
    return [asked]
  }
  const settled: SettledRecord = {
    v: AUDIT_FORMAT_VERSION,
    event: 'settled',
    id: String(row.id),
    at: String(row.settled_at),
    outcome: String(row.outcome),
    ...(row.answer === null ? {} : { answer: String(row.answer) }),
    ...caller,
  }
  return [asked, settled]
}

function callerFields(row: Row): { readonly key?: string; readonly pairing?: string } {
  return {
    ...(row.key_id === null ? {} : { key: String(row.key_id) }),
    ...(row.contact_id === null ? {} : { pairing: String(row.contact_id) }),
  }
}
