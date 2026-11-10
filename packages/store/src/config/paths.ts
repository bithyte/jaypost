import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { INBOX_FILE_NAME } from '../inbox/constants.ts'
import { PORT_ENV_VAR, PORT_PATTERN } from './constants.ts'

/** Env value, with an empty string counting as unset. */
export function findEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]
  return value === undefined || value === '' ? undefined : value
}

/** `JAYPOST_PORT` when it's a port number, else undefined. Never throws. */
export function findEnvPort(env: NodeJS.ProcessEnv): number | undefined {
  const raw = findEnvValue(env, PORT_ENV_VAR)
  if (raw === undefined || !PORT_PATTERN.test(raw)) {
    return undefined
  }
  const port = Number(raw)
  return port >= 1 && port <= 65_535 ? port : undefined
}

/** The jaypost config root: $XDG_CONFIG_HOME/jaypost or ~/.config/jaypost; ignores $JAYPOST_CONFIG. */
export function resolveJaypostDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const xdgConfigHome = findEnvValue(env, 'XDG_CONFIG_HOME')
  const base = xdgConfigHome ?? join(findEnvValue(env, 'HOME') ?? homedir(), '.config')
  return join(base, 'jaypost')
}

/** Path of the inbox, inbox.json, in the jaypost config root; ignores $JAYPOST_CONFIG. */
export function resolveInboxPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveJaypostDirectory(env), INBOX_FILE_NAME)
}

/**
 * Path of config.json: $JAYPOST_CONFIG, else service/config.json under the jaypost config root.
 * Empty env values count as unset.
 */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = findEnvValue(env, 'JAYPOST_CONFIG')
  if (explicit) {
    return explicit
  }
  return join(resolveJaypostDirectory(env), 'service', 'config.json')
}

/** Default config directory, ignoring $JAYPOST_CONFIG; install files live here. */
export function resolveConfigDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const { JAYPOST_CONFIG: _ignored, ...rest } = env
  return dirname(resolveConfigPath(rest))
}
