import { TOKEN_ENV_VAR } from '../auth/constants.ts'

/** Provider used when config, env and install state name none. */
export const DEFAULT_PROVIDER = 'telegram'
/** Config keys owned by core; no provider setting may use them. */
export const RESERVED_CONFIG_KEYS: readonly string[] = [
  'provider',
  'port',
  'apiToken',
  'quietHours',
  'mutedUntil',
]
/** Env vars owned by core; no provider setting may use them. */
export const RESERVED_ENV_VARS: readonly string[] = [
  'PROVIDER',
  'PORT',
  'HOST',
  'JAYPOST_CONFIG',
  TOKEN_ENV_VAR,
  'TZ',
]
