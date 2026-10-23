import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AuditSink, MessageEnding, SentRequest } from '@jaypost/core'
import { SECRET_FILE_MODE } from '../config/index.ts'
import { isMissingFileError } from '../system/index.ts'
import {
  AUDIT_FILE_NAME,
  AUDIT_FORMAT_VERSION,
  MAX_AUDIT_LOG_BYTES,
  ROTATED_SUFFIX,
} from './constants.ts'
import type { AskedRecord, AuditLogOptions, SettledRecord } from './types.ts'

/** audit.jsonl lives next to the config file. */
export function resolveAuditPath(configPath: string): string {
  return join(dirname(configPath), AUDIT_FILE_NAME)
}

/**
 * Appends one JSON line per event to `path`, rotating to `${path}.1` before a line would pass
 * `maxBytes`. Never throws: a failed write is reported through `log` and the next append retries.
 */
export class AuditLog implements AuditSink {
  readonly #path: string
  readonly #rotatedPath: string
  readonly #maxBytes: number
  readonly #log: (line: string) => void
  #sizeBytes: number | undefined

  constructor(path: string, options: AuditLogOptions = {}) {
    this.#path = path
    this.#rotatedPath = `${path}${ROTATED_SUFFIX}`
    this.#maxBytes = options.maxBytes ?? MAX_AUDIT_LOG_BYTES
    this.#log = options.log ?? console.error
  }

  public asked(id: string, request: SentRequest, at: Date): void {
    this.#append(() => {
      const record: AskedRecord = {
        v: AUDIT_FORMAT_VERSION,
        event: 'asked',
        id,
        at: at.toISOString(),
        ...(request.project === undefined ? {} : { project: request.project }),
        text: request.question,
        options: request.options,
        timeoutOption: request.timeoutOption,
        timeoutSeconds: request.timeoutSeconds,
      }
      return `${JSON.stringify(record)}\n`
    })
  }

  public settled(id: string, ending: MessageEnding, at: Date): void {
    this.#append(() => {
      const record: SettledRecord = {
        v: AUDIT_FORMAT_VERSION,
        event: 'settled',
        id,
        at: at.toISOString(),
        outcome: ending.kind,
        ...('answer' in ending ? { answer: ending.answer } : {}),
      }
      return `${JSON.stringify(record)}\n`
    })
  }

  #append(toLine: () => string): void {
    try {
      const line = toLine()
      const lineBytes = Buffer.byteLength(line)
      mkdirSync(dirname(this.#path), { recursive: true })
      let sizeBytes = this.#sizeBytes ?? this.#readSizeBytes()
      if (sizeBytes > 0 && sizeBytes + lineBytes > this.#maxBytes) {
        this.#rotate()
        sizeBytes = 0
      }
      appendFileSync(this.#path, line, { mode: SECRET_FILE_MODE })
      this.#sizeBytes = sizeBytes + lineBytes
    } catch (error) {
      this.#sizeBytes = undefined
      const message = error instanceof Error ? error.message : String(error)
      this.#log(`failed to write audit log ${this.#path}: ${message}`)
    }
  }

  #readSizeBytes(): number {
    try {
      return statSync(this.#path).size
    } catch (error) {
      if (isMissingFileError(error)) {
        return 0
      }
      throw error
    }
  }

  #rotate(): void {
    try {
      renameSync(this.#path, this.#rotatedPath)
    } catch (error) {
      // The file was deleted by hand since the size was read; nothing to rotate.
      if (!isMissingFileError(error)) {
        throw error
      }
    }
  }
}

/**
 * The rotated log followed by the current one, `''` when neither exists. A rotated file that
 * lacks a final newline gets one so its last line doesn't merge with the next file's first.
 */
export function readAuditFiles(path: string): string {
  const rotated = readIfPresent(`${path}${ROTATED_SUFFIX}`)
  const current = readIfPresent(path)
  const separator = rotated === '' || rotated.endsWith('\n') ? '' : '\n'
  return `${rotated}${separator}${current}`
}

/** Deletes the current and rotated logs; missing files are fine. */
export function removeAuditFiles(path: string): void {
  rmSync(path, { force: true })
  rmSync(`${path}${ROTATED_SUFFIX}`, { force: true })
}

function readIfPresent(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) {
      return ''
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`couldn't read the log ${JSON.stringify(file)}: ${message}`, { cause: error })
  }
}
