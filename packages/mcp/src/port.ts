import { findEnvEndpoint, toLocalEndpoint } from '@jaypost/client'
import type { ServiceEndpoint } from '@jaypost/client'
import { DEFAULT_PORT, PORT_ENV_VAR } from '@jaypost/store'
import { readInstall } from '@jaypost/install'
import { MAX_PORT, PORT_PATTERN } from './constants.ts'

/** Port of the local service: flag, then JAYPOST_PORT env, then install.json, then the default. */
export function resolveMcpPort(
  flagPort: number | undefined,
  env: NodeJS.ProcessEnv,
  installFile: string,
): number {
  if (flagPort !== undefined) {
    return flagPort
  }
  const envPort = parseEnvPort(env[PORT_ENV_VAR])
  if (envPort !== undefined) {
    return envPort
  }
  return readInstall(installFile)?.port ?? DEFAULT_PORT
}

/**
 * Service the clients (`send`, `hook`, `mcp`) call: the local one on the `--port` flag, then
 * `JAYPOST_URL` (local or remote), then the local one on `resolveMcpPort`'s port. Never throws;
 * a bad `JAYPOST_URL` comes back `invalid`.
 */
export function resolveMcpEndpoint(
  flagPort: number | undefined,
  env: NodeJS.ProcessEnv,
  installFile: string,
): ServiceEndpoint {
  if (flagPort !== undefined) {
    return toLocalEndpoint(flagPort)
  }
  return findEnvEndpoint(env) ?? toLocalEndpoint(resolveMcpPort(undefined, env, installFile))
}

function parseEnvPort(raw: string | undefined): number | undefined {
  if (raw === undefined || !PORT_PATTERN.test(raw)) {
    return undefined
  }
  const port = Number(raw)
  return port >= 1 && port <= MAX_PORT ? port : undefined
}
