import { TOKEN_ENV_VAR } from '../auth/constants.ts'
import { HOST_ENV_VAR, MODE_ENV_VAR, PORT_ENV_VAR, PROVIDER_ENV_VAR } from '../config/constants.ts'

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
  PROVIDER_ENV_VAR,
  PORT_ENV_VAR,
  HOST_ENV_VAR,
  'JAYPOST_CONFIG',
  TOKEN_ENV_VAR,
  MODE_ENV_VAR,
  'TZ',
]
