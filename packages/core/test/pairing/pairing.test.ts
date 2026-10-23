import { expect, test } from 'vite-plus/test'
import { Pairing, formatCode, generateCode } from '../../src/pairing/index.ts'

test('generateCode uses the alphabet, 8 chars', () => {
  const c = generateCode()
  expect(c).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/)
})

test('generateCode uses the injected randomInt', () => {
  expect(generateCode(() => 0)).toBe('AAAAAAAA')
})

test('formatCode', () => expect(formatCode('K7QM4XPD')).toBe('K7QM-4XPD'))

test.each(['K7QM-4XPD', 'k7qm4xpd', 'K7QM 4XPD', '  k7qm-4xpd '])('accepts %s', (t) =>
  expect(new Pairing('K7QM4XPD').attempt('1', t)).toBe('paired'),
)

test('wrong code, then blocked after 5 failures per sender', () => {
  const p = new Pairing('K7QM4XPD')
  for (let i = 0; i < 5; i++) {
    expect(p.attempt('1', 'AAAA-AAAA')).toBe('wrong')
  }
  expect(p.attempt('1', 'K7QM-4XPD')).toBe('blocked')
  expect(p.attempt('2', 'K7QM-4XPD')).toBe('paired')
})

test('after pairing everything is not-pairing', () => {
  const p = new Pairing('K7QM4XPD')
  p.attempt('1', 'K7QM4XPD')
  expect(p.paired).toBe(true)
  expect(p.code).toBeUndefined()
  expect(p.attempt('3', 'K7QM4XPD')).toBe('notPairing')
})

test('/start K7QM-4XPD is wrong without telegram stripping', () =>
  expect(new Pairing('K7QM4XPD').attempt('1', '/start K7QM-4XPD')).toBe('wrong'))
