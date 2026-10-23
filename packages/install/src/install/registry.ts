import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PORT, readConfigFile } from '@jaypost/store'
import { findProvider, hasRequiredSecrets } from '@jaypost/core'
import type { Provider } from '@jaypost/core'
import { PROVIDERS } from '@jaypost/providers'
import { createComposeTarget } from './compose.ts'
import { DARWIN_TARGET_ORDER, TARGET_ORDER } from './constants.ts'
import { readEnvSecrets } from './envfile.ts'
import { createLaunchdTarget } from './launchd.ts'
import { createQuadletTarget } from './quadlet.ts'
import { readInstall } from './state.ts'
import { readConfigSecrets, resolveDefaultConfigFile } from './native.ts'
import { createSystemdTarget, findUnitConfigFile } from './systemd.ts'
import type {
  CliLocation,
  DetectedTarget,
  ExistingInstall,
  InstallPaths,
  Secrets,
  Target,
  TargetDeps,
  TargetName,
} from './types.ts'

/** Builds every install target from the same dependencies. */
export function createTargets(
  deps: TargetDeps,
  cli: CliLocation,
): Readonly<Record<TargetName, Target>> {
  return {
    quadlet: createQuadletTarget(deps),
    compose: createComposeTarget(deps),
    systemd: createSystemdTarget(deps, cli),
    launchd: createLaunchdTarget(deps, cli),
  }
}

/** Target preference order for a `process.platform` value; launchd only appears on darwin. */
export function resolveTargetOrder(platform: string): readonly TargetName[] {
  return platform === 'darwin' ? DARWIN_TARGET_ORDER : TARGET_ORDER
}

/** Asks each target if it is usable, in `order` (the Linux `TARGET_ORDER` by default). */
export async function detectTargets(
  targets: Readonly<Record<TargetName, Target>>,
  order: readonly TargetName[] = TARGET_ORDER,
): Promise<readonly DetectedTarget[]> {
  const detected: DetectedTarget[] = []
  for (const name of order) {
    detected.push({ name, ...(await targets[name].available()) })
  }
  return detected
}

/** First available target in the given order, or undefined when none is usable. */
export function findDefaultTarget(detected: readonly DetectedTarget[]): TargetName | undefined {
  return detected.find((candidate) => candidate.ok)?.name
}

/**
 * Install recorded in install.json, else a legacy systemd install rebuilt from its unit file
 * (`legacy: true`); undefined when neither exists.
 */
export function findExistingInstall(
  paths: InstallPaths,
  _targets: Readonly<Record<TargetName, Target>>,
  env: NodeJS.ProcessEnv = process.env,
): ExistingInstall | undefined {
  const record = readInstall(paths.installFile)
  if (record) {
    return { record, legacy: false }
  }
  let unit: string
  try {
    unit = readFileSync(paths.systemdUnit, 'utf8')
  } catch {
    return undefined
  }
  // The legacy unit may pin its own config path; prefer it over this shell's env.
  const configFile = findUnitConfigFile(unit) ?? resolveDefaultConfigFile(paths, env)
  let port = DEFAULT_PORT
  try {
    port = readConfigFile(configFile).port ?? DEFAULT_PORT
  } catch {
    // Unreadable config: fall back to the default port.
  }
  return { record: { target: 'systemd', port, version: 'legacy', configFile }, legacy: true }
}

/**
 * Credentials and owner left behind by an uninstall that kept them (no install.json any more).
 * Only reads files; never runs a container. The first source naming a known provider with every
 * required secret wins; undefined when none does.
 */
export function findLeftoverSecrets(
  paths: InstallPaths,
  env: NodeJS.ProcessEnv = process.env,
  providers: readonly Provider[] = PROVIDERS,
): Secrets | undefined {
  const sources = [
    () => readEnvSecrets(join(paths.quadletDirectory, '.env'), providers),
    () => readEnvSecrets(join(paths.composeDirectory, '.env'), providers),
    () => readLeftoverConfigSecrets(resolveDefaultConfigFile(paths, env), providers),
  ]
  for (const read of sources) {
    const secrets = read()
    const provider = secrets === undefined ? undefined : findProvider(providers, secrets.provider)
    if (
      secrets !== undefined &&
      provider !== undefined &&
      hasRequiredSecrets(provider, secrets.settings)
    ) {
      return secrets
    }
  }
  return undefined
}

function readLeftoverConfigSecrets(
  path: string,
  providers: readonly Provider[],
): Secrets | undefined {
  try {
    return readConfigSecrets(path, providers)
  } catch {
    // Corrupt config: treat as nothing left over.
    return undefined
  }
}
