import { readFileSync } from 'node:fs'
import { SECRET_FILE_MODE } from '../config/constants.ts'
import { isMissingFileError, writeFileAtomic } from '../system/files.ts'
import { EMPTY_INBOX } from './constants.ts'
import { inboxSchema } from './schema.ts'
import type { Inbox } from './types.ts'

/**
 * Reads the inbox; a missing file is the empty inbox. Invalid JSON or shape throws a message
 * that names the file and the offending field paths, never a value. Other read errors rethrow.
 */
export function readInbox(path: string): Inbox {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) {
      return EMPTY_INBOX
    }
    throw error
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(`inbox ${JSON.stringify(path)} isn't valid: not JSON`)
  }
  const result = inboxSchema.safeParse(json)
  if (!result.success) {
    const paths = result.error.issues.map((issue) => issue.path.join('.') || '(root)')
    throw new Error(`inbox ${JSON.stringify(path)} isn't valid: ${paths.join(', ')}`)
  }
  return result.data
}

/** Atomically writes the inbox, readable by the owner only (a looser existing file is tightened). */
export function writeInbox(path: string, inbox: Inbox): void {
  writeFileAtomic(path, `${JSON.stringify(inbox, null, 2)}\n`, SECRET_FILE_MODE)
}
