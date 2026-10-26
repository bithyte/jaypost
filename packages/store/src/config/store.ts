import { readFileSync } from 'node:fs'
import { NO_AUTH, parseToken, TOKEN_ENV_VAR } from '../auth/index.ts'
import { DEFAULT_PROVIDER, parseQuietHours, requireProvider } from '@jaypost/core'
import type { Provider, QuietHours, SettingValue } from '@jaypost/core'
import { isMissingFileError, writeFileAtomic } from '../system/index.ts'
import {
  DEFAULT_HOST,
  HOST_ENV_VAR,
  PORT_ENV_VAR,
  PROVIDER_ENV_VAR,
  DEFAULT_PORT,
  INIT_HINT,
  INTEGER_PATTERN,
  SECRET_FILE_MODE,
} from './constants.ts'
import { findEnvValue, resolveConfigPath } from './paths.ts'
import { fileConfigSchema } from './schema.ts'
import type {
  Config,
  ConfigPatch,
  FileConfig,
  ProviderSettingsRead,
  ServiceConfig,
} from './types.ts'

/**
 * Returns {} when the file is missing. Throws on invalid JSON or fields, without quoting the file,
 * since it may hold provider secrets. Read errors other than a missing file are rethrown.
 */
export function readConfigFile(path: string): FileConfig {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) {
      return {}
    }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Don't include the parser's message: V8 can quote part of the file, which may hold a
    // secret.
    throw new Error(`config file ${JSON.stringify(path)} contains invalid JSON; ${INIT_HINT}`)
  }
  const result = fileConfigSchema.safeParse(parsed)
  // Don't include zod's issues either; keep secrets out of error output.
  if (!result.success) {
    throw new Error(
      `config file ${JSON.stringify(path)} has invalid or missing fields; ${INIT_HINT}`,
    )
  }
  return result.data
}

function toInteger(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : undefined
  }
  if (typeof value === 'string' && INTEGER_PATTERN.test(value.trim())) {
    return Number(value.trim())
  }
  return undefined
}

/** JAYPOST_TOKEN, else apiToken in the file; empty means none. Throws without quoting it. */
export function resolveApiToken(env: NodeJS.ProcessEnv, file: FileConfig): string | undefined {
  const raw = findEnvValue(env, TOKEN_ENV_VAR) ?? (file.apiToken === '' ? undefined : file.apiToken)
  if (raw === undefined) {
    return undefined
  }
  const token = parseToken(raw)
  if (token === undefined) {
    throw new Error(`invalid api token; ${INIT_HINT} (or set ${TOKEN_ENV_VAR})`)
  }
  return token
}

/** Throws when quietHours is invalid; empty or blank means off. */
export function resolveQuietHours(file: FileConfig): QuietHours | undefined {
  const raw = file.quietHours
  if (raw === undefined || raw.trim() === '') {
    return undefined
  }
  const result = parseQuietHours(raw)
  if (!result.ok) {
    throw new Error(`invalid quiet hours ${JSON.stringify(raw)}: ${result.error}`)
  }
  return result.value
}

/** The date `raw` names, or undefined when it doesn't parse. Never throws. */
export function parseMutedUntil(raw: string): Date | undefined {
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function resolveMutedUntil(
  file: FileConfig,
  path: string,
  log: (line: string) => void,
): Date | undefined {
  const raw = file.mutedUntil
  if (raw === undefined) {
    return undefined
  }
  const date = parseMutedUntil(raw)
  if (date === undefined) {
    log(`ignoring invalid mutedUntil ${JSON.stringify(raw)} in ${JSON.stringify(path)}`)
  }
  return date
}

/** JAYPOST_PROVIDER, else the file, else telegram. Throws on an unknown provider. */
export function resolveConfigProvider(
  env: NodeJS.ProcessEnv,
  file: FileConfig,
  providers: readonly Provider[],
): Provider {
  return requireProvider(
    providers,
    findEnvValue(env, PROVIDER_ENV_VAR) ?? file.provider ?? DEFAULT_PROVIDER,
  )
}

/**
 * The provider's settings, each from its env var, else the file (empty counts as unset). A missing
 * required setting gives `missing`; an invalid value throws without quoting it.
 */
export function readProviderSettings(
  env: NodeJS.ProcessEnv,
  file: FileConfig,
  provider: Provider,
): ProviderSettingsRead {
  const settings: Record<string, SettingValue> = {}
  for (const setting of provider.settings) {
    const fileValue = file[setting.configKey]
    const raw = findEnvValue(env, setting.envVar) ?? (fileValue === '' ? undefined : fileValue)
    if (raw === undefined) {
      if (setting.required) {
        return {
          kind: 'missing',
          message: `missing ${setting.description}; ${INIT_HINT} (or set ${setting.envVar})`,
        }
      }
      continue
    }
    const value = setting.parse(raw)
    if (value === undefined) {
      throw new Error(`invalid ${setting.description}; ${INIT_HINT} (or set ${setting.envVar})`)
    }
    settings[setting.configKey] = value
  }
  return { kind: 'settings', settings }
}

function resolveServiceConfig(env: NodeJS.ProcessEnv, file: FileConfig): ServiceConfig {
  const rawPort = findEnvValue(env, PORT_ENV_VAR) ?? file.port ?? DEFAULT_PORT
  const port = toInteger(rawPort)
  if (port === undefined || port < 1 || port > 65535) {
    throw new Error(`invalid port ${JSON.stringify(String(rawPort))}: must be an integer 1-65535`)
  }
  return { port, host: findEnvValue(env, HOST_ENV_VAR) ?? DEFAULT_HOST }
}

/**
 * Port (JAYPOST_PORT, else the file, else 8787) and host (JAYPOST_HOST, else loopback). Throws on
 * an invalid port or config file; ignores provider settings.
 */
export function loadServiceConfig(env: NodeJS.ProcessEnv): ServiceConfig {
  return resolveServiceConfig(env, readConfigFile(resolveConfigPath(env)))
}

/**
 * Provider (JAYPOST_PROVIDER env, else the file, else telegram), its settings, port and host. Env vars
 * (e.g. JAYPOST_PROVIDER, JAYPOST_PORT, JAYPOST_HOST) override the config file. Throws a user-facing error on an unknown
 * provider, a missing required setting, or an invalid setting, port or api token
 * (JAYPOST_TOKEN, else apiToken in the file; the message never quotes it); read errors other
 * than a missing config file are rethrown. quietHours (HH:MM-HH:MM; empty means off) throws when
 * invalid; an unparseable mutedUntil is dropped and reported through `log`.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv,
  providers: readonly Provider[],
  log: (line: string) => void = console.error,
): Config {
  const path = resolveConfigPath(env)
  const file = readConfigFile(path)
  const provider = resolveConfigProvider(env, file, providers)
  const read = readProviderSettings(env, file, provider)
  if (read.kind === 'missing') {
    throw new Error(read.message)
  }
  const { port, host } = resolveServiceConfig(env, file)
  const token = resolveApiToken(env, file)
  const quietHours = resolveQuietHours(file)
  const mutedUntil = resolveMutedUntil(file, path, log)
  return {
    provider,
    settings: read.settings,
    port,
    host,
    auth: token === undefined ? NO_AUTH : { kind: 'token', token },
    ...(quietHours === undefined ? {} : { quietHours }),
    ...(mutedUntil === undefined ? {} : { mutedUntil }),
  }
}

/** Merges `patch` into the file's JSON object; a `null` value deletes that key. */
export function updateConfigFile(path: string, patch: ConfigPatch): void {
  const next: Record<string, unknown> = { ...readConfigFile(path) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key]
    } else if (value !== undefined) {
      next[key] = value
    }
  }
  writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, SECRET_FILE_MODE)
}
