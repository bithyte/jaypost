import { DEFAULT_LOG_LIMIT, formatAuditJsonLines, formatAuditTable } from '@jaypost/store'
import type { AuditEntry } from '@jaypost/store'
import { Caller } from '@jaypost/client'
import type { LogFilter } from '@jaypost/client'
import type { LogArgs, LogDeps } from './types.ts'

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
  const entries: readonly AuditEntry[] = result.page.entries
  const { skippedCount } = result.page
  if (entries.length > 0) {
    deps.print(args.json ? formatAuditJsonLines(entries) : formatAuditTable(entries))
  } else {
    const isUnfiltered = filter.since === undefined && filter.project === undefined
    const message = isUnfiltered ? 'No questions logged.' : 'No questions match.'
    // With --json stdout stays parseable, so the message goes to stderr.
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
