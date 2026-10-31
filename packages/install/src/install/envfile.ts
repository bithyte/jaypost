import { readFileSync } from 'node:fs'
import { collectSettings, DEFAULT_PROVIDER, findOwnerSetting, findProvider } from '@jaypost/core'
import type { Provider } from '@jaypost/core'
import {
  isMissingFileError,
  PROVIDER_ENV_VAR,
  TOKEN_ENV_VAR,
  writeFileAtomic,
} from '@jaypost/store'
import type { ExecResult } from '@jaypost/store'
import { SECRET_FILE_MODE } from './constants.ts'
import type { Secrets } from './types.ts'

function readTextIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined
    }
    throw error
  }
}

/**
 * Parses KEY=VALUE lines, skipping blanks and comments; returns {} when the file is missing. Values
 * are taken literally (no unquoting).
 */
export function readEnvFile(path: string): Readonly<Record<string, string>> {
  const text = readTextIfPresent(path)
  if (text === undefined) {
    return {}
  }
  const values: Record<string, string> = {}
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) {
      continue
    }
    const index = line.indexOf('=')
    if (index > 0) {
      values[line.slice(0, index)] = line.slice(index + 1)
    }
  }
  return values
}

/** The JAYPOST_TOKEN in an env file; undefined when the file or the line is missing or empty. */
export function readEnvApiToken(path: string): string | undefined {
  const token = readEnvFile(path)[TOKEN_ENV_VAR]
  return token === undefined || token === '' ? undefined : token
}

/** Atomic write with owner-only permissions, since the file holds credentials. */
export function writeEnvFile(path: string, contents: string): void {
  writeFileAtomic(path, contents, SECRET_FILE_MODE)
}

/**
 * Drops every `key=` line, rewriting the file atomically; does nothing when the file is missing.
 */
export function removeEnvKey(path: string, key: string): void {
  const text = readTextIfPresent(path)
  if (text === undefined) {
    return
  }
  const kept = text.split('\n').filter((line) => !line.startsWith(`${key}=`))
  writeEnvFile(path, kept.join('\n'))
}

/**
 * Provider named by `JAYPOST_PROVIDER` (Telegram when absent) and its settings from the env file; settings
 * are empty for an unknown provider or a missing file.
 */
export function readEnvSecrets(path: string, providers: readonly Provider[]): Secrets {
  const values = readEnvFile(path)
  const name = values[PROVIDER_ENV_VAR] || DEFAULT_PROVIDER
  const provider = findProvider(providers, name)
  if (provider === undefined) {
    return { provider: name, settings: {} }
  }
  return {
    provider: name,
    settings: collectSettings(provider, (setting) => values[setting.envVar]),
  }
}

/**
 * `readEnvSecrets`, plus the owner from `ownerGet` (`owner get` in the container) when the env
 * file has none, since pairing stores it in the data volume. Output the owner setting rejects is
 * ignored.
 */
export async function readContainerSecrets(
  path: string,
  providers: readonly Provider[],
  ownerGet: () => Promise<ExecResult>,
): Promise<Secrets> {
  const secrets = readEnvSecrets(path, providers)
  const provider = findProvider(providers, secrets.provider)
  const owner = provider === undefined ? undefined : findOwnerSetting(provider)
  if (owner === undefined || Object.hasOwn(secrets.settings, owner.configKey)) {
    return secrets
  }
  const result = await ownerGet()
  const value = result.code === 0 ? owner.parse(result.stdout.trim()) : undefined
  return value === undefined
    ? secrets
    : { ...secrets, settings: { ...secrets.settings, [owner.configKey]: value } }
}
