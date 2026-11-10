import { expect, test } from 'vite-plus/test'
import { decideVote } from '../../src/approval/index.ts'
import type { VoteRule } from '../../src/approval/index.ts'

const ROWS: readonly (readonly [VoteRule, number, Record<string, number>, string | undefined])[] = [
  ['all', 3, { Yes: 3 }, 'Yes'],
  ['all', 3, { Yes: 2 }, undefined],
  ['all', 3, { Yes: 2, No: 1 }, 'No'],
  ['all', 1, { No: 1 }, 'No'],
  ['majority', 3, { Yes: 2 }, 'Yes'],
  ['majority', 3, { Yes: 1, No: 1 }, undefined],
  ['majority', 3, { Yes: 1, No: 2 }, 'No'],
  ['majority', 4, { Yes: 2, No: 2 }, 'No'],
  ['majority', 4, { Yes: 2, No: 1 }, undefined],
  ['majority', 4, { Yes: 3 }, 'Yes'],
  ['majority', 1, { Yes: 1 }, 'Yes'],
  ['majority', 1, {}, undefined],
  ['all', 3, { A: 3 }, 'A'],
  ['all', 3, { A: 1, B: 1 }, 'No'],
  ['all', 3, { A: 2 }, undefined],
  ['all', 3, { No: 1 }, 'No'],
  ['majority', 3, { A: 1, B: 1 }, undefined],
  ['majority', 3, { A: 1, B: 1, No: 1 }, 'No'],
  ['majority', 4, { A: 2, B: 1, No: 1 }, 'No'],
  ['majority', 4, { A: 2, B: 1 }, undefined],
  ['majority', 5, { A: 2, B: 2 }, undefined],
  ['majority', 5, { A: 2, B: 2, No: 1 }, 'No'],
  ['majority', 3, { No: 2 }, 'No'],
  ['majority', 3, { B: 2, A: 1 }, 'B'],
]

for (const [rule, voterCount, counts, expected] of ROWS) {
  test(`${rule} of ${voterCount} voters with ${JSON.stringify(counts)} is ${expected ?? 'undecided'}`, () =>
    expect(
      decideVote(rule, 'No', { voterCount, countByAnswer: new Map(Object.entries(counts)) }),
    ).toEqual(
      expected === undefined ? { kind: 'undecided' } : { kind: 'decided', answer: expected },
    ))
}

test('missing votes counted as rejections never approve an undecided majority', () => {
  for (let voterCount = 1; voterCount <= 7; voterCount += 1) {
    for (let approveCount = 0; approveCount <= voterCount; approveCount += 1) {
      const live = decideVote('majority', 'No', {
        voterCount,
        countByAnswer: new Map(Object.entries({ Yes: approveCount })),
      })
      const final = decideVote('majority', 'No', {
        voterCount,
        countByAnswer: new Map(
          Object.entries({ Yes: approveCount, No: voterCount - approveCount }),
        ),
      })
      if (live.kind === 'undecided') {
        expect(final).toEqual({ kind: 'decided', answer: 'No' })
      }
    }
  }
})
