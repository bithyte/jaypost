import { expect, test } from 'vite-plus/test'
import {
  DEFAULT_PROVIDER,
  findProvider,
  PROVIDERS,
  RESERVED_CONFIG_KEYS,
  RESERVED_ENV_VARS,
} from '../../src/provider/index.ts'

test('no two providers share a config key or env var', () => {
  const settings = PROVIDERS.flatMap((provider) => provider.settings)
  const configKeys = settings.map((setting) => setting.configKey)
  const envVars = settings.map((setting) => setting.envVar)
  expect(new Set(configKeys).size).toBe(configKeys.length)
  expect(new Set(envVars).size).toBe(envVars.length)
})

test('no provider uses a reserved key or env var', () => {
  for (const setting of PROVIDERS.flatMap((provider) => provider.settings)) {
    expect(RESERVED_CONFIG_KEYS).not.toContain(setting.configKey)
    expect(RESERVED_ENV_VARS).not.toContain(setting.envVar)
  }
})

test('TZ is reserved', () => {
  expect(RESERVED_ENV_VARS).toContain('TZ')
})

test('each provider has at most one owner setting, and an owner setting iff resetOwnerWarning', () => {
  for (const provider of PROVIDERS) {
    const owners = provider.settings.filter((setting) => setting.owner)
    expect(owners.length).toBeLessThanOrEqual(1)
    expect(owners.length === 1).toBe(provider.setup.text.resetOwnerWarning !== undefined)
  }
})

test('telegram is registered and is the default', () => {
  expect(findProvider(PROVIDERS, DEFAULT_PROVIDER)?.name).toBe('telegram')
})

test('the api token key and env var are reserved', () => {
  expect(RESERVED_CONFIG_KEYS).toContain('apiToken')
  expect(RESERVED_ENV_VARS).toContain('JAYPOST_TOKEN')
})

test('the quiet settings keys are reserved', () => {
  expect(RESERVED_CONFIG_KEYS).toEqual(expect.arrayContaining(['quietHours', 'mutedUntil']))
})
