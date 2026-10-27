import { DATE_PATTERN, DATE_TIME_PATTERN, DURATION_PATTERN } from './constants.ts'
import { auditLineSchema } from './schema.ts'
import type {
  AskedRecord,
  AuditEntry,
  AuditFilter,
  AuditReadResult,
  SettledRecord,
} from './types.ts'

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const

/**
 * Merges asked and settled lines by id into entries, oldest first. Never throws: bad lines are
 * counted in `skippedCount`; the last piece (empty, or a write in flight) is ignored.
 */
export function parseAuditLog(raw: string, now: Date): AuditReadResult {
  const askedById = new Map<string, AskedRecord>()
  const settledById = new Map<string, SettledRecord>()
  let skippedCount = 0
  for (const line of raw.split('\n').slice(0, -1)) {
    if (line.trim() === '') {
      continue
    }
    const record = parseLine(line)
    if (record === undefined) {
      skippedCount += 1
      continue
    }
    if (record.event === 'asked') {
      if (!askedById.has(record.id)) {
        askedById.set(record.id, record)
      }
    } else if (!settledById.has(record.id)) {
      settledById.set(record.id, record)
    }
  }
  const entries = [...askedById.values()].map((asked) =>
    toEntry(asked, settledById.get(asked.id), now),
  )
  return { entries, skippedCount }
}

/**
 * `since` is inclusive on `askedAt`; `project`, `key`, `pairing` and `bot` are exact matches;
 * `limit` keeps the last N.
 */
export function selectAuditEntries(
  entries: readonly AuditEntry[],
  filter: AuditFilter,
): readonly AuditEntry[] {
  const sinceMs = filter.since?.getTime()
  const matching = entries.filter(
    (entry) =>
      (sinceMs === undefined || Date.parse(entry.askedAt) >= sinceMs) &&
      (filter.project === undefined || entry.project === filter.project) &&
      (filter.key === undefined || entry.key === filter.key) &&
      (filter.pairing === undefined || entry.pairing === filter.pairing) &&
      (filter.bot === undefined || entry.bot === filter.bot),
  )
  return filter.limit === undefined || filter.limit <= 0 ? matching : matching.slice(-filter.limit)
}

/** Reads `30m`, `12h`, `7d`, a local date, or an ISO date-time; `undefined` otherwise. Never throws. */
export function parseSince(raw: string, now: Date): Date | undefined {
  const duration = DURATION_PATTERN.exec(raw)
  if (duration !== null) {
    const unit = UNIT_MS[duration[2] as keyof typeof UNIT_MS]
    const since = new Date(now.getTime() - Number(duration[1]) * unit)
    return Number.isNaN(since.getTime()) ? undefined : since
  }
  const date = DATE_PATTERN.exec(raw)
  if (date !== null) {
    const year = Number(date[1])
    const month = Number(date[2])
    const day = Number(date[3])
    const parsed = new Date(year, month - 1, day)
    const isRealDate =
      parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day
    return isRealDate ? parsed : undefined
  }
  if (DATE_TIME_PATTERN.test(raw)) {
    // Date.parse rolls 02-30 over to 03-02, so check the calendar date on its own first.
    const [year = 0, month = 0, day = 0] = raw.slice(0, 10).split('-').map(Number)
    const calendar = new Date(Date.UTC(year, month - 1, day))
    if (
      calendar.getUTCFullYear() !== year ||
      calendar.getUTCMonth() !== month - 1 ||
      calendar.getUTCDate() !== day
    ) {
      return undefined
    }
    const parsedMs = Date.parse(raw)
    return Number.isFinite(parsedMs) ? new Date(parsedMs) : undefined
  }
  return undefined
}

function parseLine(line: string): AskedRecord | SettledRecord | undefined {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    // A malformed line is counted as skipped by the caller.
    return undefined
  }
  const result = auditLineSchema.safeParse(json)
  return result.success ? result.data : undefined
}

function toEntry(asked: AskedRecord, settled: SettledRecord | undefined, now: Date): AuditEntry {
  const isOverdue = now.getTime() - Date.parse(asked.at) > asked.timeoutSeconds * 1000
  return {
    id: asked.id,
    askedAt: asked.at,
    ...(asked.project === undefined ? {} : { project: asked.project }),
    text: asked.text,
    options: asked.options,
    timeoutOption: asked.timeoutOption,
    timeoutSeconds: asked.timeoutSeconds,
    status: settled?.outcome ?? (isOverdue ? 'interrupted' : 'pending'),
    ...(settled?.answer === undefined ? {} : { answer: settled.answer }),
    ...(settled === undefined ? {} : { settledAt: settled.at }),
    ...(asked.key === undefined ? {} : { key: asked.key }),
    ...(asked.pairing === undefined ? {} : { pairing: asked.pairing }),
  }
}
