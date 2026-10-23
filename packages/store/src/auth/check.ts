import { createHash, timingSafeEqual } from 'node:crypto'
import { AUTHORIZATION_PATTERN } from './constants.ts'

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/**
 * True when `header` is a bearer Authorization header carrying `token`. Compares fixed-length
 * digests in constant time. Pure; never throws.
 */
export function isAuthorized(header: string | undefined, token: string): boolean {
  if (header === undefined) {
    return false
  }
  const presented = AUTHORIZATION_PATTERN.exec(header)?.[1]
  return presented !== undefined && timingSafeEqual(digest(presented), digest(token))
}
