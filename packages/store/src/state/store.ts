import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { NotificationRecord, RequestRecord } from '@jaypost/core'
import type { z } from 'zod'
import { DELETE_OTHER_PROVIDER_SQL, DELETE_ROW_SQL, REPLACE_SQL, SELECT_SQL } from './constants.ts'
import { notificationRecordSchema, requestRecordSchema } from './schema.ts'
import type { SavedState } from './types.ts'

type Table = 'requests' | 'notifications'

type Row = Record<string, SQLOutputValue>

type Loaded<T> = {
  readonly records: readonly T[]
  readonly foreignProviders: readonly string[]
}

/**
 * Keeps one bot's pending requests and notifications in the db so a restart can clean up their
 * messages. Each change touches only its own row. A db problem is logged and never thrown; the
 * in-memory state stays authoritative, so a later write holds every record even when an earlier
 * save failed. Logs never quote a record.
 */
export class StateStore {
  readonly #database: DatabaseSync
  readonly #botId: string
  readonly #providerName: string
  readonly #log: (line: string) => void
  #state: SavedState = { requests: [], notifications: [] }
  #frozen = false

  constructor(
    database: DatabaseSync,
    botId: string,
    providerName: string,
    log: (line: string) => void,
  ) {
    this.#database = database
    this.#botId = botId
    this.#providerName = providerName
    this.#log = log
  }

  /**
   * Reads this bot's rows once and keeps the result as the in-memory state. Rows saved for another
   * provider or failing validation are deleted and logged. Never throws.
   */
  load(): SavedState {
    try {
      this.#state = this.#read()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#log(`failed to read saved state: ${message}`)
    }
    return this.#state
  }

  addRequest(record: RequestRecord): void {
    this.#apply(
      {
        ...this.#state,
        requests: [...this.#state.requests.filter((other) => other.id !== record.id), record],
      },
      () => this.#replace('requests', record.id, record),
    )
  }

  removeRequest(id: string): void {
    if (!this.#state.requests.some((record) => record.id === id)) {
      return
    }
    this.#apply({ ...this.#state, requests: this.#state.requests.filter((r) => r.id !== id) }, () =>
      this.#delete('requests', id),
    )
  }

  addNotification(record: NotificationRecord): void {
    this.#apply(
      {
        ...this.#state,
        notifications: [
          ...this.#state.notifications.filter((other) => other.id !== record.id),
          record,
        ],
      },
      () => this.#replace('notifications', record.id, record),
    )
  }

  removeNotification(id: string): void {
    if (!this.#state.notifications.some((record) => record.id === id)) {
      return
    }
    this.#apply(
      { ...this.#state, notifications: this.#state.notifications.filter((r) => r.id !== id) },
      () => this.#delete('notifications', id),
    )
  }

  /** Ignores all later changes, so shutdown leaves the rows as they are. */
  freeze(): void {
    this.#frozen = true
  }

  #read(): SavedState {
    const requests = this.#readTable('requests', requestRecordSchema)
    const notifications = this.#readTable('notifications', notificationRecordSchema)
    const foreign = new Set([...requests.foreignProviders, ...notifications.foreignProviders])
    for (const provider of foreign) {
      this.#log(`ignoring saved state for provider ${JSON.stringify(provider)}`)
    }
    return {
      requests: requests.records as readonly RequestRecord[],
      notifications: notifications.records as readonly NotificationRecord[],
    }
  }

  #readTable<T>(table: Table, schema: z.ZodType<T>): Loaded<T> {
    const rows: Row[] = this.#database.prepare(SELECT_SQL[table]).all(this.#botId)
    const records: T[] = []
    const foreignProviders: string[] = []
    const invalidIds: string[] = []
    for (const row of rows) {
      const provider = String(row.provider)
      if (provider !== this.#providerName) {
        if (!foreignProviders.includes(provider)) {
          foreignProviders.push(provider)
        }
        continue
      }
      const record = this.#parseRecord(row.record, schema)
      if (record === undefined) {
        invalidIds.push(String(row.id))
        continue
      }
      records.push(record)
    }
    if (foreignProviders.length > 0) {
      this.#database.prepare(DELETE_OTHER_PROVIDER_SQL[table]).run(this.#botId, this.#providerName)
    }
    for (const id of invalidIds) {
      this.#log(
        `ignoring a saved ${table === 'requests' ? 'request' : 'notification'}: invalid or missing fields`,
      )
      this.#delete(table, id)
    }
    return { records, foreignProviders }
  }

  // Neither JSON.parse's nor zod's messages are used: both can quote the record.
  #parseRecord<T>(text: SQLOutputValue, schema: z.ZodType<T>): T | undefined {
    if (typeof text !== 'string') {
      return undefined
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return undefined
    }
    const result = schema.safeParse(raw)
    return result.success ? result.data : undefined
  }

  #replace(table: Table, id: string, record: RequestRecord | NotificationRecord): void {
    this.#database
      .prepare(REPLACE_SQL[table])
      .run(this.#botId, id, this.#providerName, JSON.stringify(record))
  }

  #delete(table: Table, id: string): void {
    this.#database.prepare(DELETE_ROW_SQL[table]).run(this.#botId, id)
  }

  #apply(next: SavedState, change: () => void): void {
    if (this.#frozen) {
      return
    }
    this.#state = next
    try {
      change()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#log(`failed to save state: ${message}`)
    }
  }
}
