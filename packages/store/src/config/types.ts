import type { z } from 'zod'
import type { ApiAuth } from '../auth/index.ts'
import type { Provider, QuietHours, SettingValues } from '@jaypost/core'
import type { fileConfigSchema } from './schema.ts'

/**
 * Resolved settings; the owner setting is absent until someone has paired. `quietHours` and
 * `mutedUntil` are omitted when unset.
 */
export type Config = {
  readonly provider: Provider
  readonly settings: SettingValues
  readonly port: number
  readonly host: string
  readonly auth: ApiAuth
  readonly quietHours?: QuietHours
  readonly mutedUntil?: Date
}

/** Shape of config.json; every field is optional and unknown keys are kept. */
export type FileConfig = Readonly<z.infer<typeof fileConfigSchema>>

/** Keys to merge into the config file; `null` deletes the key. */
export type ConfigPatch = Readonly<Record<string, unknown>>
