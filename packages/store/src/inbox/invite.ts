import { parseToken } from '../auth/token.ts'
import { INVITE_PREFIX, INVITE_VERSION, JOIN_COMMAND_PREFIX } from './constants.ts'
import { toServiceUrl } from './operations.ts'
import type { Invite } from './types.ts'

/** `jpi_` plus the base64url JSON of `{ v, url, key }`. */
export function encodeInvite(invite: Invite): string {
  const payload = { v: INVITE_VERSION, url: invite.url, key: invite.key }
  return `${INVITE_PREFIX}${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
}

/**
 * The invite in `raw`, or undefined when it is truncated, has another prefix or version, or carries
 * a bad url or key. Trims and strips a pasted `jaypost inbox join `. Never throws.
 */
export function decodeInvite(raw: string): Invite | undefined {
  let text = raw.trim()
  if (text.startsWith(JOIN_COMMAND_PREFIX)) {
    text = text.slice(JOIN_COMMAND_PREFIX.length).trim()
  }
  if (!text.startsWith(INVITE_PREFIX)) {
    return undefined
  }
  let payload: unknown
  try {
    payload = JSON.parse(
      Buffer.from(text.slice(INVITE_PREFIX.length), 'base64url').toString('utf8'),
    )
  } catch {
    return undefined
  }
  if (typeof payload !== 'object' || payload === null) {
    return undefined
  }
  const { v, url, key } = payload as Record<string, unknown>
  if (v !== INVITE_VERSION || typeof url !== 'string' || typeof key !== 'string') {
    return undefined
  }
  const serviceUrl = toServiceUrl(url)
  const token = parseToken(key)
  if (serviceUrl === undefined || token === undefined) {
    return undefined
  }
  return { url: serviceUrl, key: token }
}
