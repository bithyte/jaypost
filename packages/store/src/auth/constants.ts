import type { ApiAuth, ClientToken } from './types.ts'

/** Env var clients and the service read the token from. */
export const TOKEN_ENV_VAR = 'JAYPOST_TOKEN'
/** Random bytes in a generated token; 32 encode to 43 base64url characters. */
export const TOKEN_BYTES = 32
/** The RFC 6750 b64token alphabet, 32 to 256 characters, so `openssl rand -base64` output fits. */
export const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]{32,256}$/
/** Captures the credential of a bearer Authorization header; the scheme is case-insensitive. */
export const AUTHORIZATION_PATTERN = /^Bearer +(\S+) *$/i
/** Service config with auth switched off. */
export const NO_AUTH = { kind: 'none' } as const satisfies ApiAuth
/** Client result when no token is configured. */
export const NO_CLIENT_TOKEN = { kind: 'none' } as const satisfies ClientToken
/** Error body value of a 401 reply. */
export const UNAUTHORIZED_ERROR = 'unauthorized'
