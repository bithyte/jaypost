import { parseToken, readTokenFile, resolveAdminKeyPath } from '@jaypost/store'

/**
 * The admin key the service wrote next to `configFile`. Throws when the file is missing (the
 * service hasn't started since the upgrade), invalid or unreadable; never quotes its contents.
 */
export function readAdminKeyFile(configFile: string): string {
  const path = resolveAdminKeyPath(configFile)
  const raw = readTokenFile(path)
  if (raw === undefined) {
    throw new Error(
      `no admin key in ${JSON.stringify(path)} yet; start the service once so it writes one`,
    )
  }
  const key = parseToken(raw)
  if (key === undefined) {
    throw new Error(`admin key file ${JSON.stringify(path)} isn't a valid jaypost admin key`)
  }
  return key
}

/** The admin key `jaypost admin-key show` printed in a container; throws without quoting it. */
export function parseContainerAdminKey(stdout: string): string {
  const key = parseToken(stdout)
  if (key === undefined) {
    throw new Error("the container didn't print a valid admin key")
  }
  return key
}
