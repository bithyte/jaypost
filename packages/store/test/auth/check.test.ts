import { expect, test } from 'vite-plus/test'
import { isAuthorized } from '../../src/auth/index.ts'

const TOKEN = 'a'.repeat(43)
const HAND_SET = 'Ab+/._~-'.repeat(5)

test('isAuthorized accepts the bearer token with any scheme case and extra spaces', () => {
  for (const header of [`Bearer ${TOKEN}`, `bearer ${TOKEN}`, `BEARER   ${TOKEN}  `]) {
    expect(isAuthorized(header, TOKEN)).toBe(true)
  }
  expect(isAuthorized(`Bearer ${HAND_SET}`, HAND_SET)).toBe(true)
})

test('isAuthorized rejects wrong, longer, other-scheme, bare, empty and missing headers', () => {
  for (const header of [
    `Bearer ${'b'.repeat(43)}`,
    `Bearer ${TOKEN}x`,
    `Basic ${TOKEN}`,
    TOKEN,
    'Bearer ',
    '',
    undefined,
  ]) {
    expect(isAuthorized(header, TOKEN)).toBe(false)
  }
})
