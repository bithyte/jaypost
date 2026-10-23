import { readAuditFiles, resolveAuditPath, resolveConfigPath } from '@jaypost/store'
import { writeAll } from './stdout.ts'

/** Hidden helper; runs inside containers so the CLI can read the audit log in the data volume. */
export function runAudit(args: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
  if (args[0] !== 'dump') {
    console.error('Usage: audit dump')
    return 2
  }
  try {
    writeAll(readAuditFiles(resolveAuditPath(resolveConfigPath(env))))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
  return 0
}
