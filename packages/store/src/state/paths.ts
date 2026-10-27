import { dirname, join } from 'node:path'
import { STATE_FILE_NAME } from './constants.ts'

/** Where the retired state.json sat: next to the config file. Only the install purge uses it. */
export function resolveStatePath(configPath: string): string {
  return join(dirname(configPath), STATE_FILE_NAME)
}
