import { parseSince } from '@jaypost/store'
import { LOG_LIMIT_PATTERN } from './constants.ts'
import type { AdminLogQuery, LogQuery, Parsed } from './types.ts'

/** A query parameter given at most once, as a string; `undefined` when absent. */
function parseOnce(
  query: Readonly<Record<string, unknown>>,
  name: string,
): Parsed<string | undefined> {
  const value = query[name]
  if (value !== undefined && typeof value !== 'string') {
    return { ok: false, error: `${name} must be given once` }
  }
  return { ok: true, value }
}

/**
 * The named id filters of a query (`bot`, `pairing`, `key`), each given at most once; unknown
 * fields are ignored. Never throws.
 */
export function parseIdFilters<Name extends string>(
  query: Readonly<Record<string, unknown>>,
  names: readonly Name[],
): Parsed<{ readonly [Key in Name]?: string }> {
  const value: { [Key in Name]?: string } = {}
  for (const name of names) {
    const parsed = parseOnce(query, name)
    if (!parsed.ok) {
      return parsed
    }
    if (parsed.value !== undefined) {
      value[name] = parsed.value
    }
  }
  return { ok: true, value }
}

/** A GET /log query; unknown fields are ignored. Never throws. */
export function parseLogQuery(
  query: Readonly<Record<string, unknown>>,
  now: Date,
): Parsed<LogQuery> {
  const { since: rawSince, project, limit: rawLimit } = query
  if (rawSince !== undefined && typeof rawSince !== 'string') {
    return { ok: false, error: 'since must be given once' }
  }
  const since = rawSince === undefined ? undefined : parseSince(rawSince, now)
  if (rawSince !== undefined && since === undefined) {
    return {
      ok: false,
      error: 'since must be a duration like 30m, 12h or 7d, a date or an ISO date-time',
    }
  }
  if (project !== undefined && typeof project !== 'string') {
    return { ok: false, error: 'project must be given once' }
  }
  if (
    rawLimit !== undefined &&
    (typeof rawLimit !== 'string' || !LOG_LIMIT_PATTERN.test(rawLimit))
  ) {
    return { ok: false, error: 'limit must be a positive integer' }
  }
  return {
    ok: true,
    value: {
      ...(since === undefined ? {} : { since }),
      ...(project === undefined ? {} : { project }),
      ...(rawLimit === undefined ? {} : { limit: Number(rawLimit) }),
    },
  }
}

/** A GET /admin/log query: GET /log's fields plus `bot`, `pairing` and `key`. Never throws. */
export function parseAdminLogQuery(
  query: Readonly<Record<string, unknown>>,
  now: Date,
): Parsed<AdminLogQuery> {
  const filters = parseIdFilters(query, ['bot', 'pairing', 'key'])
  if (!filters.ok) {
    return filters
  }
  const log = parseLogQuery(query, now)
  return log.ok ? { ok: true, value: { ...log.value, ...filters.value } } : log
}
