import {
  ADMIN_KEY_ENV_VAR,
  DEFAULT_PORT,
  findEnvValue,
  parseToken,
  PORT_ENV_VAR,
  readConfigFile,
  resolveAdminKey,
  resolveAdminKeyPath,
  resolveConfigPath,
} from '@jaypost/store'
import { AdminCaller, findEnvEndpoint, toLocalEndpoint } from '@jaypost/client'
import { findExistingInstall } from '@jaypost/install'
import type { InstallPaths, InstallRecord, Target, TargetName } from '@jaypost/install'
import type { AdminDeps, AdminEndpoint, AdminKeyLookup, OpenedAdmin } from './types.ts'

const PORT_PATTERN = /^\d{1,5}$/

/** True for the installs whose service runs on this machine's files, not in a container. */
export function isNativeInstall(record: InstallRecord): boolean {
  return record.target === 'systemd' || record.target === 'launchd'
}

/**
 * The admin caller for this machine or `JAYPOST_URL`; `noKey` for a service whose admin key can't
 * be found, or `failed`. Prints nothing. Never throws.
 */
export async function openAdmin(
  deps: Pick<AdminDeps, 'env' | 'paths' | 'targets'>,
): Promise<OpenedAdmin> {
  const endpoint = await resolveAdminEndpoint(deps.env, deps.paths, deps.targets)
  if (endpoint.kind === 'failed') {
    return endpoint
  }
  if (endpoint.adminKey.kind === 'missing') {
    return { kind: 'noKey', endpoint, message: endpoint.adminKey.message }
  }
  const caller = new AdminCaller({
    endpoint: endpoint.endpoint,
    adminKey: endpoint.adminKey.adminKey,
  })
  return { kind: 'opened', caller, endpoint }
}

/** `openAdmin`'s caller, or undefined once the reason is printed. Never throws. */
export async function openAdminCaller(deps: AdminDeps): Promise<AdminCaller | undefined> {
  const opened = await openAdmin(deps)
  if (opened.kind !== 'opened') {
    deps.printError(opened.message)
    return undefined
  }
  return opened.caller
}

/**
 * Where the admin commands go: with `JAYPOST_URL`, that URL and `JAYPOST_ADMIN_KEY`; else the
 * local install's port, with the key from `JAYPOST_ADMIN_KEY` or the install's target; else
 * 127.0.0.1 on `JAYPOST_PORT` or the config's port, with the key from `JAYPOST_ADMIN_KEY` or the
 * admin key file next to the config. Never throws; never quotes a key.
 */
async function resolveAdminEndpoint(
  env: NodeJS.ProcessEnv,
  paths: InstallPaths,
  targets: Readonly<Record<TargetName, Target>>,
): Promise<AdminEndpoint> {
  const remote = findEnvEndpoint(env)
  const rawEnvKey = findEnvValue(env, ADMIN_KEY_ENV_VAR)
  const envKey = rawEnvKey === undefined ? undefined : parseToken(rawEnvKey)
  if (rawEnvKey !== undefined && envKey === undefined) {
    return { kind: 'failed', message: `${ADMIN_KEY_ENV_VAR} isn't a valid jaypost admin key` }
  }
  if (remote !== undefined) {
    if (remote.kind === 'invalid') {
      return { kind: 'failed', message: remote.message }
    }
    return {
      kind: 'remote',
      endpoint: remote,
      adminKey:
        envKey === undefined
          ? { kind: 'missing', message: 'JAYPOST_URL is set, so set JAYPOST_ADMIN_KEY too' }
          : { kind: 'found', adminKey: envKey },
    }
  }
  const install = findExistingInstall(paths, targets, env)?.record
  if (install !== undefined) {
    return {
      kind: 'local',
      endpoint: toLocalEndpoint(install.port),
      port: install.port,
      adminKey:
        envKey === undefined
          ? await readTargetAdminKey(targets[install.target], install)
          : { kind: 'found', adminKey: envKey },
      install,
      configPath: isNativeInstall(install)
        ? (install.configFile ?? resolveConfigPath(env))
        : undefined,
    }
  }
  const configPath = resolveConfigPath(env)
  const port = resolveLocalPort(env, configPath)
  return {
    kind: 'local',
    endpoint: toLocalEndpoint(port),
    port,
    adminKey: toAdminKeyLookup(resolveAdminKey(env, resolveAdminKeyPath(configPath)), configPath),
    install: undefined,
    configPath,
  }
}

async function readTargetAdminKey(target: Target, record: InstallRecord): Promise<AdminKeyLookup> {
  try {
    return { kind: 'found', adminKey: await target.readAdminKey(record) }
  } catch (error) {
    return { kind: 'missing', message: error instanceof Error ? error.message : String(error) }
  }
}

function toAdminKeyLookup(
  token: ReturnType<typeof resolveAdminKey>,
  configPath: string,
): AdminKeyLookup {
  switch (token.kind) {
    case 'token':
      return { kind: 'found', adminKey: token.token }
    case 'unusable':
      return { kind: 'missing', message: token.message }
    case 'none':
      return {
        kind: 'missing',
        message: `no admin key in ${JSON.stringify(resolveAdminKeyPath(configPath))} yet; start the service once so it writes one`,
      }
  }
}

/** `JAYPOST_PORT` when valid, else the config file's port, else the default. Never throws. */
function resolveLocalPort(env: NodeJS.ProcessEnv, configPath: string): number {
  const raw = findEnvValue(env, PORT_ENV_VAR)
  const envPort = raw !== undefined && PORT_PATTERN.test(raw) ? Number(raw) : undefined
  if (envPort !== undefined && envPort >= 1 && envPort <= 65_535) {
    return envPort
  }
  try {
    return readConfigFile(configPath).port ?? DEFAULT_PORT
  } catch {
    // An unreadable config: the service couldn't start from it either, so the default it is.
    return DEFAULT_PORT
  }
}
