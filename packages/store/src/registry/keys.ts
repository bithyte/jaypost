import { createHash, randomBytes } from 'node:crypto'
import { TOKEN_BYTES } from '../auth/constants.ts'
import { ADMIN_KEY_PREFIX, API_KEY_PREFIX } from './constants.ts'

/** A new API key: `jpk_` plus 32 random bytes as base64url. Passes `TOKEN_PATTERN`. */
export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`
}

/** A new admin key: `jpa_` plus 32 random bytes as base64url. Passes `TOKEN_PATTERN`. */
export function generateAdminKey(): string {
  return `${ADMIN_KEY_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`
}

/** The sha256 hex digest the registry stores in place of a key. Never throws. */
export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}
