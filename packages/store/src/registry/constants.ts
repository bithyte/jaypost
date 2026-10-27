import type { ClaimPairingResult } from './types.ts'

export const REGISTRY_VERSION = 1

/** Registry file name inside the config directory. */
export const REGISTRY_FILE_NAME = 'registry.json'

/** Directory inside the config directory holding one `<botId>/` directory per bot. */
export const BOTS_DIRECTORY_NAME = 'bots'

/** Admin key file name inside the config directory. */
export const ADMIN_KEY_FILE_NAME = 'admin-key'

/** Env var admin clients read the admin key from. */
export const ADMIN_KEY_ENV_VAR = 'JAYPOST_ADMIN_KEY'

/** The person of pairings on providers that don't pair. */
export const LOCAL_PERSON = 'local'

export const API_KEY_PREFIX = 'jpk_'

export const ADMIN_KEY_PREFIX = 'jpa_'

export const BOT_ID_PREFIX = 'b'

export const PAIRING_ID_PREFIX = 'p'

export const KEY_ID_PREFIX = 'k'

export const NOT_PENDING = { kind: 'notPending' } as const satisfies ClaimPairingResult
