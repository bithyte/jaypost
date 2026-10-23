import { writeSync } from 'node:fs'

const STDOUT_FD = 1
const RETRY_DELAY_MS = 5

/**
 * Writes the whole text to stdout synchronously, so output to a pipe isn't cut when the process
 * exits right after. A single writeSync can be short on a pipe, and a non-blocking pipe can throw
 * EAGAIN when full.
 */
export function writeAll(text: string): void {
  const buffer = Buffer.from(text, 'utf8')
  let offset = 0
  while (offset < buffer.length) {
    try {
      offset += writeSync(STDOUT_FD, buffer, offset, buffer.length - offset)
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'EAGAIN') {
        throw error
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_DELAY_MS)
    }
  }
}
