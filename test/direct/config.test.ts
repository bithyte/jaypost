import { expect, test } from 'vite-plus/test'
import { loadDirectConfig } from '../../src/direct/index.ts'
import { PROVIDERS } from '../../src/provider/index.ts'
import { createPairingFakeProvider } from '../provider/fake.ts'

const FAKE = createPairingFakeProvider()

test('reads the provider and its settings from env only', () => {
  const env = {
    JAYPOST_PROVIDER: 'fakepair',
    FAKE_KEY: 'k',
    FAKE_OWNER: 'o',
    JAYPOST_CONFIG: '/nonexistent/x.json',
  }
  expect(loadDirectConfig(env, [FAKE])).toEqual({
    provider: FAKE,
    settings: { fakeKey: 'k', fakeOwner: 'o' },
  })
})

test('the provider defaults to telegram', () => {
  const config = loadDirectConfig({ JAYPOST_BOT_TOKEN: 't', JAYPOST_OWNER_ID: '42' }, PROVIDERS)
  expect(config.provider.name).toBe('telegram')
  expect(config.settings).toEqual({ botToken: 't', ownerId: 42 })
})

test('the owner is required', () => {
  expect(() => loadDirectConfig({ JAYPOST_PROVIDER: 'fakepair', FAKE_KEY: 'k' }, [FAKE])).toThrow(
    'missing fake owner; set FAKE_OWNER (jaypost setup-ci prints it)',
  )
})

test('a required setting is required, and empty counts as unset', () => {
  expect(() =>
    loadDirectConfig({ JAYPOST_PROVIDER: 'fakepair', FAKE_KEY: '', FAKE_OWNER: 'o' }, [FAKE]),
  ).toThrow('missing fake key; set FAKE_KEY (jaypost setup-ci prints it)')
})

test('an invalid telegram owner id names the env var, not the value', () => {
  const load = () =>
    loadDirectConfig({ JAYPOST_BOT_TOKEN: 'secret', JAYPOST_OWNER_ID: 'abc' }, PROVIDERS)
  expect(load).toThrow('invalid owner id in JAYPOST_OWNER_ID')
  expect(load).not.toThrow(/secret|abc/)
})

test('an unknown provider throws', () => {
  expect(() => loadDirectConfig({ JAYPOST_PROVIDER: 'nope' }, PROVIDERS)).toThrow(
    'unknown provider "nope"',
  )
})
