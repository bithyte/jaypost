import { dirname, join } from 'node:path'
import { AUDIT_FILE_NAME } from '../audit/constants.ts'
import { STATE_FILE_NAME } from '../state/constants.ts'
import { ADMIN_KEY_FILE_NAME, BOTS_DIRECTORY_NAME, REGISTRY_FILE_NAME } from './constants.ts'
import type { BotFiles } from './types.ts'

/** registry.json lives next to the config file. */
export function resolveRegistryPath(configPath: string): string {
  return join(dirname(configPath), REGISTRY_FILE_NAME)
}

/** The admin key file lives next to the config file, so containers keep it in the data volume. */
export function resolveAdminKeyPath(configPath: string): string {
  return join(dirname(configPath), ADMIN_KEY_FILE_NAME)
}

/** A bot's directory, `bots/<botId>/` next to the config file, and its state and audit files. */
export function resolveBotFiles(configPath: string, botId: string): BotFiles {
  const directory = join(dirname(configPath), BOTS_DIRECTORY_NAME, botId)
  return {
    directory,
    statePath: join(directory, STATE_FILE_NAME),
    auditPath: join(directory, AUDIT_FILE_NAME),
  }
}
