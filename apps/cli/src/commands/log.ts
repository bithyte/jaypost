import {
  DEFAULT_LOG_LIMIT,
  formatAuditJsonLines,
  formatAuditTable,
  MIN_AUDIT_VERSION,
  parseAuditLog,
  readSeedAuditLog,
  resolveConfigPath,
  selectAuditEntries,
} from '@jaypost/store'
import type { AuditEntry } from '@jaypost/store'
import { Caller } from '@jaypost/client'
import type { AdminLogFilter, LogFilter } from '@jaypost/client'
import { openAdmin } from './admin-access.ts'
import { runAdminCommand } from './admin.ts'
import type { AdminLogArgs, AdminLogDeps, LocalAdminEndpoint, LogArgs, LogDeps } from './types.ts'

/** Entries to print and how many lines were skipped, or why there are none. */
type LogRead =
  | {
      readonly kind: 'read'
      readonly entries: readonly AuditEntry[]
      readonly skippedCount: number
    }
  | { readonly kind: 'failed'; readonly message: string }

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)/

/** Follows the reason `admin log` reads the files instead of asking the service. */
const FROM_FILES_NOTE = "showing the seed bot's questions from its files"

/**
 * Prints the question log of the bot's key through GET /log. Returns 0, or 1 with the message on
 * stderr when the log can't be read.
 */
export async function runLog(args: LogArgs, deps: LogDeps): Promise<number> {
  const limit = args.limit ?? (args.since === undefined ? DEFAULT_LOG_LIMIT : undefined)
  const filter: LogFilter = {
    ...(args.since === undefined ? {} : { since: args.since }),
    ...(args.project === undefined ? {} : { project: args.project }),
    ...(limit === undefined ? {} : { limit }),
  }
  const caller = new Caller({
    endpoint: deps.endpoint,
    readToken: () => deps.token,
  })
  // Nothing cancels the read but its timeout.
  const result = await caller.readLog(filter, {
    signal: new AbortController().signal,
  })
  if (result.kind === 'failed') {
    deps.printError(result.message)
    return 1
  }
  const isNarrowed = filter.since !== undefined || filter.project !== undefined
  printEntries(result.page.entries, result.page.skippedCount, isNarrowed, args, deps)
  return 0
}

/**
 * Prints the entries as a table or JSON lines, or says there are none (on stderr with `--json`, so
 * stdout stays parseable), then how many lines were unreadable.
 */
function printEntries(
  entries: readonly AuditEntry[],
  skippedCount: number,
  isNarrowed: boolean,
  args: LogArgs,
  deps: Pick<LogDeps, 'print' | 'printError'>,
): void {
  if (entries.length > 0) {
    deps.print(args.json ? formatAuditJsonLines(entries) : formatAuditTable(entries))
  } else {
    const message = isNarrowed ? 'No questions match.' : 'No questions logged.'
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
}

/**
 * Prints every bot's question log through GET /admin/log, narrowed by `--bot`, `--contact` and
 * `--key` (none, or `--all`, means every bot). When the local service doesn't answer, or its admin
 * key can't be found, reads the seed bot's log from the install's files instead and says so on
 * stderr. Returns 0, or 1 when the log can't be read or the install is too old to read.
 */
export function runAdminLog(args: AdminLogArgs, deps: AdminLogDeps): Promise<number> {
  return runAdminCommand(deps, async () => {
    const limit = args.limit ?? (args.since === undefined ? DEFAULT_LOG_LIMIT : undefined)
    const filter: AdminLogFilter = {
      ...(args.since === undefined ? {} : { since: args.since }),
      ...(args.project === undefined ? {} : { project: args.project }),
      ...(limit === undefined ? {} : { limit }),
      ...(args.bot === undefined ? {} : { bot: args.bot }),
      ...(args.contact === undefined ? {} : { contact: args.contact }),
      ...(args.key === undefined ? {} : { key: args.key }),
    }
    const read = await readAdminLog(filter, deps)
    if (read.kind === 'failed') {
      deps.printError(read.message)
      return 1
    }
    const isNarrowed =
      filter.since !== undefined ||
      filter.project !== undefined ||
      filter.bot !== undefined ||
      filter.contact !== undefined ||
      filter.key !== undefined
    printEntries(read.entries, read.skippedCount, isNarrowed, args, deps)
    return 0
  })
}

/** GET /admin/log, or the seed bot's log from the files of a local service that can't be asked. */
async function readAdminLog(filter: AdminLogFilter, deps: AdminLogDeps): Promise<LogRead> {
  const opened = await openAdmin(deps)
  switch (opened.kind) {
    case 'failed':
      return opened
    case 'noKey':
      if (opened.endpoint.kind !== 'local') {
        return { kind: 'failed', message: opened.message }
      }
      return fallBackToFiles(opened.message, opened.endpoint, filter, deps)
    case 'opened': {
      const result = await opened.caller.readLog(filter)
      if (result.kind === 'ok') {
        return { kind: 'read', ...result.value }
      }
      if (result.reason !== 'unreachable' || opened.endpoint.kind !== 'local') {
        return { kind: 'failed', message: result.message }
      }
      return fallBackToFiles("the service didn't answer", opened.endpoint, filter, deps)
    }
  }
}

/**
 * Says why the files are read (`reason`) and reads them. The files hold no bot ids, so `--bot`
 * fails instead of matching nothing.
 */
function fallBackToFiles(
  reason: string,
  endpoint: LocalAdminEndpoint,
  filter: AdminLogFilter,
  deps: AdminLogDeps,
): Promise<LogRead> {
  if (filter.bot !== undefined) {
    return Promise.resolve({
      kind: 'failed',
      message: `${reason}; --bot needs the service running, so start it or leave --bot out`,
    })
  }
  deps.printError(`${reason}; ${FROM_FILES_NOTE}`)
  return readFromFiles(endpoint, filter, deps)
}

/**
 * The seed bot's log from the install's target (or the db next to the config when nothing is
 * installed), filtered here. An install too old to have its log where this CLI reads fails.
 */
async function readFromFiles(
  endpoint: LocalAdminEndpoint,
  filter: AdminLogFilter,
  deps: AdminLogDeps,
): Promise<LogRead> {
  const { install } = endpoint
  if (install !== undefined && isTooOld(install.version, deps.version)) {
    return {
      kind: 'failed',
      message: `the installed service (${install.version}) keeps its log where this CLI can't read it; run jaypost service install to upgrade`,
    }
  }
  let raw: string
  try {
    raw =
      install === undefined
        ? readSeedAuditLog(endpoint.configPath ?? resolveConfigPath(deps.env))
        : await deps.targets[install.target].readAuditLog(install)
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
  const now = deps.now ?? (() => new Date())
  const { entries, skippedCount } = parseAuditLog(raw, now())
  return { kind: 'read', entries: selectAuditEntries(entries, filter), skippedCount }
}

/**
 * True when the install's version predates the log this CLI reads; the CLI's own version never
 * is, and neither is anything at or above `MIN_AUDIT_VERSION`, compared part by part as numbers.
 */
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

function parseVersion(version: string): readonly number[] | undefined {
  const match = VERSION_PATTERN.exec(version)
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}
