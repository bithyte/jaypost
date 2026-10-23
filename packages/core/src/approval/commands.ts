import { DEFAULT_HISTORY_COUNT, HISTORY_LIMIT } from './constants.ts'
import { formatHistoryReply, formatPendingReply, formatRejectedReply } from './formatter.ts'
import type { ApprovalService } from './service.ts'
import type { OwnerCommandOptions } from './types.ts'

const HISTORY_USAGE = `Usage: /history [1-${HISTORY_LIMIT}]`
const COUNT_PATTERN = /^\d+$/

function parseHistoryCount(argument: string): number | undefined {
  const trimmed = argument.trim()
  if (trimmed === '') {
    return DEFAULT_HISTORY_COUNT
  }
  if (!COUNT_PATTERN.test(trimmed) || Number(trimmed) < 1) {
    return undefined
  }
  return Math.min(Number(trimmed), HISTORY_LIMIT)
}

/**
 * Reply text for an owner command, or undefined for a name it doesn't know; never throws.
 * `/cancel` rejects every open request as a side effect.
 */
export function runOwnerCommand(
  service: ApprovalService,
  name: string,
  argument: string,
  options: OwnerCommandOptions,
): string | undefined {
  switch (name) {
    case 'pending':
      return formatPendingReply(service.listPending(), options.now(), options.maxTextLength)
    case 'cancel':
      return formatRejectedReply(service.rejectAll(), options.maxTextLength)
    case 'history': {
      const count = parseHistoryCount(argument)
      if (count === undefined) {
        return HISTORY_USAGE
      }
      return formatHistoryReply(service.history(count), options.maxTextLength)
    }
    default:
      return undefined
  }
}
