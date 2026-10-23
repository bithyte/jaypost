import { expect, test } from 'vite-plus/test'
import { decideVote } from '../../src/approval/index.ts'
import type { VoteDecision, VoteRule } from '../../src/approval/index.ts'

const ROWS: readonly (readonly [VoteRule, number, number, number, VoteDecision])[] = [
  ['all', 3, 3, 0, 'approved'],
  ['all', 3, 2, 0, 'undecided'],
  ['all', 3, 2, 1, 'rejected'],
  ['all', 1, 0, 1, 'rejected'],
  ['majority', 3, 2, 0, 'approved'],
  ['majority', 3, 1, 1, 'undecided'],
  ['majority', 3, 1, 2, 'rejected'],
  ['majority', 4, 2, 2, 'rejected'],
  ['majority', 4, 2, 1, 'undecided'],
  ['majority', 4, 3, 0, 'approved'],
  ['majority', 1, 1, 0, 'approved'],
  ['majority', 1, 0, 0, 'undecided'],
]

for (const [rule, voterCount, approveCount, rejectCount, expected] of ROWS) {
  test(`${rule} of ${voterCount} voters with ${approveCount} approve and ${rejectCount} reject is ${expected}`, () =>
    expect(decideVote(rule, { voterCount, approveCount, rejectCount })).toBe(expected))
}

test('missing votes counted as rejections never approve an undecided majority', () => {
  for (let voterCount = 1; voterCount <= 7; voterCount += 1) {
    for (let approveCount = 0; approveCount <= voterCount; approveCount += 1) {
      const live = decideVote('majority', { voterCount, approveCount, rejectCount: 0 })
      const final = decideVote('majority', {
        voterCount,
        approveCount,
        rejectCount: voterCount - approveCount,
      })
      if (live === 'undecided') {
        expect(final).toBe('rejected')
      }
    }
  }
})
