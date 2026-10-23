import {
  PROVIDER_ENV_VAR,
  readConfigFile,
  resolveConfigPath,
  updateConfigFile,
} from '@jaypost/store'
import { DEFAULT_PROVIDER, findOwnerSetting, requireProvider } from '@jaypost/core'
import type { Provider } from '@jaypost/core'
import { PROVIDERS } from '@jaypost/providers'

/** Hidden helper; runs inside containers so the CLI can read/clear the owner in the data volume. */
export function runOwner(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  providers: readonly Provider[] = PROVIDERS,
): number {
  if (args[0] !== 'get' && args[0] !== 'clear') {
    console.error('Usage: owner get|clear')
    return 2
  }
  const path = resolveConfigPath(env)
  const file = readConfigFile(path)
  let provider: Provider
  try {
    provider = requireProvider(
      providers,
      (env[PROVIDER_ENV_VAR] === '' ? undefined : env[PROVIDER_ENV_VAR]) ??
        file.provider ??
        DEFAULT_PROVIDER,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
  const owner = findOwnerSetting(provider)
  if (owner === undefined) {
    return 0
  }
  if (args[0] === 'get') {
    const value = owner.parse(file[owner.configKey])
    if (value !== undefined) {
      console.log(String(value))
    }
    return 0
  }
  updateConfigFile(path, { [owner.configKey]: null })
  return 0
}
