import { basename } from 'node:path'
import { MAX_PROJECT_LENGTH } from '@jaypost/core'
import { DEFAULT_PROJECT } from './constants.ts'

/**
 * Project name for hook messages: flag, then basename of `CLAUDE_PROJECT_DIR`, then basename of
 * `cwd`, then `claude`. Blank or root (`/`) sources are skipped. Never throws.
 */
export function resolveHookProject(
  flagProject: string | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
): string {
  const candidates = [
    flagProject?.trim(),
    env.CLAUDE_PROJECT_DIR === undefined ? undefined : basename(env.CLAUDE_PROJECT_DIR.trim()),
    cwd === undefined ? undefined : basename(cwd.trim()),
  ]
  const found = candidates.find((candidate) => candidate !== undefined && candidate !== '')
  return (found ?? DEFAULT_PROJECT).slice(0, MAX_PROJECT_LENGTH)
}
