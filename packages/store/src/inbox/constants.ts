import type { Inbox } from './types.ts'

export const INBOX_FILE_NAME = 'inbox.json'

export const INBOX_VERSION = 1

export const EMPTY_INBOX: Inbox = { version: 1, remotes: [], bots: [] }

export const INVITE_PREFIX = 'jpi_'

export const INVITE_VERSION = 1

export const BOT_ENV_VAR = 'JAYPOST_BOT'

export const LOCAL_ALIAS = 'local'

/** Prefix a pasted invite may carry from the `jaypost inbox join` command line. */
export const JOIN_COMMAND_PREFIX = 'jaypost inbox join '
