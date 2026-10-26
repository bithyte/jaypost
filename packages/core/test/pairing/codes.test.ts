import { expect, test } from 'vite-plus/test'
import { PairingCodes, isCodeShaped } from '../../src/pairing/index.ts'

test('each code claims its own pairing once', () => {
  const codes = new PairingCodes()
  codes.add('p1', 'K7QM4XPD')
  codes.add('p2', 'ABCD2345')
  expect(codes.attempt('u1', 'abcd-2345')).toEqual({ kind: 'paired', pairingId: 'p2' })
  expect(codes.codeFor('p2')).toBeUndefined()
  expect(codes.attempt('u2', 'ABCD2345')).toEqual({ kind: 'wrong' })
  expect(codes.codeFor('p1')).toBe('K7QM4XPD')
})

test('wrong guesses are counted per sender across all codes', () => {
  const codes = new PairingCodes()
  codes.add('p1', 'K7QM4XPD')
  codes.add('p2', 'ABCD2345')
  for (let index = 0; index < 5; index += 1) {
    expect(codes.attempt('u1', 'AAAA-AAAA')).toEqual({ kind: 'wrong' })
  }
  expect(codes.attempt('u1', 'K7QM-4XPD')).toEqual({ kind: 'blocked' })
  expect(codes.attempt('u2', 'K7QM-4XPD')).toEqual({ kind: 'paired', pairingId: 'p1' })
})

test('no outstanding codes means not pairing, and failures are not counted', () => {
  const codes = new PairingCodes()
  expect(codes.attempt('u1', 'K7QM4XPD')).toEqual({ kind: 'notPairing' })
  for (let index = 0; index < 10; index += 1) {
    codes.attempt('u1', 'AAAA-AAAA')
  }
  codes.add('p1', 'K7QM4XPD')
  expect(codes.attempt('u1', 'K7QM4XPD')).toEqual({ kind: 'paired', pairingId: 'p1' })
})

test('removing a pairing drops its code', () => {
  const codes = new PairingCodes()
  codes.add('p1', 'K7QM4XPD')
  codes.add('p2', 'ABCD2345')
  codes.remove('p1')
  expect(codes.codeFor('p1')).toBeUndefined()
  expect(codes.attempt('u1', 'K7QM4XPD')).toEqual({ kind: 'wrong' })
  codes.remove('p2')
  expect(codes.isEmpty).toBe(true)
  expect(codes.attempt('u2', 'ABCD2345')).toEqual({ kind: 'notPairing' })
})

test('adding a code again replaces the pairing previous code', () => {
  const codes = new PairingCodes()
  codes.add('p1', 'K7QM4XPD')
  codes.add('p1', 'ABCD2345')
  expect(codes.codeFor('p1')).toBe('ABCD2345')
  expect(codes.attempt('u1', 'K7QM4XPD')).toEqual({ kind: 'wrong' })
  expect(codes.attempt('u1', 'ABCD2345')).toEqual({ kind: 'paired', pairingId: 'p1' })
})

test('codeFor returns the raw uppercase code and isEmpty tracks outstanding codes', () => {
  const codes = new PairingCodes()
  expect(codes.isEmpty).toBe(true)
  codes.add('p1', 'k7qm4xpd')
  expect(codes.codeFor('p1')).toBe('K7QM4XPD')
  expect(codes.isEmpty).toBe(false)
})

test('maxFailures is configurable', () => {
  const codes = new PairingCodes(1)
  codes.add('p1', 'K7QM4XPD')
  expect(codes.attempt('u1', 'AAAA-AAAA')).toEqual({ kind: 'wrong' })
  expect(codes.attempt('u1', 'K7QM4XPD')).toEqual({ kind: 'blocked' })
})

test('isCodeShaped accepts dashes, spaces and lowercase, rejects chat text', () => {
  expect(isCodeShaped('k7qm-4xpd')).toBe(true)
  expect(isCodeShaped(' K7QM 4XPD ')).toBe(true)
  expect(isCodeShaped('/start K7QM4XPD')).toBe(false) // callers strip /start first
  expect(isCodeShaped('sounds good')).toBe(false)
  expect(isCodeShaped('K7QM4XP')).toBe(false)
  expect(isCodeShaped('K7QM4XP0')).toBe(false)
})
