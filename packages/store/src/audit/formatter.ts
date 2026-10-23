import {
  ANSWER_COLUMN_MAX,
  CONTROL_CHARACTER_PATTERN,
  PROJECT_COLUMN_MAX,
  QUESTION_COLUMN_MAX,
} from './constants.ts'
import type { AuditEntry } from './types.ts'

type Row = {
  readonly time: string
  readonly project: string
  readonly result: string
  readonly question: string
}

const ELLIPSIS = '...'

/**
 * Renders entries as aligned rows joined by newlines, with no trailing newline. Never throws:
 * control characters become spaces and long values are cut, so output is safe for a terminal.
 */
export function formatAuditTable(entries: readonly AuditEntry[]): string {
  const rows = entries.map(toRow)
  const hasProject = rows.some((row) => row.project !== '')
  const columns = rows.map((row) =>
    hasProject
      ? [row.time, row.project, row.result, row.question]
      : [row.time, row.result, row.question],
  )
  const widths = columns.reduce<readonly number[]>(
    (current, cells) => cells.map((cell, index) => Math.max(current[index] ?? 0, cell.length)),
    [],
  )
  return columns
    .map((cells) =>
      cells
        .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}

/** One `JSON.stringify` entry per line, joined by newlines, keeping the entry's key order. */
export function formatAuditJsonLines(entries: readonly AuditEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n')
}

function toRow(entry: AuditEntry): Row {
  return {
    time: formatLocalTime(entry.askedAt),
    project: clean(entry.project ?? '', PROJECT_COLUMN_MAX),
    result: describeResult(entry),
    question: clean(entry.text.trim(), QUESTION_COLUMN_MAX),
  }
}

function describeResult(entry: AuditEntry): string {
  const answer = clean(entry.answer ?? '', ANSWER_COLUMN_MAX)
  switch (entry.status) {
    case 'answered':
      return answer
    case 'timedOut':
      return `${answer} (timed out)`
    case 'rejected':
      return `${answer} (rejected)`
    case 'cancelled':
    case 'expired':
    case 'pending':
    case 'interrupted':
      return entry.status
    default:
      return answer === ''
        ? clean(entry.status, ANSWER_COLUMN_MAX)
        : `${clean(entry.status, ANSWER_COLUMN_MAX)}: ${answer}`
  }
}

function formatLocalTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return clean(iso, 16)
  }
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// First line only, then control characters (newlines included) become spaces, then cut.
function clean(text: string, max: number): string {
  const firstLine = text.split(/\r?\n/)[0] ?? ''
  return truncate(firstLine.replace(CONTROL_CHARACTER_PATTERN, ' '), max)
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }
  let cut = ''
  for (const character of text) {
    if (cut.length + character.length > max - ELLIPSIS.length) {
      break
    }
    cut += character
  }
  return `${cut}${ELLIPSIS}`
}
