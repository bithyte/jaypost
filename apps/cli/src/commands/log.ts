import {
  DEFAULT_LOG_LIMIT,
  formatAuditJsonLines,
  formatAuditTable,
  MIN_AUDIT_VERSION,
  parseAuditLog,
  readAuditFiles,
  resolveAuditPath,
  resolveConfigPath,
  selectAuditEntries,
} from '@jaypost/store'
import { findExistingInstall } from '@jaypost/install'
import type { LogArgs, LogDeps } from './types.ts'

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)/

function parseVersion(version: string): readonly number[] | undefined {
  const match = VERSION_PATTERN.exec(version)
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

function isTooOld(version: string, runningVersion: string): boolean {
  if (version === 'legacy') {
    return true
  }
  if (version === runningVersion) {
    return false
  }
  const actual = parseVersion(version)
  const minimum = parseVersion(MIN_AUDIT_VERSION)
  if (actual === undefined || minimum === undefined) {
    return true
  }
  for (const [index, part] of minimum.entries()) {
    const actualPart = actual[index] ?? 0
    if (actualPart !== part) {
      return actualPart < part
    }
  }
  return false
}

async function readRaw(deps: LogDeps): Promise<string | { readonly message: string }> {
  try {
    const existing = findExistingInstall(deps.paths, deps.targets, deps.env)
    if (existing === undefined) {
      return readAuditFiles(resolveAuditPath(resolveConfigPath(deps.env)))
    }
    const { record } = existing
    if (isTooOld(record.version, deps.version)) {
      return {
        message: `the installed service (${record.version}) doesn't keep a log; run jaypost init to upgrade`,
      }
    }
    return await deps.targets[record.target].readAuditLog(record)
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Prints the question log from the install's target (or the files next to the config when
 * nothing is installed). Returns 0, or 1 when the log can't be read or the install is too old.
 */
export async function runLog(args: LogArgs, deps: LogDeps): Promise<number> {
  const raw = await readRaw(deps)
  if (typeof raw !== 'string') {
    deps.printError(raw.message)
    return 1
  }
  const { entries, skippedCount } = parseAuditLog(raw, deps.now())
  const limit = args.limit ?? (args.since === undefined ? DEFAULT_LOG_LIMIT : undefined)
  const selected = selectAuditEntries(entries, {
    ...(args.since === undefined ? {} : { since: args.since }),
    ...(args.project === undefined ? {} : { project: args.project }),
    ...(limit === undefined ? {} : { limit }),
  })
  if (selected.length > 0) {
    deps.print(args.json ? formatAuditJsonLines(selected) : formatAuditTable(selected))
  } else {
    // With --json stdout stays parseable, so the message goes to stderr.
    const message = entries.length === 0 ? 'No questions logged.' : 'No questions match.'
    if (args.json) {
      deps.printError(message)
    } else {
      deps.print(message)
    }
  }
  if (skippedCount > 0) {
    deps.printError(
      `skipped ${skippedCount} unreadable log ${skippedCount === 1 ? 'line' : 'lines'}`,
    )
  }
  return 0
}
