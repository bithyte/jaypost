import type { Book } from './types.ts'

export const BOOK_FILE_NAME = 'bots.json'

export const BOOK_VERSION = 1

export const EMPTY_BOOK: Book = { version: 1, remotes: [], bots: [] }

export const INVITE_PREFIX = 'jpi_'

export const INVITE_VERSION = 1

export const BOT_ENV_VAR = 'JAYPOST_BOT'

export const LOCAL_ALIAS = 'local'

/** Prefix a pasted invite may carry from the `jaypost join` command line. */
export const JOIN_COMMAND_PREFIX = 'jaypost join '
