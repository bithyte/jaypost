import type { VoteCounts, VoteDecision, VoteRule } from './types.ts'

/**
 * Decides a vote from its tally. Pure, never throws. A tie under `majority` rejects, so missing
 * votes counted as rejections can never turn an undecided vote into an approval.
 */
export function decideVote(rule: VoteRule, counts: VoteCounts): VoteDecision {
  const { voterCount, approveCount, rejectCount } = counts
  if (rule === 'all') {
    if (rejectCount > 0) {
      return 'rejected'
    }
    return approveCount === voterCount ? 'approved' : 'undecided'
  }
  const needed = Math.floor(voterCount / 2) + 1
  if (approveCount >= needed) {
    return 'approved'
  }
  return voterCount - rejectCount < needed ? 'rejected' : 'undecided'
}
