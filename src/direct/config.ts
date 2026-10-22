import { PROVIDER_ENV_VAR } from '../config/index.ts'
import { findEnvValue } from '../config/paths.ts'
import { DEFAULT_PROVIDER, requireProvider } from '../provider/index.ts'
import type { Provider, SettingValue } from '../provider/index.ts'
import type { DirectConfig } from './types.ts'

/**
 * Reads the provider and its settings from env only, never the config file. Required settings and
 * the owner must be set. Throws on an unknown provider or a missing or invalid setting; messages
 * name the env var, never the value.
 */
export function loadDirectConfig(
  env: NodeJS.ProcessEnv,
  providers: readonly Provider[],
): DirectConfig {
  const provider = requireProvider(
    providers,
    findEnvValue(env, PROVIDER_ENV_VAR) ?? DEFAULT_PROVIDER,
  )
  const settings: Record<string, SettingValue> = {}
  for (const setting of provider.settings) {
    const raw = findEnvValue(env, setting.envVar)
    if (raw === undefined) {
      if (setting.required || setting.owner) {
        throw new Error(
          `missing ${setting.description}; set ${setting.envVar} (jaypost setup-ci prints it)`,
        )
      }
      continue
    }
    const value = setting.parse(raw)
    if (value === undefined) {
      throw new Error(`invalid ${setting.description} in ${setting.envVar}`)
    }
    settings[setting.configKey] = value
  }
  return { provider, settings }
}
