import {
  generateToken,
  NO_AUTH,
  parseToken,
  readTokenFile,
  removeTokenFile,
  writeTokenFile,
} from '../auth/index.ts'
import type { ApiAuth } from '../auth/index.ts'
import { describeUnauthorized } from '../client/index.ts'
import { DEFAULT_PORT } from '../config/index.ts'
import {
  detectTargets,
  findDefaultTarget,
  findExistingInstall,
  findLeftoverSecrets,
  resolveRecordProvider,
  resolveTargetOrder,
  writeInstall,
} from '../install/index.ts'
import type { InstallRecord, Secrets, TargetName } from '../install/index.ts'
import { runStep } from '../progress/index.ts'
import { findOwnerSetting, findProvider, listSecretValues } from '../provider/index.ts'
import type { Provider } from '../provider/index.ts'
import { TARGET_LABELS } from './constants.ts'
import { PromptAborted } from './prompts.ts'
import { redact, resolveProviderSettings, selectProvider } from './provider-setup.ts'
import type { InitArgs, InitDeps } from './types.ts'

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
 * The API auth to install with: none for `--no-token`, else a valid saved token, else a new one
 * when `--token` is set or this is a fresh install, else the user's answer. An invalid saved token
 * is replaced; an unreadable token file throws.
 */
async function chooseAuth(args: InitArgs, deps: InitDeps, isReplacing: boolean): Promise<ApiAuth> {
  if (args.token === false) {
    return NO_AUTH
  }
  const raw = readTokenFile(deps.paths.tokenFile)
  if (raw !== undefined) {
    const token = parseToken(raw)
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
 * Installs or replaces the service and waits for pairing. Saves the API token before installing,
 * and removes the token file only after a tokenless install succeeds. Returns 0 on success or when
 * the user declines, 1 on failure, 130 on interrupt; error text is shown with known secrets and
 * the API token masked.
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
    deps.progress.note('Run jaypost init again. Check the logs for details.')
    return 1
  }
}

async function runInitInner(args: InitArgs, deps: InitDeps, seen: string[]): Promise<number> {
  const { progress, prompt } = deps
  const print = progress.note
  const env = deps.env ?? process.env
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
  const auth = await chooseAuth(args, deps, existing !== undefined)
  if (auth.kind === 'token') {
    seen.push(auth.token)
    // Saved first, so a failed install below reuses this token on the retry.
    writeTokenFile(deps.paths.tokenFile, auth.token)
  }
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
        ...(args.tarball === undefined ? {} : { tarball: args.tarball }),
        print,
        output: step.output,
      })
      writeInstall(deps.paths.installFile, record)
      return record
    },
    {
      settle: (step) => step.succeed(`Installed the ${name} service`),
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
  )
  if (auth.kind === 'none') {
    removeTokenFile(deps.paths.tokenFile)
  }
  // The token just chosen, never JAYPOST_TOKEN: a stale one in the shell would fail pairing.
  const result = await deps.wait({
    port,
    isRunning: () => target.isRunning(installed),
    logsHint: target.logsHint(installed),
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(auth.kind === 'token' ? { token: auth.token } : {}),
    progress,
  })
  if (result === 'paired') {
    print('Done. Try it: jaypost test')
    print('Check state: jaypost status')
    print(
      auth.kind === 'token'
        ? `API token saved to ${deps.paths.tokenFile}. Agents in containers need JAYPOST_TOKEN set to it.`
        : 'No API token: any local process can use the API.',
    )
    print(`Logs: ${target.logsHint(installed)}`)
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
