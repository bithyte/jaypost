import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { findEnvValue } from '../config/paths.ts'
import { isMissingFileError } from '../system/files.ts'
import { NO_CLIENT_TOKEN, TOKEN_BYTES, TOKEN_ENV_VAR, TOKEN_PATTERN } from './constants.ts'
import type { ClientSecretNames, ClientToken } from './types.ts'

const CLIENT_TOKEN_NAMES: ClientSecretNames = {
  envVar: TOKEN_ENV_VAR,
  fileName: 'token file',
  valueName: 'jaypost token',
}

/** A new random token: 32 bytes as 43 base64url characters. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/** The trimmed value when it is a valid token, else undefined. Never throws. */
export function parseToken(raw: string): string | undefined {
  const trimmed = raw.trim()
  return TOKEN_PATTERN.test(trimmed) ? trimmed : undefined
}

/** Raw text of a token-shaped secret file (the admin key), or undefined when it is missing. */
export function readTokenFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined
    }
    throw error
  }
}

/**
 * The client token from JAYPOST_TOKEN only, never a file. A bad value gives `unusable` with a
 * message that never quotes it. Never throws.
 */
export function resolveEnvToken(env: NodeJS.ProcessEnv): ClientToken {
  return resolveEnvSecret(env, CLIENT_TOKEN_NAMES) ?? NO_CLIENT_TOKEN
}

/**
 * A secret with the token's shape: `names.envVar` (empty counts as unset), then `path`, else none.
 * A source that exists but is invalid or unreadable gives `unusable`; messages name the source
 * with `names` and never quote the value. Never throws.
 */
export function resolveClientSecret(
  env: NodeJS.ProcessEnv,
  path: string,
  names: ClientSecretNames,
): ClientToken {
  const fromEnv = resolveEnvSecret(env, names)
  if (fromEnv !== undefined) {
    return fromEnv
  }
  let raw: string | undefined
  try {
    raw = readTokenFile(path)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      kind: 'unusable',
      message: `${names.fileName} ${JSON.stringify(path)} couldn't be read: ${reason}`,
    }
  }
  if (raw === undefined) {
    return NO_CLIENT_TOKEN
  }
  const token = parseToken(raw)
  return token === undefined
    ? {
        kind: 'unusable',
        message: `${names.fileName} ${JSON.stringify(path)} isn't a valid ${names.valueName}`,
      }
    : { kind: 'token', token, source: 'file' }
}

function resolveEnvSecret(
  env: NodeJS.ProcessEnv,
  names: ClientSecretNames,
): ClientToken | undefined {
  const raw = findEnvValue(env, names.envVar)
  if (raw === undefined) {
    return undefined
  }
  const token = parseToken(raw)
  return token === undefined
    ? { kind: 'unusable', message: `${names.envVar} isn't a valid ${names.valueName}` }
    : { kind: 'token', token, source: 'env' }
}
