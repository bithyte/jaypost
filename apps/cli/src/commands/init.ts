import {
  DEFAULT_PORT,
  findLocalSeedBot,
  generateToken,
  LOCAL_ALIAS,
  NO_AUTH,
  parseToken,
  readInbox,
  resolveAdminKeyPath,
  resolveConfigPath,
  setLocal,
  writeInbox,
} from '@jaypost/store'
import type { ApiAuth } from '@jaypost/store'
import { describeUnauthorized } from '@jaypost/client'
import {
  detectTargets,
  findDefaultTarget,
  findExistingInstall,
  findLeftoverSecrets,
  resolveRecordProvider,
  resolveTargetOrder,
  writeInstall,
} from '@jaypost/install'
import type { InstallRecord, Secrets, TargetName } from '@jaypost/install'
import { runStep } from '../progress/index.ts'
import { findOwnerSetting, findProvider, listSecretValues } from '@jaypost/core'
import type { Provider } from '@jaypost/core'
import { isNativeInstall } from './admin-access.ts'
import { TARGET_LABELS, toLocalUrl } from './constants.ts'
import { PromptAborted } from './prompts.ts'
import { redact, resolveProviderSettings, selectProvider } from './provider-setup.ts'
import type { InitArgs, InitDeps } from './types.ts'

/** Printed before an `--exposed` install. */
const EXPOSED_WARNING =
  '--exposed listens on all interfaces over plain http; keys cross the network in the clear. Use it on a LAN or behind a TLS proxy.'

/** Secret values of `secrets` when its provider is registered; [] otherwise. */
function listKnownSecretValues(deps: InitDeps, secrets: Secrets | undefined): readonly string[] {
  const provider =
    secrets === undefined ? undefined : findProvider(deps.providers, secrets.provider)
  return provider === undefined || secrets === undefined
    ? []
    : listSecretValues(provider, secrets.settings)
}

/**
 * The provider from `--provider`, the only registered one, or the user's pick (defaulting to the
 * existing install's). Undefined when `--provider` names an unregistered one.
 */
async function chooseProvider(
  args: InitArgs,
  deps: InitDeps,
  record: InstallRecord | undefined,
): Promise<Provider | undefined> {
  if (args.provider !== undefined) {
    return findProvider(deps.providers, args.provider)
  }
  return selectProvider(
    deps.providers,
    deps.prompt.select,
    record === undefined ? undefined : resolveRecordProvider(record),
  )
}

/**
 * The API auth to install with: none for `--no-token`, else a valid token the existing install's
 * service holds (`saved`), else a new one when `--token` is set or this is a fresh install, else
 * the user's answer. An invalid saved token is replaced.
 */
async function chooseAuth(
  args: InitArgs,
  deps: InitDeps,
  isReplacing: boolean,
  saved: string | undefined,
): Promise<ApiAuth> {
  if (args.token === false) {
    return NO_AUTH
  }
  if (saved !== undefined) {
    const token = parseToken(saved)
    if (token !== undefined) {
      deps.progress.note('Reusing the saved API token.')
      return { kind: 'token', token }
    }
    deps.progress.note('The saved API token was invalid; made a new one.')
    return { kind: 'token', token: generateToken() }
  }
  if (
    args.token === true ||
    !isReplacing ||
    (await deps.prompt.confirm(
      'Require an API token? Scripts, n8n flows and agents in containers will need to send it.',
      true,
    ))
  ) {
    return { kind: 'token', token: generateToken() }
  }
  return NO_AUTH
}

/** Title of the install step: container targets build an image, the others install a service. */
function describeInstallStep(name: TargetName): string {
  return name === 'quadlet' || name === 'compose'
    ? `Building the ${name} image`
    : `Installing the ${name} service`
}

/**
 * Installs or replaces the service and waits for pairing. Reuses the API token the replaced
 * install's service holds. Right after the install is recorded, saves the local service and its
 * seed bot to the inbox; once the wait returns, adds the admin key to it (a failure there
 * is only a note). Returns 0 on success or when the user declines, 1 on failure, 130 on interrupt;
 * error text is shown with known secrets and the API token masked.
 */
export async function runInit(args: InitArgs, deps: InitDeps): Promise<number> {
  // Every secret value init has seen, so error messages can be shown with them masked.
  const seen: string[] = []
  try {
    return await runInitInner(args, deps, seen)
  } catch (error) {
    if (error instanceof PromptAborted || deps.signal?.aborted) {
      deps.progress.note('')
      return 130
    }
    const message = error instanceof Error ? error.message : String(error)
    deps.progress.note(`Install failed: ${redact(message, seen)}`)
    deps.progress.note('Run jaypost service install again. Check the logs for details.')
    return 1
  }
}

async function runInitInner(args: InitArgs, deps: InitDeps, seen: string[]): Promise<number> {
  const { progress, prompt } = deps
  const print = progress.note
  const env = deps.env ?? process.env
  if (args.exposed === true) {
    print(EXPOSED_WARNING)
  }
  // Read first, so a corrupt inbox fails the run before anything changes.
  const savedInbox = readInbox(deps.inboxPath)
  const detected = await detectTargets(
    deps.targets,
    resolveTargetOrder(deps.platform ?? process.platform),
  )
  let name: TargetName
  if (args.target) {
    const chosen = detected.find((candidate) => candidate.name === args.target)
    if (!chosen?.ok) {
      print(`Cannot use ${args.target}: ${chosen?.reason ?? 'unavailable'}`)
      return 1
    }
    name = args.target
  } else {
    const defaultName = findDefaultTarget(detected)
    if (!defaultName) {
      print('No install target is available:')
      for (const candidate of detected) {
        if (!candidate.ok) {
          print(`  ${candidate.name}: ${candidate.reason}`)
        }
      }
      return 1
    }
    name = await prompt.select(
      'Where should the bot run?',
      detected.map((candidate) => ({
        value: candidate.name,
        label: TARGET_LABELS[candidate.name],
        ...(candidate.ok ? {} : { disabled: candidate.reason }),
      })),
      defaultName,
    )
  }
  const target = deps.targets[name]
  const existing = findExistingInstall(deps.paths, deps.targets, env)
  const provider = await chooseProvider(args, deps, existing?.record)
  if (provider === undefined) {
    print(`Unknown provider "${args.provider}".`)
    return 1
  }
  const { text } = provider.setup
  let secrets: Secrets | undefined
  let record: InstallRecord | undefined
  let savedToken: string | undefined
  if (existing) {
    record = existing.record
    print(
      `Found an existing ${record.target} install (version ${record.version}, port ${record.port}).` +
        (existing.legacy ? ' It looks like a legacy install from an older setup.' : ''),
    )
    if (!(await prompt.confirm('Replace it?', true))) {
      return 0
    }
    const old = deps.targets[record.target]
    const oldName = resolveRecordProvider(record)
    if (oldName === provider.name) {
      secrets = await old.readSecrets(record)
      // Mask before anything below can fail with a reused credential in its message.
      seen.push(...listKnownSecretValues(deps, secrets))
    } else {
      const oldProvider = findProvider(deps.providers, oldName)
      const oldLabel = oldProvider?.label ?? oldName
      if (
        !(await prompt.confirm(
          `This deletes the saved ${oldLabel} settings and paired owner. Continue?`,
          false,
        ))
      ) {
        return 0
      }
      if (oldProvider !== undefined) {
        // Read only to mask them; the old provider's settings aren't carried over.
        seen.push(...listKnownSecretValues(deps, await old.readSecrets(record)))
        if (findOwnerSetting(oldProvider) !== undefined) {
          await old.clearOwner(record)
        }
      }
    }
    // Read before the remove below, while the old install's files are surely in place.
    savedToken = args.token === false ? undefined : await old.readApiToken(record)
    if (savedToken !== undefined) {
      seen.push(savedToken)
    }
    // Record a legacy install too, so a failed run below can still find its config on retry.
    if (existing.legacy) {
      writeInstall(deps.paths.installFile, record)
    }
    // Remove first: the old service may hold the port we're about to check. install.json stays
    // until the new install replaces it; remove() keeps the secrets and is safe to repeat.
    await old.remove(record, false)
  } else {
    const leftover = findLeftoverSecrets(deps.paths, env, deps.providers)
    seen.push(...listKnownSecretValues(deps, leftover))
    if (leftover?.provider === provider.name) {
      secrets = leftover
      print(text.leftoverFound)
    }
  }
  const resolved = await resolveProviderSettings({
    provider,
    saved: secrets?.provider === provider.name ? secrets.settings : {},
    prompt,
    print,
    ...(deps.signal ? { signal: deps.signal } : {}),
    seen,
  })
  if (resolved.kind === 'rejected') {
    return 1
  }
  const { settings } = resolved
  if (resolved.displayName !== undefined) {
    progress.done(`Bot token checked (${resolved.displayName})`)
  }
  const port = args.port ?? record?.port ?? DEFAULT_PORT
  if (!(await deps.isPortFree(port))) {
    print(`Port ${port} is in use. Pick another with --port.`)
    return 1
  }
  progress.done(`Port ${port} is free`)
  const auth = await chooseAuth(args, deps, existing !== undefined, savedToken)
  if (auth.kind === 'token') {
    seen.push(auth.token)
  }
  const url = toLocalUrl(port).href
  const inbox = setLocal(
    savedInbox,
    { url },
    { alias: LOCAL_ALIAS, url, ...(auth.kind === 'token' ? { key: auth.token } : {}) },
  )
  progress.plan([
    describeInstallStep(name),
    'Waiting for the service to start',
    'Waiting for pairing',
  ])
  // Recording the install is part of the step, so a failed write fails it too.
  const installed = await runStep(
    progress,
    describeInstallStep(name),
    async (step) => {
      const record = await target.install({
        version: deps.version,
        port,
        provider,
        settings,
        auth,
        ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
        ...(args.exposed === true ? { exposed: true } : {}),
        ...(args.tarball === undefined ? {} : { tarball: args.tarball }),
        print,
        output: step.output,
      })
      writeInstall(deps.paths.installFile, record)
      // Before the pairing wait, so an interrupted run still leaves a usable entry.
      writeInbox(deps.inboxPath, inbox)
      return record
    },
    {
      settle: (step) => step.succeed(`Installed the ${name} service`),
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
  )
  // The token just chosen, never JAYPOST_TOKEN: a stale one in the shell would fail pairing.
  const result = await deps.wait({
    url: toLocalUrl(port),
    isRunning: () => target.isRunning(installed),
    logsHint: target.logsHint(installed),
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(auth.kind === 'token' ? { token: auth.token } : {}),
    progress,
  })
  const adminKey = await saveAdminKey(deps, () => target.readAdminKey(installed), url, seen)
  if (result === 'paired') {
    print('Done. Try it: jaypost ping')
    print('Check state: jaypost status')
    print(
      `Your bot is saved as "${findLocalSeedBot(inbox)?.alias ?? LOCAL_ALIAS}" in ${deps.inboxPath}.`,
    )
    print(
      auth.kind === 'token'
        ? 'Agents in containers need JAYPOST_TOKEN set to its key from that file.'
        : 'No API token: any local process can use the API.',
    )
    print(
      isNativeInstall(installed)
        ? `Admin key: ${resolveAdminKeyPath(installed.configFile ?? resolveConfigPath(env))}`
        : 'Admin commands: jaypost admin key create --help',
    )
    print(`Logs: ${target.logsHint(installed)}`)
    if (args.exposed === true && adminKey !== undefined) {
      print('To manage this service from another machine, run there:')
      print('')
      print(
        `  jaypost admin remote add ${deps.hostname} http://${deps.hostname}:${port} ${adminKey}`,
      )
    }
    return 0
  }
  if (result === 'interrupted') {
    return 130
  }
  if (result === 'unauthorized') {
    print(describeUnauthorized(auth.kind === 'token'))
    return 1
  }
  print(target.logsHint(installed))
  return 1
}

/**
 * Reads the admin key the installed service wrote and adds it to the inbox's local entry; returns
 * it, or undefined after a note saying why it couldn't (a failure here doesn't fail the install).
 */
async function saveAdminKey(
  deps: InitDeps,
  readAdminKey: () => Promise<string>,
  url: string,
  seen: string[],
): Promise<string | undefined> {
  try {
    const adminKey = await readAdminKey()
    seen.push(adminKey)
    const inbox = readInbox(deps.inboxPath)
    writeInbox(deps.inboxPath, { ...inbox, local: { url, adminKey } })
    return adminKey
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    deps.progress.note(`Couldn't save the admin key to the inbox: ${redact(message, seen)}`)
    return undefined
  }
}
