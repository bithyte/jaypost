import { readFileSync, rmSync } from 'node:fs'
import { DEFAULT_PROVIDER, findOwnerSetting, requireProvider } from '@jaypost/core'
import type { Provider, ProviderSetting } from '@jaypost/core'
import { writeFileAtomic } from '@jaypost/store'
import { SECRET_FILE_MODE } from './constants.ts'
import { installRecordSchema } from './schema.ts'
import type { InstallRecord } from './types.ts'

/** Undefined when the file is missing, unreadable or invalid. */
export function readInstall(file: string): InstallRecord | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  const result = installRecordSchema.safeParse(parsed)
  return result.success ? result.data : undefined
}

/** Atomic write with owner-only permissions. */
export function writeInstall(file: string, record: InstallRecord): void {
  writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`, SECRET_FILE_MODE)
}

/** Deletes install.json; fine if it is already gone. */
export function removeInstall(file: string): void {
  rmSync(file, { force: true })
}

/** Provider name of an install; records without one are Telegram. */
export function resolveRecordProvider(record: InstallRecord): string {
  return record.provider ?? DEFAULT_PROVIDER
}

/**
 * Owner setting of the record's provider; throws for an unknown provider or one that doesn't pair.
 */
export function requireRecordOwner(
  providers: readonly Provider[],
  record: InstallRecord,
): ProviderSetting {
  const provider = requireProvider(providers, resolveRecordProvider(record))
  const owner = findOwnerSetting(provider)
  if (owner === undefined) {
    throw new Error(`provider ${JSON.stringify(provider.name)} has no owner setting`)
  }
  return owner
}
