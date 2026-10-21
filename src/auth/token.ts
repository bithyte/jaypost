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
import type { ClientToken } from './types.ts'

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
  const fromEnv = findEnvValue(env, TOKEN_ENV_VAR)
  if (fromEnv !== undefined) {
    const token = parseToken(fromEnv)
    return token === undefined
      ? { kind: 'unusable', message: `${TOKEN_ENV_VAR} isn't a valid jaypost token` }
      : { kind: 'token', token, source: 'env' }
  }
  let raw: string | undefined
  try {
    raw = readTokenFile(tokenFile)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      kind: 'unusable',
      message: `token file ${JSON.stringify(tokenFile)} couldn't be read: ${reason}`,
    }
  }
  if (raw === undefined) {
    return NO_CLIENT_TOKEN
  }
  const token = parseToken(raw)
  return token === undefined
    ? {
        kind: 'unusable',
        message: `token file ${JSON.stringify(tokenFile)} isn't a valid jaypost token`,
      }
    : { kind: 'token', token, source: 'file' }
}
