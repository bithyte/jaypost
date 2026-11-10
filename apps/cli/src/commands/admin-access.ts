import {
  ADMIN_KEY_ENV_VAR,
  DEFAULT_PORT,
  findEnvPort,
  findEnvValue,
  findRemote,
  parseToken,
  readInbox,
  readConfigFile,
  resolveAdminKey,
  resolveAdminKeyPath,
  resolveConfigPath,
  saveRemote,
  writeInbox,
} from '@jaypost/store'
import type { Inbox, InboxRemote } from '@jaypost/store'
import {
  ADMIN_KEY_REJECTED_MESSAGE,
  AdminCaller,
  findEnvEndpoint,
  isLoopbackEndpoint,
  LOCAL_KEY_REJECTED_MESSAGE,
  toLocalEndpoint,
  toRemoteKeyRejectedMessage,
} from '@jaypost/client'
import { findExistingInstall } from '@jaypost/install'
import type { InstallRecord, Target } from '@jaypost/install'
import { ENV_KEY_SOURCE, FILE_KEY_SOURCE, INSTALL_KEY_SOURCE, toLocalUrl } from './constants.ts'
import type {
  AdminAccess,
  AdminDeps,
  AdminEndpoint,
  AdminKeyLookup,
  AdminKeySource,
  LoadedInbox,
  OpenedAdmin,
} from './types.ts'

const ROTATED_AND_SAVED_NOTE = 'The old admin key stopped working. Saved the new one in your inbox.'

/** True for the installs whose service runs on this machine's files, not in a container. */
export function isNativeInstall(record: InstallRecord): boolean {
  return record.target === 'systemd' || record.target === 'launchd'
}

/** What finding the admin endpoint reads. */
type AdminAccessDeps = Pick<AdminDeps, 'env' | 'paths' | 'targets' | 'inboxPath' | 'service'>

/**
 * The admin caller for the service `resolveAdminEndpoint` picks; `noKey` for a service whose admin
 * key can't be found, or `failed`. Prints nothing. Never throws.
 */
export async function openAdmin(deps: AdminAccessDeps): Promise<OpenedAdmin> {
  const endpoint = await resolveAdminEndpoint(deps)
  if (endpoint.kind === 'failed') {
    return endpoint
  }
  if (endpoint.adminKey.kind === 'missing') {
    return { kind: 'noKey', endpoint, message: endpoint.adminKey.message }
  }
  const caller = new AdminCaller({
    endpoint: endpoint.endpoint,
    adminKey: endpoint.adminKey.adminKey,
    rejectedMessage: describeRejectedKey(endpoint.adminKey.source),
  })
  return { kind: 'opened', caller, endpoint, keySource: endpoint.adminKey.source }
}

// What fixes a refused key depends on where the key came from.
function describeRejectedKey(source: AdminKeySource): string {
  switch (source.kind) {
    case 'remote':
      return toRemoteKeyRejectedMessage(source.name)
    case 'install':
      return LOCAL_KEY_REJECTED_MESSAGE
    case 'env':
    case 'keyFile':
      return ADMIN_KEY_REJECTED_MESSAGE
  }
}

/**
 * Writes a rotated key to the inbox entry its key came through: the named remote, or `local` for
 * the install. `JAYPOST_URL` and a service run by hand have no entry, so the inbox stays as it is.
 * Returns the lines that tell the admin what happened. Throws when the inbox can't be read or
 * written.
 */
export function saveRotatedKey(
  access: AdminAccess,
  adminKey: string,
  inboxPath: string,
): readonly string[] {
  const note = writeRotatedKey(access, adminKey, inboxPath)
  return access.keySource.kind === 'env'
    ? [note, `Set ${ADMIN_KEY_ENV_VAR} to the new key.`]
    : [note]
}

function writeRotatedKey(access: AdminAccess, adminKey: string, inboxPath: string): string {
  const { endpoint, keySource } = access
  if (keySource.kind === 'remote') {
    const inbox = readInbox(inboxPath)
    const remote = findRemote(inbox, keySource.name)
    if (remote !== undefined) {
      writeInbox(inboxPath, saveRemote(inbox, { ...remote, adminKey }))
    }
    return ROTATED_AND_SAVED_NOTE
  }
  if (endpoint.kind === 'remote') {
    return 'The old admin key stopped working.'
  }
  if (endpoint.install === undefined) {
    return 'The old admin key stopped working. The service saved the new one to its admin key file, where commands on this machine find it.'
  }
  const inbox = readInbox(inboxPath)
  writeInbox(inboxPath, withLocalKey(inbox, endpoint.port, adminKey))
  return ROTATED_AND_SAVED_NOTE
}

function withLocalKey(inbox: Inbox, port: number, adminKey: string): Inbox {
  return { ...inbox, local: { url: inbox.local?.url ?? toLocalUrl(port).href, adminKey } }
}

/** True when an invite made through `access` would work from another machine. */
export function isInviteAllowed(access: AdminAccess): boolean {
  const { endpoint, keySource } = access
  if (endpoint.kind !== 'remote') {
    return false
  }
  // An env-mode JAYPOST_URL on this machine is the local service in disguise; a named remote is
  // the user's choice (a tunnel, say) and stays allowed.
  return (
    keySource.kind === 'remote' ||
    (endpoint.endpoint.kind === 'url' && !isLoopbackEndpoint(endpoint.endpoint.url))
  )
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

/** The inbox at `inboxPath`, or failed with a message naming the file (never a value). */
export function loadInbox(inboxPath: string): LoadedInbox {
  try {
    return { kind: 'loaded', inbox: readInbox(inboxPath) }
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Where the admin commands go: the remote `-s` names; else `JAYPOST_URL` with
 * `JAYPOST_ADMIN_KEY`; else the local install's port, with the key from `JAYPOST_ADMIN_KEY`, the
 * inbox, or the install's target (then saved to the inbox); else the inbox's only remote; else, with
 * no remotes, 127.0.0.1 on `JAYPOST_PORT` or the config's port with the key from
 * `JAYPOST_ADMIN_KEY` or the admin key file next to the config; else failed asking for `-s`.
 * A corrupt inbox fails naming it. Never throws; never quotes a key.
 */
async function resolveAdminEndpoint(deps: AdminAccessDeps): Promise<AdminEndpoint> {
  const loaded = loadInbox(deps.inboxPath)
  if (loaded.kind === 'failed') {
    return loaded
  }
  const { inbox } = loaded
  if (deps.service !== undefined) {
    return resolveNamedRemote(inbox, deps.service)
  }
  const { env, paths, targets } = deps
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
          : { kind: 'found', adminKey: envKey, source: ENV_KEY_SOURCE },
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
          ? await resolveInstallAdminKey(inbox, deps.inboxPath, targets[install.target], install)
          : { kind: 'found', adminKey: envKey, source: ENV_KEY_SOURCE },
      install,
      configPath: isNativeInstall(install)
        ? (install.configFile ?? resolveConfigPath(env))
        : undefined,
    }
  }
  const [onlyRemote, ...otherRemotes] = inbox.remotes
  if (onlyRemote !== undefined && otherRemotes.length === 0) {
    return toRemoteEndpoint(onlyRemote)
  }
  if (onlyRemote !== undefined) {
    return {
      kind: 'failed',
      message: `several remotes; pick one with -s: ${inbox.remotes.map((each) => each.name).join(', ')}`,
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

/** The remote `-s` names, or failed listing the known names. */
function resolveNamedRemote(inbox: Inbox, name: string): AdminEndpoint {
  const remote = findRemote(inbox, name)
  if (remote !== undefined) {
    return toRemoteEndpoint(remote)
  }
  const hint =
    inbox.remotes.length === 0
      ? 'add one with "jaypost admin remote add"'
      : `known: ${inbox.remotes.map((each) => each.name).join(', ')}`
  return { kind: 'failed', message: `no remote "${name}"; ${hint}` }
}

function toRemoteEndpoint(remote: InboxRemote): AdminEndpoint {
  return {
    kind: 'remote',
    endpoint: { kind: 'url', url: new URL(remote.url) },
    adminKey: {
      kind: 'found',
      adminKey: remote.adminKey,
      source: { kind: 'remote', name: remote.name },
    },
  }
}

/**
 * The local install's admin key: the inbox's copy, else the target's, which is then saved to the
 * inbox so later commands skip the target.
 */
async function resolveInstallAdminKey(
  inbox: Inbox,
  inboxPath: string,
  target: Target,
  record: InstallRecord,
): Promise<AdminKeyLookup> {
  const saved = inbox.local?.adminKey
  if (saved !== undefined) {
    return { kind: 'found', adminKey: saved, source: INSTALL_KEY_SOURCE }
  }
  const read = await readTargetAdminKey(target, record)
  if (read.kind === 'missing') {
    return read
  }
  try {
    writeInbox(inboxPath, withLocalKey(inbox, record.port, read.adminKey))
  } catch {
    // The inbox only saves a lookup; the key just read works without it.
  }
  return read
}

async function readTargetAdminKey(target: Target, record: InstallRecord): Promise<AdminKeyLookup> {
  try {
    return {
      kind: 'found',
      adminKey: await target.readAdminKey(record),
      source: INSTALL_KEY_SOURCE,
    }
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
      return {
        kind: 'found',
        adminKey: token.token,
        source: token.source === 'env' ? ENV_KEY_SOURCE : FILE_KEY_SOURCE,
      }
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
  const envPort = findEnvPort(env)
  if (envPort !== undefined) {
    return envPort
  }
  try {
    return readConfigFile(configPath).port ?? DEFAULT_PORT
  } catch {
    // An unreadable config: the service couldn't start from it either, so the default it is.
    return DEFAULT_PORT
  }
}
