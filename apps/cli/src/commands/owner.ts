import {
  PROVIDER_ENV_VAR,
  readConfigFile,
  RegistryStore,
  resetPairing,
  resolveConfigPath,
  resolveRegistryPath,
  updateConfigFile,
} from '@jaypost/store'
import type { Registry } from '@jaypost/store'
import { DEFAULT_PROVIDER, findOwnerSetting, generateCode, requireProvider } from '@jaypost/core'
import type { Provider, SettingValue } from '@jaypost/core'
import { PROVIDERS } from '@jaypost/providers'

/**
 * Hidden helper; runs inside containers so the CLI can read/clear the owner in the data volume.
 * `get` prints the seed pairing's person (config.json's owner before the registry exists); `clear`
 * makes the seed pairing wait for a fresh code and deletes the owner from config.json. Returns 0,
 * 1 on an unknown provider or an unreadable registry (never quoting it), 2 on bad usage.
 */
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
  try {
    const provider = requireProvider(
      providers,
      (env[PROVIDER_ENV_VAR] === '' ? undefined : env[PROVIDER_ENV_VAR]) ??
        file.provider ??
        DEFAULT_PROVIDER,
    )
    const owner = findOwnerSetting(provider)
    if (owner === undefined) {
      return 0
    }
    const store = new RegistryStore(resolveRegistryPath(path))
    const registry = store.load()
    if (args[0] === 'get') {
      printOwner(registry, owner.parse(file[owner.configKey]))
      return 0
    }
    clearSeedPairing(store, registry)
    updateConfigFile(path, { [owner.configKey]: null })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
  return 0
}

/** The seed pairing's person, or `configOwner` while the registry has no seed. */
function printOwner(registry: Registry, configOwner: SettingValue | undefined): void {
  const { seed } = registry
  const value =
    seed === undefined
      ? configOwner
      : registry.pairings.find((pairing) => pairing.id === seed.pairingId)?.person
  if (value !== undefined) {
    console.log(String(value))
  }
}

/** Drops the seed pairing's person and gives it a fresh code; nothing to do without a seed. */
function clearSeedPairing(store: RegistryStore, registry: Registry): void {
  if (registry.seed === undefined) {
    return
  }
  // Only a provider with an owner setting gets here, so the seed bot pairs.
  const result = resetPairing(registry, registry.seed.pairingId, generateCode(), true)
  if (result.kind === 'reset') {
    store.save(result.registry)
  }
}
