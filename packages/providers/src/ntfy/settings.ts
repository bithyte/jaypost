import type { SettingValue } from '@jaypost/core'
import { TOPIC_PATTERN } from './constants.ts'

/** An http or https URL without its trailing slashes; a path prefix is kept. Never throws. */
export function parseServer(raw: unknown): SettingValue | undefined {
  if (typeof raw !== 'string') {
    return undefined
  }
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return undefined
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return undefined
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/** A topic ntfy accepts, short enough to leave room for the reply topic suffix. Never throws. */
export function parseTopic(raw: unknown): SettingValue | undefined {
  if (typeof raw !== 'string') {
    return undefined
  }
  const trimmed = raw.trim()
  return TOPIC_PATTERN.test(trimmed) ? trimmed : undefined
}

/** Any non-empty token, trimmed. Never throws. */
export function parseToken(raw: unknown): SettingValue | undefined {
  if (typeof raw !== 'string') {
    return undefined
  }
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}
