import { findEnvValue, MODE_ENV_VAR } from '@jaypost/store'
import { DIRECT_MODE, SERVICE_MODE } from './constants.ts'
import type { SendMode } from './types.ts'

/** Reads `JAYPOST_MODE`; unset or empty is `service`. Never throws. */
export function resolveSendMode(env: NodeJS.ProcessEnv): SendMode {
  const value = findEnvValue(env, MODE_ENV_VAR)
  if (value === undefined || value === SERVICE_MODE.kind) {
    return SERVICE_MODE
  }
  if (value === DIRECT_MODE.kind) {
    return DIRECT_MODE
  }
  return { kind: 'invalid', value }
}
