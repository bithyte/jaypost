import { readFileSync } from 'node:fs'
import { NO_AUTH, parseToken, TOKEN_ENV_VAR } from '../auth/index.ts'
import type { ApiAuth } from '../auth/index.ts'
import { DEFAULT_PROVIDER, requireProvider } from '../provider/index.ts'
import type { Provider, SettingValue } from '../provider/index.ts'
import { parseQuietHours } from '../quiet/index.ts'
import type { QuietHours } from '../quiet/index.ts'
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
import type { Config, ConfigPatch, FileConfig } from './types.ts'

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

function resolveAuth(env: NodeJS.ProcessEnv, file: FileConfig): ApiAuth {
  const raw = findEnvValue(env, TOKEN_ENV_VAR) ?? (file.apiToken === '' ? undefined : file.apiToken)
  if (raw === undefined) {
    return NO_AUTH
  }
  const token = parseToken(raw)
  if (token === undefined) {
    throw new Error(`invalid api token; ${INIT_HINT} (or set ${TOKEN_ENV_VAR})`)
  }
  return { kind: 'token', token }
}

function resolveQuietHours(file: FileConfig): QuietHours | undefined {
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

function resolveMutedUntil(
  file: FileConfig,
  path: string,
  log: (line: string) => void,
): Date | undefined {
  const raw = file.mutedUntil
  if (raw === undefined) {
    return undefined
  }
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) {
    log(`ignoring invalid mutedUntil ${JSON.stringify(raw)} in ${JSON.stringify(path)}`)
    return undefined
  }
  return date
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
  const provider = requireProvider(
    providers,
    findEnvValue(env, PROVIDER_ENV_VAR) ?? file.provider ?? DEFAULT_PROVIDER,
  )
  const settings: Record<string, SettingValue> = {}
  for (const setting of provider.settings) {
    const fileValue = file[setting.configKey]
    const raw = findEnvValue(env, setting.envVar) ?? (fileValue === '' ? undefined : fileValue)
    if (raw === undefined) {
      if (setting.required) {
        throw new Error(`missing ${setting.description}; ${INIT_HINT} (or set ${setting.envVar})`)
      }
      continue
    }
    const value = setting.parse(raw)
    if (value === undefined) {
      throw new Error(`invalid ${setting.description}; ${INIT_HINT} (or set ${setting.envVar})`)
    }
    settings[setting.configKey] = value
  }
  const rawPort = findEnvValue(env, PORT_ENV_VAR) ?? file.port ?? DEFAULT_PORT
  const port = toInteger(rawPort)
  if (port === undefined || port < 1 || port > 65535) {
    throw new Error(`invalid port ${JSON.stringify(String(rawPort))}: must be an integer 1-65535`)
  }
  const auth = resolveAuth(env, file)
  const quietHours = resolveQuietHours(file)
  const mutedUntil = resolveMutedUntil(file, path, log)
  return {
    provider,
    settings,
    port,
    host: findEnvValue(env, HOST_ENV_VAR) ?? DEFAULT_HOST,
    auth,
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
