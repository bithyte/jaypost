import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

/**
 * Writes `contents` to `path` via a temp file, fsync and rename, so readers never see a partial
 * file. Creates the parent directory. A symlinked `path` is written through: the link is kept and
 * its target replaced. On failure removes the temp file (best effort) and rethrows; an existing
 * file is left as it was.
 */
export function writeFileAtomic(path: string, contents: string, mode: number): void {
  const target = resolveWriteTarget(path)
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  try {
    const fd = openSync(temp, 'w', mode)
    try {
      // The umask can strip bits when the file is created.
      fchmodSync(fd, mode)
      writeFileSync(fd, contents)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, target)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // Best effort: the original error is the one worth reporting.
    }
    throw error
  }
}

function resolveWriteTarget(path: string): string {
  try {
    return realpathSync(path)
  } catch (error) {
    if (isMissingFileError(error)) {
      return path
    }
    throw error
  }
}

/** True when `error` is a Node error with code `ENOENT`. */
export function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
