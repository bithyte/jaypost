import { createHash } from 'node:crypto'
import { findOwnerSetting, formatQuietHours } from '@jaypost/core'
import type { Provider, SettingValues } from '@jaypost/core'
import { resolveConfigPath } from '../config/paths.ts'
import {
  parseMutedUntil,
  readConfigFile,
  readProviderSettings,
  resolveApiToken,
  resolveConfigProvider,
  resolveQuietHours,
} from '../config/store.ts'
import { hashKey } from './keys.ts'
import { withoutOwner } from './operations.ts'
import type { SeedLoad } from './types.ts'

/** Changes with the provider, its settings other than the owner, and the api token. */
function toSeedFingerprint(
  provider: string,
  settings: SettingValues,
  token: string | undefined,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ provider, settings, token: token ?? null }))
    .digest('hex')
}

/**
 * What the env and config.json say bot 1, contact 1 and key 1 should be, with env vars overriding
 * the file as in `loadConfig`. A missing required setting gives `missing`. Throws on an unknown
 * provider, an invalid setting, api token or quietHours, or a bad config file, never quoting a
 * secret. An unparseable mutedUntil is left out.
 */
export function loadSeed(env: NodeJS.ProcessEnv, providers: readonly Provider[]): SeedLoad {
  const file = readConfigFile(resolveConfigPath(env))
  const provider = resolveConfigProvider(env, file, providers)
  const read = readProviderSettings(env, file, provider)
  if (read.kind === 'missing') {
    return read
  }
  const token = resolveApiToken(env, file)
  const quietHours = resolveQuietHours(file)
  const mutedUntil = file.mutedUntil === undefined ? undefined : parseMutedUntil(file.mutedUntil)
  const ownerSetting = findOwnerSetting(provider)
  const owner = ownerSetting === undefined ? undefined : read.settings[ownerSetting.configKey]
  const settings = withoutOwner({ provider, settings: read.settings })
  return {
    kind: 'seed',
    provider,
    seed: {
      fingerprint: toSeedFingerprint(provider.name, settings, token),
      provider: provider.name,
      settings,
      ...(owner === undefined ? {} : { owner: String(owner) }),
      ...(token === undefined ? {} : { tokenHash: hashKey(token) }),
      ...(quietHours === undefined ? {} : { quietHours: formatQuietHours(quietHours) }),
      ...(mutedUntil === undefined ? {} : { mutedUntil: mutedUntil.toISOString() }),
    },
  }
}
