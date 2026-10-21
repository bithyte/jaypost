import { MAX_ATTACHMENT_BYTES } from '../approval/index.ts'
import type { Provider, ProviderSetting, SettingValue, SettingValues } from './types.ts'

export function findProvider(providers: readonly Provider[], name: string): Provider | undefined {
  return providers.find((provider) => provider.name === name)
}

/** Throws on an unknown provider name. */
export function requireProvider(providers: readonly Provider[], name: string): Provider {
  const provider = findProvider(providers, name)
  if (provider === undefined) {
    throw new Error(`unknown provider ${JSON.stringify(name)}; run \`jaypost init\``)
  }
  return provider
}

export function findOwnerSetting(provider: Provider): ProviderSetting | undefined {
  return provider.settings.find((setting) => setting.owner)
}

/** Keeps only values `parse` accepts. Never throws. */
export function collectSettings(
  provider: Provider,
  readRaw: (setting: ProviderSetting) => unknown,
): SettingValues {
  const values: Record<string, SettingValue> = {}
  for (const setting of provider.settings) {
    const value = setting.parse(readRaw(setting))
    if (value !== undefined) {
      values[setting.configKey] = value
    }
  }
  return values
}

export function hasRequiredSecrets(provider: Provider, settings: SettingValues): boolean {
  return provider.settings
    .filter((setting) => setting.required && setting.secret)
    .every((setting) => Object.hasOwn(settings, setting.configKey))
}

export function listSecretValues(provider: Provider, settings: SettingValues): readonly string[] {
  return provider.settings
    .filter((setting) => setting.secret)
    .flatMap((setting) => {
      const value = settings[setting.configKey]
      return value === undefined ? [] : [String(value)]
    })
}

/** The attachment size limit to enforce for `provider`: its own, capped at `MAX_ATTACHMENT_BYTES`. */
export function resolveMaxAttachmentBytes(provider: Provider): number {
  return Math.min(provider.maxAttachmentBytes ?? 0, MAX_ATTACHMENT_BYTES)
}
