import packageJson from '../../package.json' with { type: 'json' }

/** Package version, read from package.json when the module loads. */
export const VERSION: string = packageJson.version
/** Port used when neither the env nor the config file sets one. */
export const DEFAULT_PORT = 8787
/** Loopback only; the container image overrides it with HOST=0.0.0.0. */
export const DEFAULT_HOST = '127.0.0.1'
/** Appended to config errors so the user knows how to fix them. */
export const INIT_HINT = 'run `jaypost init` to set up the bot'
/** Accepts optionally signed whole numbers in env values. */
export const INTEGER_PATTERN = /^-?\d+$/
/** Owner read/write only, for files that hold provider secrets. */
export const SECRET_FILE_MODE = 0o600
