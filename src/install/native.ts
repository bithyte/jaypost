import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { removeAuditFiles, resolveAuditPath } from '../audit/index.ts'
import { readConfigFile, updateConfigFile } from '../config/index.ts'
import { collectSettings, DEFAULT_PROVIDER, findProvider } from '../provider/index.ts'
import type { Provider } from '../provider/index.ts'
import { resolveStatePath } from '../state/index.ts'
import { isMissingFileError } from '../system/index.ts'
import { EXECUTABLE_MODE, PACKAGE_NAME, PATH_HINT } from './constants.ts'
import type {
  CliCommand,
  CliLocation,
  InstallOptions,
  InstallPaths,
  InstallRecord,
  Secrets,
  TargetDeps,
} from './types.ts'

function isUnder(file: string, root: string): boolean {
  return root !== '' && file.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** Copies `source` over `destination` via a temp file and rename, so a running copy is never half-written. */
function copyExecutable(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true })
  const temp = `${destination}.${process.pid}.tmp`
  try {
    copyFileSync(source, temp)
    // chmod after copying: the umask can strip bits at creation.
    chmodSync(temp, EXECUTABLE_MODE)
    renameSync(temp, destination)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/** What sits at `path` without following links; `missing` when nothing does. */
function inspectEntry(path: string): 'missing' | 'symlink' | 'file' | 'other' {
  let stats
  try {
    stats = lstatSync(path)
  } catch (error) {
    if (isMissingFileError(error)) {
      return 'missing'
    }
    throw error
  }
  if (stats.isSymbolicLink()) {
    return 'symlink'
  }
  return stats.isFile() ? 'file' : 'other'
}

function isWritable(directory: string): boolean {
  try {
    accessSync(directory, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * `null` for every config key other providers use, so switching providers drops the old settings.
 */
function formatOtherProviderKeys(
  providers: readonly Provider[],
  current: Provider,
): Readonly<Record<string, null>> {
  const ownKeys = new Set(current.settings.map((setting) => setting.configKey))
  const keys = providers
    .filter((provider) => provider.name !== current.name)
    .flatMap((provider) => provider.settings.map((setting) => setting.configKey))
    .filter((key) => !ownKeys.has(key))
  return Object.fromEntries(keys.map((key) => [key, null]))
}

/** The config file a service install uses when nothing recorded one: $JAYPOST_CONFIG or the default, absolute. */
export function resolveDefaultConfigFile(paths: InstallPaths, env: NodeJS.ProcessEnv): string {
  return resolve(env.JAYPOST_CONFIG || paths.configFile)
}

/**
 * Provider named in the config file (Telegram when absent) and its settings; settings are empty for
 * an unknown provider. Throws on a corrupt config file.
 */
export function readConfigSecrets(path: string, providers: readonly Provider[]): Secrets {
  const config = readConfigFile(path)
  const name = config.provider ?? DEFAULT_PROVIDER
  const provider = findProvider(providers, name)
  if (provider === undefined) {
    return { provider: name, settings: {} }
  }
  return {
    provider: name,
    settings: collectSettings(provider, (setting) => config[setting.configKey]),
  }
}

/** Why a standalone binary can't be copied to the binary path (a symlink there is npm's launcher), or undefined. */
export function findBinaryCopyConflict(paths: InstallPaths, cli: CliLocation): string | undefined {
  if (cli.kind === 'binary' && inspectEntry(paths.binaryCopy) === 'symlink') {
    return `~/.local/bin/${PACKAGE_NAME} is a symlink (npm's launcher?); run "npm rm -g ${PACKAGE_NAME}" first`
  }
  return undefined
}

/** Installs or locates the CLI; `words` is what the service execs before `start`. */
export async function resolveCliCommand(
  deps: TargetDeps,
  cli: CliLocation,
  options: InstallOptions,
): Promise<CliCommand> {
  const { exec, paths } = deps
  const fallbackRoot = join(paths.userNpmPrefix, 'lib', 'node_modules')
  async function resolveCli(selfPath: string): Promise<string> {
    const root = (await exec('npm', ['root', '-g'])).stdout.trim()
    if (isUnder(selfPath, root)) {
      options.print(`Using the installed CLI at ${selfPath}`)
      return selfPath
    }
    if (isUnder(selfPath, fallbackRoot)) {
      options.print(`Using the installed CLI at ${selfPath}`)
      return selfPath
    }
    const packageSpec = options.tarball ?? `${PACKAGE_NAME}@${options.version}`
    const prefix = (await exec('npm', ['prefix', '-g'])).stdout.trim()
    let installRoot: string
    let args: string[]
    if (prefix !== '' && isWritable(prefix)) {
      options.print(`Installing ${packageSpec} globally with npm`)
      args = ['i', '-g', packageSpec]
      installRoot = root
    } else {
      options.print(
        `Global npm prefix isn't writable; installing ${packageSpec} into ${paths.userNpmPrefix}`,
      )
      mkdirSync(paths.userNpmPrefix, { recursive: true })
      args = ['i', '-g', '--prefix', paths.userNpmPrefix, packageSpec]
      installRoot = fallbackRoot
    }
    const result = await exec(
      'npm',
      args,
      options.output === undefined ? undefined : { onOutput: options.output },
    )
    if (result.code !== 0) {
      throw new Error(`npm install failed: ${result.stderr.trim()}`)
    }
    return join(installRoot, PACKAGE_NAME, 'dist', 'cli.js')
  }
  if (cli.kind === 'npm') {
    // A leftover binary copy would shadow npm's launcher on PATH; a symlink there is npm's own.
    if (inspectEntry(paths.binaryCopy) === 'file') {
      options.print(`Removing the old standalone binary at ${paths.binaryCopy}`)
      rmSync(paths.binaryCopy, { force: true })
    }
    const cliPath = await resolveCli(cli.selfPath)
    return { cliPath, words: [cli.nodePath, cliPath] }
  }
  if (resolve(cli.binaryPath) !== resolve(paths.binaryCopy)) {
    options.print(`Copying ${cli.binaryPath} to ${paths.binaryCopy}`)
    copyExecutable(cli.binaryPath, paths.binaryCopy)
  }
  return { cliPath: paths.binaryCopy, words: [paths.binaryCopy] }
}

/** Writes the install's provider settings and port to the config file; the owner is only touched when one is given. */
export function writeServiceConfig(
  configFile: string,
  providers: readonly Provider[],
  options: InstallOptions,
): void {
  // Only touch the owner when we have one; clearOwner is the explicit way to drop it.
  updateConfigFile(configFile, {
    ...formatOtherProviderKeys(providers, options.provider),
    provider: options.provider.name,
    port: options.port,
    ...options.settings,
    apiToken: options.auth.kind === 'token' ? options.auth.token : null,
  })
}

/** Prints the PATH hint for a standalone binary when ~/.local/bin isn't on PATH. */
export function printPathHint(
  deps: TargetDeps,
  cli: CliLocation,
  print: (text: string) => void,
): void {
  const directory = dirname(deps.paths.binaryCopy)
  const isOnPath = (deps.env.PATH ?? '')
    .split(delimiter)
    .some((entry) => entry !== '' && resolve(entry) === resolve(directory))
  if (cli.kind === 'binary' && !isOnPath) {
    print(PATH_HINT)
  }
}

/**
 * Deletes config, state, audit files and the binary copy; for an npm install prints how to remove
 * the package.
 */
export function purgeServiceFiles(
  record: InstallRecord,
  configFile: string,
  paths: InstallPaths,
  print: (text: string) => void = (text) => console.log(text),
): void {
  rmSync(configFile, { force: true })
  rmSync(resolveStatePath(configFile), { force: true })
  removeAuditFiles(resolveAuditPath(configFile))
  if (record.cliKind === 'binary') {
    if (record.cliPath !== undefined) {
      rmSync(record.cliPath, { force: true })
    }
    return
  }
  const fallbackRoot = join(paths.userNpmPrefix, 'lib', 'node_modules')
  const prefix =
    record.cliPath !== undefined && isUnder(record.cliPath, fallbackRoot)
      ? `--prefix ${paths.userNpmPrefix} `
      : ''
  print(`The npm package was left in place; remove it with: npm rm -g ${prefix}${PACKAGE_NAME}`)
}
