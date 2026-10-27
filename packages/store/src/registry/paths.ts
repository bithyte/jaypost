import { dirname, join } from 'node:path'
import { ADMIN_KEY_FILE_NAME } from './constants.ts'

/** The admin key file lives next to the config file, so containers keep it in the data volume. */
export function resolveAdminKeyPath(configPath: string): string {
  return join(dirname(configPath), ADMIN_KEY_FILE_NAME)
}
