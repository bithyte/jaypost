import { readSeedAuditLog, resolveConfigPath } from '@jaypost/store'
import { writeAll } from './stdout.ts'

/**
 * Hidden helper; runs inside containers so the CLI can read the seed bot's question log in the
 * data volume's db. Returns 0, 1 when it can't be read (a corrupt db is named, never quoted), 2 on bad
 * usage.
 */
export function runAudit(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  write: (text: string) => void = writeAll,
): number {
  if (args[0] !== 'dump') {
    console.error('Usage: audit dump')
    return 2
  }
  try {
    write(readSeedAuditLog(resolveConfigPath(env)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
  return 0
}
