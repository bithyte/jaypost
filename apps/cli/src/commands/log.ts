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
import type { AuditEntry, ClientToken } from '@jaypost/store'
import { Caller, findEnvEndpoint } from '@jaypost/client'
import type { AdminCaller, Failure, LogFilter, ServiceEndpoint } from '@jaypost/client'
import type { LogPage } from '@jaypost/protocol'
import { findExistingInstall } from '@jaypost/install'
import { openAdmin } from './admin-access.ts'
import type { LogArgs, LogDeps } from './types.ts'

/** Entries to print and how many lines were skipped, or why there are none. */
type LogRead =
  | {
      readonly kind: 'read'
      readonly entries: readonly AuditEntry[]
      readonly skippedCount: number
      /** No entries at all before filtering, so the message says nothing was logged. */
      readonly isLogEmpty: boolean
    }
  | { readonly kind: 'failed'; readonly message: string }

/** Where an API read goes: the admin routes, or GET /log with the client token and why. */
type LogSource =
  | { readonly kind: 'admin'; readonly caller: AdminCaller }
  | { readonly kind: 'client'; readonly endpoint: ServiceEndpoint; readonly reason: string }
  | { readonly kind: 'failed'; readonly message: string }

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
      return readSeedAuditLog(resolveConfigPath(deps.env))
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

/** The seed bot's log from the install's target (or the db next to the config), filtered here. */
async function readFromDatabase(filter: LogFilter, deps: LogDeps): Promise<LogRead> {
  const raw = await readRaw(deps)
  if (typeof raw !== 'string') {
    return { kind: 'failed', message: raw.message }
  }
  const { entries, skippedCount } = parseAuditLog(raw, deps.now())
  return {
    kind: 'read',
    entries: selectAuditEntries(entries, filter),
    skippedCount,
    isLogEmpty: entries.length === 0,
  }
}

/** True when `log` reads through the API: an admin-only flag, or `JAYPOST_URL` set. */
function isApiRead(args: LogArgs, env: NodeJS.ProcessEnv): boolean {
  return hasAdminFlag(args) || findEnvEndpoint(env) !== undefined
}

function hasAdminFlag(args: LogArgs): boolean {
  return (
    args.bot !== undefined ||
    args.pairing !== undefined ||
    args.key !== undefined ||
    args.all === true
  )
}

/**
 * The admin routes when an admin key resolves (`JAYPOST_URL` with `JAYPOST_ADMIN_KEY`, or the local
 * service's key), else GET /log on the same service. Never throws.
 */
async function resolveLogSource(deps: LogDeps): Promise<LogSource> {
  const opened = await openAdmin(deps)
  switch (opened.kind) {
    case 'failed':
      return opened
    case 'noKey':
      return { kind: 'client', endpoint: opened.endpoint.endpoint, reason: opened.message }
    case 'opened':
      return { kind: 'admin', caller: opened.caller }
  }
}

/**
 * Every bot's log through GET /admin/log, narrowed by the flags, or this client's key's log through
 * GET /log when no admin key resolves (saying so when admin-only flags were given).
 */
async function readFromApi(args: LogArgs, filter: LogFilter, deps: LogDeps): Promise<LogRead> {
  const source = await resolveLogSource(deps)
  const isNarrowed =
    filter.since !== undefined ||
    filter.project !== undefined ||
    args.bot !== undefined ||
    args.pairing !== undefined ||
    args.key !== undefined
  switch (source.kind) {
    case 'failed':
      return source
    case 'admin': {
      const result = await source.caller.readLog({
        ...filter,
        ...(args.bot === undefined ? {} : { bot: args.bot }),
        ...(args.pairing === undefined ? {} : { pairing: args.pairing }),
        ...(args.key === undefined ? {} : { key: args.key }),
      })
      if (result.kind === 'failed') {
        return { kind: 'failed', message: result.message }
      }
      return { kind: 'read', ...result.value, isLogEmpty: !isNarrowed }
    }
    case 'client': {
      if (hasAdminFlag(args)) {
        deps.printError(
          `${source.reason}; showing only this client's questions, without --bot, --pairing, --key or --all`,
        )
      }
      const result = await readClientLog(source.endpoint, deps.token, filter)
      if (result.kind === 'failed') {
        return { kind: 'failed', message: result.message }
      }
      return {
        kind: 'read',
        ...result.page,
        isLogEmpty: filter.since === undefined && filter.project === undefined,
      }
    }
  }
}

function readClientLog(
  endpoint: ServiceEndpoint,
  token: ClientToken,
  filter: LogFilter,
): Promise<{ readonly kind: 'log'; readonly page: LogPage } | Failure> {
  const caller = new Caller({ endpoint, readToken: () => token })
  // Nothing cancels the read but its timeout.
  return caller.readLog(filter, { signal: new AbortController().signal })
}

/**
 * Prints the question log: from the install's target (or the db next to the config when nothing
 * is installed), or through the API with `--bot`, `--pairing`, `--key`, `--all` or `JAYPOST_URL`.
 * Returns 0, or 1 when the log can't be read or the install is too old.
 */
export async function runLog(args: LogArgs, deps: LogDeps): Promise<number> {
  const limit = args.limit ?? (args.since === undefined ? DEFAULT_LOG_LIMIT : undefined)
  const filter: LogFilter = {
    ...(args.since === undefined ? {} : { since: args.since }),
    ...(args.project === undefined ? {} : { project: args.project }),
    ...(limit === undefined ? {} : { limit }),
  }
  const read = isApiRead(args, deps.env)
    ? await readFromApi(args, filter, deps)
    : await readFromDatabase(filter, deps)
  if (read.kind === 'failed') {
    deps.printError(read.message)
    return 1
  }
  const { entries, skippedCount } = read
  if (entries.length > 0) {
    deps.print(args.json ? formatAuditJsonLines(entries) : formatAuditTable(entries))
  } else {
    // With --json stdout stays parseable, so the message goes to stderr.
    const message = read.isLogEmpty ? 'No questions logged.' : 'No questions match.'
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
