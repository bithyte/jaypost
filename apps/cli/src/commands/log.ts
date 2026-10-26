import {
  ADMIN_KEY_ENV_VAR,
  DEFAULT_LOG_LIMIT,
  findEnvValue,
  formatAuditJsonLines,
  formatAuditTable,
  MIN_AUDIT_VERSION,
  parseAuditLog,
  readAuditFiles,
  resolveConfigPath,
  resolveSeedAuditPath,
  selectAuditEntries,
} from '@jaypost/store'
import type { AuditEntry, ClientToken } from '@jaypost/store'
import { AdminCaller, Caller, findEnvEndpoint } from '@jaypost/client'
import type { Failure, LogFilter, ServiceEndpoint } from '@jaypost/client'
import type { LogPage } from '@jaypost/protocol'
import { findExistingInstall } from '@jaypost/install'
import { resolveAdminEndpoint } from './admin-endpoint.ts'
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
      return readAuditFiles(resolveSeedAuditPath(resolveConfigPath(deps.env)))
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

/** The seed bot's log from the install's files (or the ones next to the config), filtered here. */
async function readFromFiles(filter: LogFilter, deps: LogDeps): Promise<LogRead> {
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
  const remote = findEnvEndpoint(deps.env)
  if (remote?.kind === 'invalid') {
    return { kind: 'failed', message: remote.message }
  }
  if (remote !== undefined && findEnvValue(deps.env, ADMIN_KEY_ENV_VAR) === undefined) {
    return { kind: 'client', endpoint: remote, reason: `${ADMIN_KEY_ENV_VAR} isn't set` }
  }
  const endpoint = await resolveAdminEndpoint(deps.env, deps.paths, deps.targets)
  switch (endpoint.kind) {
    case 'failed':
      return endpoint
    case 'remote':
      return {
        kind: 'admin',
        caller: new AdminCaller({ endpoint: endpoint.endpoint, adminKey: endpoint.adminKey }),
      }
    case 'local':
      if (endpoint.adminKey.kind === 'missing') {
        return { kind: 'client', endpoint: endpoint.endpoint, reason: endpoint.adminKey.message }
      }
      return {
        kind: 'admin',
        caller: new AdminCaller({
          endpoint: endpoint.endpoint,
          adminKey: endpoint.adminKey.adminKey,
        }),
      }
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
 * Prints the question log: from the install's target (or the files next to the config when nothing
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
    : await readFromFiles(filter, deps)
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
