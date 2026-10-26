import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { ROTATED_SUFFIX } from '../audit/constants.ts'
import { resolveAuditPath } from '../audit/store.ts'
import { parseToken, readTokenFile, resolveClientSecret, writeTokenFile } from '../auth/token.ts'
import type { ClientToken } from '../auth/types.ts'
import { SECRET_FILE_MODE } from '../config/constants.ts'
import { resolveStatePath } from '../state/store.ts'
import { isMissingFileError, writeFileAtomic } from '../system/files.ts'
import { ADMIN_KEY_ENV_VAR } from './constants.ts'
import { generateAdminKey } from './keys.ts'
import { createEmptyRegistry } from './operations.ts'
import { resolveBotFiles, resolveRegistryPath } from './paths.ts'
import { registrySchema } from './schema.ts'
import type { Registry } from './types.ts'

/** Reads and writes registry.json, which holds bot tokens and key hashes. */
export class RegistryStore {
  readonly #path: string

  constructor(path: string) {
    this.#path = path
  }

  /**
   * Missing file: empty registry. Invalid JSON or schema: throws without quoting the file, since it
   * holds bot tokens. Other read errors are rethrown.
   */
  load(): Registry {
    let text: string
    try {
      text = readFileSync(this.#path, 'utf8')
    } catch (error) {
      if (isMissingFileError(error)) {
        return createEmptyRegistry()
      }
      throw error
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      // Don't use the parser's message: it can quote part of the file.
      throw new Error(`registry file ${JSON.stringify(this.#path)} contains invalid JSON`)
    }
    const result = registrySchema.safeParse(raw)
    // Zod's issues can quote values too.
    if (!result.success) {
      throw new Error(`registry file ${JSON.stringify(this.#path)} has invalid or missing fields`)
    }
    return result.data
  }

  /** Atomic, 0600. Throws on failure and leaves the old file; the caller keeps its previous value. */
  save(registry: Registry): void {
    writeFileAtomic(this.#path, `${JSON.stringify(registry, null, 2)}\n`, SECRET_FILE_MODE)
  }
}

/**
 * The seed bot's audit file, or the pre-upgrade one next to config.json when there's no registry
 * yet (or it has no seed). Throws on a corrupt registry.
 */
export function resolveSeedAuditPath(configPath: string): string {
  const seed = new RegistryStore(resolveRegistryPath(configPath)).load().seed
  return seed === undefined
    ? resolveAuditPath(configPath)
    : resolveBotFiles(configPath, seed.botId).auditPath
}

function moveIfAbsent(from: string, to: string): void {
  if (!existsSync(from) || existsSync(to)) {
    return
  }
  mkdirSync(dirname(to), { recursive: true })
  renameSync(from, to)
}

/**
 * Moves state.json and audit.jsonl(.1) from next to config.json into the bot's directory, if there
 * and not already moved. A file already in the bot's directory is never overwritten; the legacy one
 * then stays where it is. Throws on I/O errors.
 */
export function migrateLegacyBotFiles(configPath: string, botId: string): void {
  const files = resolveBotFiles(configPath, botId)
  const legacyAuditPath = resolveAuditPath(configPath)
  moveIfAbsent(resolveStatePath(configPath), files.statePath)
  moveIfAbsent(legacyAuditPath, files.auditPath)
  moveIfAbsent(`${legacyAuditPath}${ROTATED_SUFFIX}`, `${files.auditPath}${ROTATED_SUFFIX}`)
}

/** Atomically writes `key` plus a newline, readable by the owner only. */
export function writeAdminKeyFile(path: string, key: string): void {
  writeTokenFile(path, key)
}

/**
 * Reads the admin key file; writes a new key when it's missing or invalid and logs that (never the
 * key). Returns the key. Read errors other than a missing file and write errors are thrown.
 */
export function ensureAdminKey(path: string, log: (line: string) => void): string {
  const raw = readTokenFile(path)
  const existing = raw === undefined ? undefined : parseToken(raw)
  if (existing !== undefined) {
    return existing
  }
  const key = generateAdminKey()
  writeAdminKeyFile(path, key)
  log(
    raw === undefined
      ? `wrote a new admin key to ${JSON.stringify(path)}`
      : `admin key file ${JSON.stringify(path)} wasn't a valid admin key; wrote a new one`,
  )
  return key
}

/**
 * Client side: JAYPOST_ADMIN_KEY (empty counts as unset), then the file, else none; same shape and
 * messages as resolveClientToken, never quoting the value. Never throws.
 */
export function resolveAdminKey(env: NodeJS.ProcessEnv, path: string): ClientToken {
  return resolveClientSecret(env, path, {
    envVar: ADMIN_KEY_ENV_VAR,
    fileName: 'admin key file',
    valueName: 'jaypost admin key',
  })
}
