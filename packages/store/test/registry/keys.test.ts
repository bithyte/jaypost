import { expect, test } from 'vite-plus/test'
import { TOKEN_PATTERN } from '../../src/auth/index.ts'
import { generateAdminKey, generateApiKey, hashKey } from '../../src/registry/index.ts'

test('generated keys pass the client token pattern and hash to 64 hex characters', () => {
  const apiKey = generateApiKey()
  const adminKey = generateAdminKey()
  expect(apiKey).toMatch(/^jpk_[A-Za-z0-9_-]{43}$/)
  expect(adminKey).toMatch(/^jpa_[A-Za-z0-9_-]{43}$/)
  expect(TOKEN_PATTERN.test(apiKey)).toBe(true)
  expect(TOKEN_PATTERN.test(adminKey)).toBe(true)
  expect(hashKey(apiKey)).toMatch(/^[0-9a-f]{64}$/)
})

test('generated keys differ each time', () => {
  expect(generateApiKey()).not.toBe(generateApiKey())
  expect(generateAdminKey()).not.toBe(generateAdminKey())
})

test('a key hashes to its sha256 hex digest', () => {
  expect(hashKey('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  expect(hashKey('abc')).not.toBe(hashKey('abd'))
})
