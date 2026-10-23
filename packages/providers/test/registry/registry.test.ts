import { expect, test } from 'vite-plus/test'
import { RESERVED_CONFIG_KEYS, RESERVED_ENV_VARS } from '@jaypost/store'
import { DEFAULT_PROVIDER, findProvider } from '@jaypost/core'
import { PROVIDERS } from '../../src/registry/index.ts'

test('settings are unique within a provider', () => {
  for (const provider of PROVIDERS) {
    const configKeys = provider.settings.map((setting) => setting.configKey)
    const envVars = provider.settings.map((setting) => setting.envVar)
    expect(new Set(configKeys).size).toBe(configKeys.length)
    expect(new Set(envVars).size).toBe(envVars.length)
  }
})

test('a shared config key always uses the same env var', () => {
  const envVarByConfigKey = new Map<string, string>()
  for (const setting of PROVIDERS.flatMap((provider) => provider.settings)) {
    expect(envVarByConfigKey.get(setting.configKey) ?? setting.envVar).toBe(setting.envVar)
    envVarByConfigKey.set(setting.configKey, setting.envVar)
  }
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

test('discord is registered; telegram stays the default', () => {
  expect(findProvider(PROVIDERS, 'discord')?.label).toBe('Discord')
  expect(DEFAULT_PROVIDER).toBe('telegram')
  expect(findProvider(PROVIDERS, DEFAULT_PROVIDER)?.name).toBe('telegram')
})

test('the api token key and env var are reserved', () => {
  expect(RESERVED_CONFIG_KEYS).toContain('apiToken')
  expect(RESERVED_ENV_VARS).toContain('JAYPOST_TOKEN')
})

test('the quiet settings keys are reserved', () => {
  expect(RESERVED_CONFIG_KEYS).toEqual(expect.arrayContaining(['quietHours', 'mutedUntil']))
})

test('every provider setting reads a JAYPOST_ env var', () => {
  for (const setting of PROVIDERS.flatMap((provider) => provider.settings)) {
    expect(setting.envVar).toMatch(/^JAYPOST_/)
  }
})
