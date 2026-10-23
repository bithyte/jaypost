import { expect, test } from 'vite-plus/test'
import { formatMaskCommands, resolveApprovers } from '../../src/direct/index.ts'

test('flags win over the env var', () => {
  expect(resolveApprovers(['1'], { JAYPOST_APPROVERS: '2,3' })).toEqual({
    kind: 'listed',
    voters: ['1'],
  })
  expect(resolveApprovers(['1'], { JAYPOST_APPROVERS: '' })).toEqual({
    kind: 'listed',
    voters: ['1'],
  })
})
test('reads ids split by commas and whitespace', () => {
  expect(resolveApprovers(undefined, { JAYPOST_APPROVERS: '111, 222,\n333 444,' })).toEqual({
    kind: 'listed',
    voters: ['111', '222', '333', '444'],
  })
})
test('an unset env var means no approvers', () => {
  expect(resolveApprovers(undefined, {})).toEqual({ kind: 'none' })
})
test('a set env var with no ids is empty', () => {
  for (const value of ['', ' ', ' , \n']) {
    expect(resolveApprovers(undefined, { JAYPOST_APPROVERS: value })).toEqual({ kind: 'empty' })
  }
})
test('mask lines under github actions, one per distinct trimmed id', () => {
  expect(formatMaskCommands(['1', ' 2', '1', ''], { GITHUB_ACTIONS: 'true' })).toEqual([
    '::add-mask::1',
    '::add-mask::2',
  ])
})
test('no mask lines outside github actions', () => {
  expect(formatMaskCommands(['1'], {})).toEqual([])
  expect(formatMaskCommands(['1'], { GITHUB_ACTIONS: 'false' })).toEqual([])
})
