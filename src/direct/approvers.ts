import { APPROVERS_ENV_VAR } from '../config/index.ts'
import { APPROVER_SEPARATOR_PATTERN, EMPTY_APPROVERS, NO_APPROVERS } from './constants.ts'
import type { ApproverList } from './types.ts'

/**
 * Picks the approvers: flag ids first, else `JAYPOST_APPROVERS` split on commas and whitespace.
 * Never throws.
 */
export function resolveApprovers(
  flagVoters: readonly string[] | undefined,
  env: NodeJS.ProcessEnv,
): ApproverList {
  if (flagVoters !== undefined) {
    return { kind: 'listed', voters: flagVoters }
  }
  // Raw read, not findEnvValue: a set but empty value must stay distinct from unset.
  const raw = env[APPROVERS_ENV_VAR]
  if (raw === undefined) {
    return NO_APPROVERS
  }
  const voters = raw.split(APPROVER_SEPARATOR_PATTERN).filter((id) => id !== '')
  return voters.length === 0 ? EMPTY_APPROVERS : { kind: 'listed', voters }
}

/**
 * GitHub Actions `::add-mask::` lines, one per distinct non-empty trimmed id; none outside
 * Actions. Never throws.
 */
export function formatMaskCommands(
  ids: readonly string[],
  env: NodeJS.ProcessEnv,
): readonly string[] {
  if (env.GITHUB_ACTIONS !== 'true') {
    return []
  }
  const distinct = new Set(ids.map((id) => id.trim()).filter((id) => id !== ''))
  return [...distinct].map((id) => `::add-mask::${id}`)
}
