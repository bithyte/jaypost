import { expect, test } from 'vite-plus/test'
import {
  collectSettings,
  findOwnerSetting,
  hasRequiredSecrets,
  isPairingProvider,
  listSecretValues,
  MAX_ATTACHMENT_BYTES,
  requireProvider,
  resolveMaxAttachmentBytes,
  resolveVoters,
} from '@jaypost/core'
import { PROVIDERS, SERVICE_PROVIDERS } from '../../src/registry/index.ts'
import { createFakeProvider } from '@jaypost/testing'

const telegram = requireProvider(PROVIDERS, 'telegram')

test('requireProvider rejects an unknown name', () => {
  expect(() => requireProvider(PROVIDERS, 'slack')).toThrow(
    'unknown provider "slack"; run `jaypost service install`',
  )
})

test('findOwnerSetting finds the owner setting', () => {
  expect(findOwnerSetting(telegram)?.configKey).toBe('ownerId')
})

test('isPairingProvider is true for a provider with an owner setting', () => {
  expect(isPairingProvider(telegram)).toBe(true)
  expect(isPairingProvider(requireProvider(SERVICE_PROVIDERS, 'terminal'))).toBe(false)
})

test('collectSettings skips invalid values', () => {
  const read = (values: Record<string, unknown>) =>
    collectSettings(telegram, (setting) => values[setting.configKey])
  expect(read({ botToken: '', ownerId: 'x' })).toEqual({})
  expect(read({ botToken: 't', ownerId: '42' })).toEqual({ botToken: 't', ownerId: 42 })
})

test('listSecretValues returns only secret values', () => {
  expect(listSecretValues(telegram, { botToken: 't', ownerId: 42 })).toEqual(['t'])
})

test('hasRequiredSecrets needs every required secret', () => {
  expect(hasRequiredSecrets(telegram, { botToken: 't' })).toBe(true)
  expect(hasRequiredSecrets(telegram, { ownerId: 42 })).toBe(false)
})

test('resolveMaxAttachmentBytes is 0 without the field', () => {
  expect(resolveMaxAttachmentBytes(createFakeProvider())).toBe(0)
})

test('resolveMaxAttachmentBytes returns the provider value below the cap', () => {
  expect(resolveMaxAttachmentBytes(createFakeProvider({ maxAttachmentBytes: 1000 }))).toBe(1000)
})

test('resolveMaxAttachmentBytes caps a larger provider value', () => {
  expect(resolveMaxAttachmentBytes(createFakeProvider({ maxAttachmentBytes: 50_000_000 }))).toBe(
    MAX_ATTACHMENT_BYTES,
  )
})

test('resolveVoters parses ids the way taps report them and drops duplicates', () => {
  expect(resolveVoters(telegram, undefined, ['0111', ' 111', '222'])).toEqual({
    kind: 'voters',
    voters: ['111', '222'],
  })
})

test('resolveVoters without voters gives the person, or noOwner without one', () => {
  expect(resolveVoters(telegram, '42', undefined)).toEqual({ kind: 'voters', voters: ['42'] })
  expect(resolveVoters(telegram, undefined, undefined)).toEqual({ kind: 'noOwner' })
})

test('resolveVoters names the first id the owner setting refuses', () => {
  expect(resolveVoters(telegram, undefined, ['1', 'abc', 'x'])).toEqual({
    kind: 'invalid',
    voter: 'abc',
  })
})

test('resolveVoters keeps ids as given without an owner setting', () => {
  expect(resolveVoters(createFakeProvider(), undefined, ['a', 'a', 'b'])).toEqual({
    kind: 'voters',
    voters: ['a', 'b'],
  })
  expect(resolveVoters(createFakeProvider(), undefined, undefined)).toEqual({ kind: 'noOwner' })
})
