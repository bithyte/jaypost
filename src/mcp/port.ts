import { DEFAULT_PORT, PORT_ENV_VAR } from '../config/constants.ts'
import { readInstall } from '../install/index.ts'
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

function parseEnvPort(raw: string | undefined): number | undefined {
  if (raw === undefined || !PORT_PATTERN.test(raw)) {
    return undefined
  }
  const port = Number(raw)
  return port >= 1 && port <= MAX_PORT ? port : undefined
}
