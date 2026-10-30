import type { ClaimCodeResult, ClaimContactResult } from './types.ts'

export const REGISTRY_VERSION = 1

/** Admin key file name inside the config directory. */
export const ADMIN_KEY_FILE_NAME = 'admin-key'

/** Env var admin clients read the admin key from. */
export const ADMIN_KEY_ENV_VAR = 'JAYPOST_ADMIN_KEY'

/** The person of contacts on providers that don't pair. */
export const LOCAL_PERSON = 'local'

export const API_KEY_PREFIX = 'jpk_'

export const ADMIN_KEY_PREFIX = 'jpa_'

export const BOT_ID_PREFIX = 'b'

export const CONTACT_ID_PREFIX = 'c'

export const KEY_ID_PREFIX = 'k'

export const NOT_PENDING = { kind: 'notPending' } as const satisfies ClaimContactResult

export const WRONG_CODE = { kind: 'wrong' } as const satisfies ClaimCodeResult

export const NO_CODES = { kind: 'noCodes' } as const satisfies ClaimCodeResult
