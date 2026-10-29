import { readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { NO_AUTH, parseToken } from '@jaypost/store'
import type { ApiAuth } from '@jaypost/store'
import {
  compareVersions,
  fetchLatestNpmVersion,
  fetchLatestRelease,
  findExistingInstall,
  findPlistExecWords,
  findUnitExecWords,
  formatAssetName,
  replaceBinary,
  resolveRecordProvider,
  writeInstall,
} from '@jaypost/install'
import type {
  ExistingInstall,
  InstallPaths,
  InstallRecord,
  LatestRelease,
  Target,
  TargetName,
} from '@jaypost/install'
import { runStep } from '../progress/index.ts'
import type { ProgressStep } from '../progress/index.ts'
import { requireProvider } from '@jaypost/core'
import type { Provider, SettingValues } from '@jaypost/core'
import type { UpdateDeps } from './types.ts'

const PACKAGE_NAME = 'jaypost'

/**
 * What step 1 brings to the latest version: a binary file, an npm package run by `nodePath`, or
 * nothing because the running CLI can't update itself (`stuck`, which is always the running CLI).
 * `isRunning` marks the CLI running `update`.
 */
type Subject =
  | { readonly kind: 'binary'; readonly path: string; readonly isRunning: boolean }
  | {
      readonly kind: 'npm'
      readonly nodePath: string
      readonly cliPath: string
      readonly isRunning: boolean
    }
  | { readonly kind: 'stuck' }

/** The latest version and, for binaries, the release to download it from. */
type Latest = { readonly version: string; readonly release?: LatestRelease }

const STUCK_SUBJECT = { kind: 'stuck' } as const satisfies Subject

function isUnder(file: string, root: string): boolean {
  return root !== '' && file.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** Runs `work` as one checklist step that succeeds titled by `describe`; see `runStep`. */
function runUpdateStep<T>(
  deps: UpdateDeps,
  title: string,
  work: (step: ProgressStep) => Promise<T>,
  describe: (value: T) => string,
): Promise<T> {
  return runStep(deps.progress, title, work, {
    settle: (step, value) => step.succeed(describe(value)),
    ...(deps.signal ? { signal: deps.signal } : {}),
  })
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resolveFallbackRoot(deps: UpdateDeps): string {
  return join(deps.paths.userNpmPrefix, 'lib', 'node_modules')
}

/** The node and CLI script the service file runs; throws when it doesn't name both. */
function readServiceNpmWords(
  deps: UpdateDeps,
  target: 'systemd' | 'launchd',
): readonly [string, string] {
  const file = target === 'systemd' ? deps.paths.systemdUnit : deps.paths.launchdPlist
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`couldn't read ${file}: ${describeError(error)}`)
  }
  const words = target === 'systemd' ? findUnitExecWords(text) : findPlistExecWords(text)
  const [nodePath, cliPath] = words ?? []
  if (nodePath === undefined || cliPath === undefined) {
    throw new Error(`couldn't find the node and CLI paths in ${file}`)
  }
  return [nodePath, cliPath]
}

/** `npm root -g`, or '' when npm is missing or fails. */
async function findNpmRoot(deps: UpdateDeps): Promise<string> {
  try {
    const result = await deps.exec('npm', ['root', '-g'])
    return result.code === 0 ? result.stdout.trim() : ''
  } catch {
    // No npm on PATH: the running CLI can't be an npm global install.
    return ''
  }
}

async function resolveRunningSubject(deps: UpdateDeps): Promise<Subject> {
  const { cli } = deps
  if (cli.kind === 'binary') {
    return { kind: 'binary', path: cli.binaryPath, isRunning: true }
  }
  const isGlobal =
    isUnder(cli.selfPath, await findNpmRoot(deps)) ||
    isUnder(cli.selfPath, resolveFallbackRoot(deps))
  if (!isGlobal) {
    return STUCK_SUBJECT
  }
  return { kind: 'npm', nodePath: cli.nodePath, cliPath: cli.selfPath, isRunning: true }
}

async function resolveSubject(
  deps: UpdateDeps,
  existing: ExistingInstall | undefined,
): Promise<Subject> {
  const target = existing?.record.target
  if (existing === undefined || (target !== 'systemd' && target !== 'launchd')) {
    return resolveRunningSubject(deps)
  }
  const { record } = existing
  if (record.cliKind === 'binary') {
    return { kind: 'binary', path: record.cliPath ?? deps.paths.binaryCopy, isRunning: false }
  }
  const [nodePath, unitCliPath] = readServiceNpmWords(deps, target)
  return { kind: 'npm', nodePath, cliPath: record.cliPath ?? unitCliPath, isRunning: false }
}

async function fetchLatest(deps: UpdateDeps, subject: Subject): Promise<Latest> {
  if (subject.kind === 'binary') {
    const release = await fetchLatestRelease(deps.releasesUrl, deps.signal)
    return { version: release.version, release }
  }
  return { version: await fetchLatestNpmVersion(deps.npmLatestUrl, deps.signal) }
}

/** The command words that run the subject's CLI. */
function formatCliWords(subject: Subject): readonly string[] {
  switch (subject.kind) {
    case 'binary':
      return [subject.path]
    case 'npm':
      return [subject.nodePath, subject.cliPath]
    case 'stuck':
      return []
  }
}

/** Whether running `words --version` prints `latest`; a CLI that fails to start doesn't. */
async function reportsVersion(
  deps: UpdateDeps,
  words: readonly string[],
  latest: string,
): Promise<boolean> {
  const [command, ...args] = words
  if (command === undefined) {
    return false
  }
  try {
    const result = await deps.exec(command, [...args, '--version'])
    return result.code === 0 && result.stdout.trim() === latest
  } catch {
    // A missing file can't report anything; step 1 replaces it.
    return false
  }
}

/** Whether the subject already reports `latest`; the running CLI is judged by its own version. */
async function reportsLatest(deps: UpdateDeps, subject: Subject, latest: string): Promise<boolean> {
  if (subject.kind === 'stuck' || subject.isRunning) {
    return compareVersions(deps.version, latest) >= 0
  }
  return reportsVersion(deps, formatCliWords(subject), latest)
}

/** Installs `latest` globally, streaming npm's output into `step`. */
async function installNpm(
  deps: UpdateDeps,
  subject: Extract<Subject, { kind: 'npm' }>,
  latest: string,
  step: ProgressStep,
): Promise<void> {
  const { cliPath } = subject
  const prefix = isUnder(cliPath, resolveFallbackRoot(deps))
    ? ['--prefix', deps.paths.userNpmPrefix]
    : []
  const result = await deps.exec('npm', ['i', '-g', ...prefix, `${PACKAGE_NAME}@${latest}`], {
    onOutput: step.output,
  })
  if (result.code !== 0) {
    throw new Error(`npm install failed: ${result.stderr.trim()}`)
  }
}

/**
 * Throws unless `cliPath` reports `latest`: npm may install into another global root (nvm, a
 * stale unit), and handing off would then run the old CLI.
 */
async function requireNpmVersion(
  deps: UpdateDeps,
  subject: Extract<Subject, { kind: 'npm' }>,
  latest: string,
): Promise<void> {
  const { nodePath, cliPath } = subject
  if (!(await reportsVersion(deps, [nodePath, cliPath], latest))) {
    throw new Error(
      `npm installed ${PACKAGE_NAME}@${latest} but ${cliPath} still reports another version`,
    )
  }
}

async function replaceSubjectBinary(
  deps: UpdateDeps,
  path: string,
  release: LatestRelease | undefined,
): Promise<void> {
  const assetName = formatAssetName(deps.platform, deps.arch)
  if (assetName === undefined) {
    throw new Error(`no binary for ${deps.platform}-${deps.arch}`)
  }
  if (release === undefined) {
    throw new Error('no GitHub release to download from')
  }
  await replaceBinary({
    release,
    assetName,
    platform: deps.platform,
    destination: path,
    exec: deps.exec,
    ...(deps.signal ? { signal: deps.signal } : {}),
  })
}

/** Runs the new CLI's `update --finish` with inherited stdio; returns its exit code. */
async function handOff(deps: UpdateDeps, subject: Subject): Promise<number> {
  const [command, ...args] = formatCliWords(subject)
  if (command === undefined) {
    throw new Error('no CLI to hand off to')
  }
  const result = await deps.exec(command, [...args, 'update', '--finish'], { inherit: true })
  if (deps.signal?.aborted) {
    return 130
  }
  if (result.code === 0 || result.code === 130) {
    return result.code
  }
  deps.progress.note(
    'The new version is in place; run "jaypost update" again or "jaypost service install".',
  )
  return result.code
}

async function update(deps: UpdateDeps): Promise<number> {
  const print = deps.progress.note
  const existing = findExistingInstall(deps.paths, deps.targets, deps.env)
  const current = existing?.record.version ?? deps.version
  const { subject, latest } = await runUpdateStep(
    deps,
    'Checking for the latest version',
    async () => {
      const resolved = await resolveSubject(deps, existing)
      return { subject: resolved, latest: await fetchLatest(deps, resolved) }
    },
    (found) =>
      compareVersions(current, found.latest.version) >= 0
        ? `Already on ${current}`
        : `Latest is ${found.latest.version}`,
  )
  if (compareVersions(current, latest.version) >= 0) {
    return 0
  }
  const isSkipped = await reportsLatest(deps, subject, latest.version)
  if (!isSkipped) {
    switch (subject.kind) {
      case 'stuck':
        print(
          `Can't update this copy; run "npx jaypost@latest update" or download the latest binary.`,
        )
        return 1
      case 'binary':
        await runUpdateStep(
          deps,
          `Installing jaypost ${latest.version}`,
          () => replaceSubjectBinary(deps, subject.path, latest.release),
          () => `Installed jaypost ${latest.version}`,
        )
        break
      case 'npm':
        await runUpdateStep(
          deps,
          `Installing jaypost ${latest.version}`,
          (step) => installNpm(deps, subject, latest.version, step),
          () => `Installed jaypost ${latest.version}`,
        )
        await runUpdateStep(
          deps,
          'Checking the new version',
          () => requireNpmVersion(deps, subject, latest.version),
          () => 'Checked the new version',
        )
        break
    }
  }
  if (existing === undefined) {
    print(`Updated jaypost ${current} -> ${latest.version}.`)
    return 0
  }
  // `npx jaypost@latest update` is already the new code: finish here, no second process.
  if (isSkipped && (subject.kind === 'stuck' || subject.isRunning)) {
    return runFinishUpdate(deps)
  }
  // An interrupt during step 1 that didn't make it throw must not start the finish child.
  deps.signal?.throwIfAborted()
  return handOff(deps, subject)
}

/**
 * Brings the installed service (or, with nothing installed, this CLI) to the latest release: gets
 * the new CLI onto the machine, then hands off to its `update --finish`, which rewrites the
 * install's files. Returns 0 on success or when already current, 1 on failure, 130 on interrupt.
 * A failed download or npm install leaves the old CLI and service untouched.
 */
export async function runUpdate(deps: UpdateDeps): Promise<number> {
  try {
    return await update(deps)
  } catch (error) {
    if (deps.signal?.aborted) {
      deps.progress.note('')
      return 130
    }
    deps.progress.note(`Update failed: ${describeError(error)}`)
    return 1
  }
}

/**
 * The token the installed service enforces, else no auth. Throws when it can't be read or isn't a
 * valid token, never quoting it: upgrading without it would quietly open the API.
 */
async function readAuth(target: Target, record: InstallRecord): Promise<ApiAuth> {
  const raw = await target.readApiToken(record)
  if (raw === undefined) {
    return NO_AUTH
  }
  const token = parseToken(raw)
  if (token === undefined) {
    throw new Error(
      `the service's API token isn't valid; run "jaypost service install" to make a new one`,
    )
  }
  return { kind: 'token', token }
}

/** The `.env` a container target rewrites on upgrade; undefined for the native targets. */
function findContainerEnvFile(paths: InstallPaths, target: TargetName): string | undefined {
  switch (target) {
    case 'quadlet':
      return join(paths.quadletDirectory, '.env')
    case 'compose':
      return join(paths.composeDirectory, '.env')
    case 'systemd':
    case 'launchd':
      return undefined
  }
}

/**
 * Throws when a container's `.env` lacks a setting the provider requires: upgrading rewrites the
 * file from what was read back, so a variable under a name jaypost doesn't read would be dropped.
 */
function requireContainerSettings(
  paths: InstallPaths,
  target: TargetName,
  provider: Provider,
  settings: SettingValues,
): void {
  const envFile = findContainerEnvFile(paths, target)
  if (envFile === undefined) {
    return
  }
  const missing = provider.settings.find(
    (setting) => setting.required && !Object.hasOwn(settings, setting.configKey),
  )
  if (missing === undefined) {
    return
  }
  throw new Error(
    `missing ${missing.envVar} in ${JSON.stringify(envFile)}; rename the variables in it to the JAYPOST_ names and run "jaypost update" again`,
  )
}

/**
 * The `update --finish` step run by the new CLI: rewrites the install's files from this version's
 * templates with the saved port, provider, secrets and API token, restarts the service and records
 * this version in install.json. A container `.env` missing a required setting is refused before
 * any file is written. Returns 0 on success, 1 when not installed or on failure, 130 on interrupt.
 */
export async function runFinishUpdate(deps: UpdateDeps): Promise<number> {
  const print = deps.progress.note
  const existing = findExistingInstall(deps.paths, deps.targets, deps.env)
  if (!existing) {
    print('Not installed.')
    return 1
  }
  const { record } = existing
  const target = deps.targets[record.target]
  try {
    const provider = requireProvider(deps.providers, resolveRecordProvider(record))
    const { settings } = await target.readSecrets(record)
    requireContainerSettings(deps.paths, record.target, provider, settings)
    const auth = await readAuth(target, record)
    if (auth.kind === 'none') {
      print(
        `The service has no API token, so it still won't require one. Run "jaypost service install" to set one.`,
      )
    }
    const next = await runUpdateStep(
      deps,
      `Updating the ${record.target} service`,
      (step) =>
        target.upgrade(
          {
            version: deps.version,
            port: record.port,
            provider,
            settings,
            auth,
            ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
            print,
            output: step.output,
          },
          record,
        ),
      () => `Updated the ${record.target} service`,
    )
    writeInstall(deps.paths.installFile, next)
    print(`Updated jaypost ${record.version} -> ${next.version}.`)
    return 0
  } catch (error) {
    if (deps.signal?.aborted) {
      print('')
      return 130
    }
    print(`Update failed: ${describeError(error)}`)
    return 1
  }
}
