import { randomBytes } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { SECRET_FILE_MODE } from '../config/constants.ts'
import { findEnvValue, resolveConfigDirectory } from '../config/paths.ts'
import { isMissingFileError, writeFileAtomic } from '../system/files.ts'
import {
  NO_CLIENT_TOKEN,
  TOKEN_BYTES,
  TOKEN_ENV_VAR,
  TOKEN_FILE_NAME,
  TOKEN_PATTERN,
} from './constants.ts'
import type { ClientSecretNames, ClientToken } from './types.ts'

/** A new random token: 32 bytes as 43 base64url characters. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/** The trimmed value when it is a valid token, else undefined. Never throws. */
export function parseToken(raw: string): string | undefined {
  const trimmed = raw.trim()
  return TOKEN_PATTERN.test(trimmed) ? trimmed : undefined
}

/** Path of the client token file in the install config directory; ignores JAYPOST_CONFIG. */
export function resolveTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveConfigDirectory(env), TOKEN_FILE_NAME)
}

/** Raw text of the token file, or undefined when it is missing; other read errors are rethrown. */
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

/** Atomically writes `token` plus a newline, readable by the owner only. */
export function writeTokenFile(path: string, token: string): void {
  writeFileAtomic(path, `${token}\n`, SECRET_FILE_MODE)
}

/** Deletes the token file; a missing file is fine. */
export function removeTokenFile(path: string): void {
  rmSync(path, { force: true })
}

/**
 * Finds the client token: the env var (empty counts as unset), then the file, else none. A source
 * that exists but is invalid or unreadable gives `unusable`, with a message that names the source
 * and never the value. Never throws.
 */
export function resolveClientToken(env: NodeJS.ProcessEnv, tokenFile: string): ClientToken {
  return resolveClientSecret(env, tokenFile, {
    envVar: TOKEN_ENV_VAR,
    fileName: 'token file',
    valueName: 'jaypost token',
  })
}

/**
 * `resolveClientToken` for any secret with the token's shape: `names.envVar`, then `path`, else
 * none. Messages name the source with `names` and never quote the value. Never throws.
 */
export function resolveClientSecret(
  env: NodeJS.ProcessEnv,
  path: string,
  names: ClientSecretNames,
): ClientToken {
  const fromEnv = findEnvValue(env, names.envVar)
  if (fromEnv !== undefined) {
    const token = parseToken(fromEnv)
    return token === undefined
      ? { kind: 'unusable', message: `${names.envVar} isn't a valid ${names.valueName}` }
      : { kind: 'token', token, source: 'env' }
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
