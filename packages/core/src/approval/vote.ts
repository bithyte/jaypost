import { UNDECIDED_VOTE } from './constants.ts'
import type { VoteCounts, VoteDecision, VoteRule } from './types.ts'

/**
 * Decides a vote from its tally: an answer picked by `all` voters or a majority of them wins, and
 * once no answer other than `timeoutOption` can still win, `timeoutOption` does. Pure, never
 * throws.
 */
export function decideVote(
  rule: VoteRule,
  timeoutOption: string,
  counts: VoteCounts,
): VoteDecision {
  const { voterCount, countByAnswer } = counts
  const needed = rule === 'all' ? voterCount : Math.floor(voterCount / 2) + 1
  const votedCount = [...countByAnswer.values()].reduce((sum, count) => sum + count, 0)
  for (const [answer, count] of countByAnswer) {
    if (count >= needed) {
      return { kind: 'decided', answer }
    }
  }
  const bestOtherCount = [...countByAnswer]
    .filter(([answer]) => answer !== timeoutOption)
    .reduce((best, [, count]) => Math.max(best, count), 0)
  return bestOtherCount + (voterCount - votedCount) < needed
    ? { kind: 'decided', answer: timeoutOption }
    : UNDECIDED_VOTE
}
