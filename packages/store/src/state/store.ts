import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { NotificationRecord, RequestRecord } from '@jaypost/core'
import { SECRET_FILE_MODE } from '../config/index.ts'
import { isMissingFileError, writeFileAtomic } from '../system/index.ts'
import { STATE_FILE_NAME, STATE_VERSION } from './constants.ts'
import { parseState } from './parser.ts'
import type { SavedState } from './types.ts'

/** state.json lives next to the config file. */
export function resolveStatePath(configPath: string): string {
  return join(dirname(configPath), STATE_FILE_NAME)
}

/**
 * Keeps pending requests and notifications on disk so a restart can clean up their messages. A
 * state file problem is logged and never thrown; the in-memory state stays authoritative, so a
 * later write holds every record even when an earlier save failed.
 */
export class StateStore {
  readonly #path: string
  readonly #providerName: string
  readonly #log: (line: string) => void
  #state: SavedState = { requests: [], notifications: [] }
  #frozen = false

  constructor(path: string, providerName: string, log: (line: string) => void) {
    this.#path = path
    this.#providerName = providerName
    this.#log = log
  }

  /** Reads the file once and keeps the result as the in-memory state. Never writes or throws. */
  load(): SavedState {
    const loaded = this.#read()
    if (loaded !== undefined) {
      this.#state = loaded
    }
    return this.#state
  }

  addRequest(record: RequestRecord): void {
    this.#update({ ...this.#state, requests: [...this.#state.requests, record] })
  }

  removeRequest(id: string): void {
    if (!this.#state.requests.some((record) => record.id === id)) {
      return
    }
    this.#update({ ...this.#state, requests: this.#state.requests.filter((r) => r.id !== id) })
  }

  addNotification(record: NotificationRecord): void {
    this.#update({ ...this.#state, notifications: [...this.#state.notifications, record] })
  }

  removeNotification(id: string): void {
    if (!this.#state.notifications.some((record) => record.id === id)) {
      return
    }
    this.#update({
      ...this.#state,
      notifications: this.#state.notifications.filter((r) => r.id !== id),
    })
  }

  /** Ignores all later changes, so shutdown leaves the file as it is. */
  freeze(): void {
    this.#frozen = true
  }

  #read(): SavedState | undefined {
    let text: string
    try {
      text = readFileSync(this.#path, 'utf8')
    } catch (error) {
      if (!isMissingFileError(error)) {
        this.#logIgnored(error instanceof Error ? error.message : String(error))
      }
      return undefined
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      // Don't use the parser's message: it can quote part of the file.
      this.#logIgnored('invalid JSON')
      return undefined
    }
    const result = parseState(raw, this.#providerName)
    if (!result.ok) {
      this.#logIgnored(result.reason)
      return undefined
    }
    return result.state
  }

  #logIgnored(reason: string): void {
    this.#log(`ignoring state file ${JSON.stringify(this.#path)}: ${reason}`)
  }

  #update(next: SavedState): void {
    if (this.#frozen) {
      return
    }
    this.#state = next
    const file = {
      version: STATE_VERSION,
      provider: this.#providerName,
      requests: next.requests,
      notifications: next.notifications,
    }
    try {
      writeFileAtomic(this.#path, `${JSON.stringify(file, null, 2)}\n`, SECRET_FILE_MODE)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#log(`failed to save state to ${JSON.stringify(this.#path)}: ${message}`)
    }
  }
}
