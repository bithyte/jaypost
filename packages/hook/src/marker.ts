import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@jaypost/store'

/**
 * Marks `sessionId` as waiting on the phone for its next prompt and returns the marker's token.
 * A later Stop replaces the token; a typed prompt or the session's end removes the file. Either
 * tells the waiting hook its question is stale. Throws when the file can't be written.
 */
export function writeStopMarker(directory: string, sessionId: string): string {
  const token = randomUUID()
  writeFileAtomic(join(directory, sessionId), `${token}\n`, 0o600)
  return token
}

/** True while the marker for `sessionId` still holds `token`. Unreadable counts as gone. Never throws. */
export function isCurrentStopMarker(directory: string, sessionId: string, token: string): boolean {
  try {
    return readFileSync(join(directory, sessionId), 'utf8').trim() === token
  } catch {
    // Missing means the session moved on; any other read error leaves no way to tell, and a
    // cancelled question is the safe side.
    return false
  }
}

/**
 * Removes the marker for `sessionId`; with `token`, only while it still holds that token, so a
 * finished hook doesn't remove the marker of the Stop that replaced it. Never throws.
 */
export function removeStopMarker(directory: string, sessionId: string, token?: string): void {
  if (token !== undefined && !isCurrentStopMarker(directory, sessionId, token)) {
    return
  }
  try {
    rmSync(join(directory, sessionId), { force: true })
  } catch {
    // Best effort: a leftover marker is replaced by the next Stop and read by nothing else.
  }
}
