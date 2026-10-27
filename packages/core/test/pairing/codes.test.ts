import { expect, test } from 'vite-plus/test'
import { GuessLimit, isCodeShaped } from '../../src/pairing/index.ts'

test('a sender is blocked after five wrong codes', () => {
  const guesses = new GuessLimit()
  for (let index = 0; index < 5; index += 1) {
    expect(guesses.isBlocked('u1')).toBe(false)
    guesses.countWrong('u1')
  }
  expect(guesses.isBlocked('u1')).toBe(true)
})

test('wrong codes are counted per sender', () => {
  const guesses = new GuessLimit(1)
  guesses.countWrong('u1')
  expect(guesses.isBlocked('u1')).toBe(true)
  expect(guesses.isBlocked('u2')).toBe(false)
})

test('maxFailures is configurable', () => {
  const guesses = new GuessLimit(2)
  guesses.countWrong('u1')
  expect(guesses.isBlocked('u1')).toBe(false)
  guesses.countWrong('u1')
  expect(guesses.isBlocked('u1')).toBe(true)
})

test('isCodeShaped accepts dashes, spaces and lowercase, rejects chat text', () => {
  expect(isCodeShaped('k7qm-4xpd')).toBe(true)
  expect(isCodeShaped(' K7QM 4XPD ')).toBe(true)
  expect(isCodeShaped('/start K7QM4XPD')).toBe(false) // callers strip /start first
  expect(isCodeShaped('sounds good')).toBe(false)
  expect(isCodeShaped('K7QM4XP')).toBe(false)
  expect(isCodeShaped('K7QM4XP0')).toBe(false)
})
