import { URL_ENV_VAR } from '../config/constants.ts'
import { findEnvValue } from '../config/paths.ts'
import { HOST, INVALID_URL_MESSAGE } from './constants.ts'
import type { ServiceEndpoint } from './types.ts'

/** The local service on `host:port` over plain HTTP. */
export function toLocalEndpoint(port: number, host: string = HOST): ServiceEndpoint {
  return { kind: 'url', url: new URL(`http://${host.includes(':') ? `[${host}]` : host}:${port}/`) }
}

/**
 * `raw` as a service base URL: http or https, no credentials, query or fragment; a path is kept
 * as the prefix of every API path. Undefined when it isn't one. Never throws.
 */
export function parseEndpointUrl(raw: string): URL | undefined {
  if (!URL.canParse(raw)) {
    return undefined
  }
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return undefined
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return undefined
  }
  return url
}

/**
 * `JAYPOST_URL` when set (empty counts as unset), else undefined so the caller falls back to the
 * local service. An unparsable value is `invalid`, with a message that never repeats the value,
 * since it could hold credentials. Never throws.
 */
export function findEnvEndpoint(env: NodeJS.ProcessEnv): ServiceEndpoint | undefined {
  const raw = findEnvValue(env, URL_ENV_VAR)
  if (raw === undefined) {
    return undefined
  }
  const url = parseEndpointUrl(raw)
  return url === undefined
    ? { kind: 'invalid', message: INVALID_URL_MESSAGE }
    : { kind: 'url', url }
}

/**
 * How messages name the service: `host:port` for plain HTTP at the root, as before URLs, else the
 * URL without a trailing slash.
 */
export function describeEndpoint(url: URL): string {
  if (url.protocol === 'http:' && url.pathname === '/') {
    return url.host
  }
  return url.href.replace(/\/$/, '')
}

/**
 * True when the endpoint is on this machine, so `jaypost status` and `jaypost init` can help with
 * it; a remote relay is checked where it runs.
 */
export function isLoopbackEndpoint(url: URL): boolean {
  return (
    url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(\.\d+){3}$/.test(url.hostname)
  )
}

/** The full URL of `path` (which starts with `/`) under the endpoint's base path. */
export function resolveApiUrl(base: URL, path: string): URL {
  // Built from the origin: resolving against `base` would read a base path such as `//team` as
  // another host, and the token would go there.
  return new URL(`${base.origin}${base.pathname.replace(/\/$/, '')}${path}`)
}
