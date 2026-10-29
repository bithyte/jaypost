import { readFileSync } from 'node:fs'
import { SECRET_FILE_MODE } from '../config/constants.ts'
import { isMissingFileError, writeFileAtomic } from '../system/files.ts'
import { EMPTY_BOOK } from './constants.ts'
import { bookSchema } from './schema.ts'
import type { Book } from './types.ts'

/**
 * Reads the contact book; a missing file is the empty book. Invalid JSON or shape throws a message
 * that names the file and the offending field paths, never a value. Other read errors rethrow.
 */
export function readBook(path: string): Book {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) {
      return EMPTY_BOOK
    }
    throw error
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(`contact book ${JSON.stringify(path)} isn't valid: not JSON`)
  }
  const result = bookSchema.safeParse(json)
  if (!result.success) {
    const paths = result.error.issues.map((issue) => issue.path.join('.') || '(root)')
    throw new Error(`contact book ${JSON.stringify(path)} isn't valid: ${paths.join(', ')}`)
  }
  return result.data
}

/** Atomically writes the book, readable by the owner only (a looser existing file is tightened). */
export function writeBook(path: string, book: Book): void {
  writeFileAtomic(path, `${JSON.stringify(book, null, 2)}\n`, SECRET_FILE_MODE)
}
