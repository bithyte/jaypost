import { STATE_VERSION } from './constants.ts'
import { stateFileSchema } from './schema.ts'
import type { StateParseResult } from './types.ts'

function hasWrongVersion(raw: unknown): boolean {
  return (
    typeof raw === 'object' && raw !== null && 'version' in raw && raw.version !== STATE_VERSION
  )
}

/** Validates an already-parsed state file written for `providerName`. Never throws. */
export function parseState(raw: unknown, providerName: string): StateParseResult {
  if (hasWrongVersion(raw)) {
    return { ok: false, reason: 'unsupported version' }
  }
  const result = stateFileSchema.safeParse(raw)
  if (!result.success) {
    return { ok: false, reason: 'invalid or missing fields' }
  }
  const { provider, requests, notifications } = result.data
  if (provider !== providerName) {
    return { ok: false, reason: `written for provider ${JSON.stringify(provider)}` }
  }
  return { ok: true, state: { requests, notifications } }
}
