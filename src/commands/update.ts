import { readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { NO_AUTH, parseToken, readTokenFile } from '../auth/index.ts'
import type { ApiAuth } from '../auth/index.ts'
import {
  findExistingInstall,
  findPlistExecWords,
  findUnitExecWords,
  resolveRecordProvider,
  writeInstall,
} from '../install/index.ts'
import type { ExistingInstall } from '../install/index.ts'
import { requireProvider } from '../provider/index.ts'
import {
  compareVersions,
  fetchLatestNpmVersion,
  fetchLatestRelease,
  formatAssetName,
  replaceBinary,
} from '../update/index.ts'
import type { LatestRelease } from '../update/index.ts'
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

/**
 * Installs `latest` globally, then checks that `cliPath` reports it: npm may install into another
 * global root (nvm, a stale unit), and handing off would then run the old CLI.
 */
async function installNpm(
  deps: UpdateDeps,
  subject: Extract<Subject, { kind: 'npm' }>,
  latest: string,
): Promise<void> {
  const { nodePath, cliPath } = subject
  const prefix = isUnder(cliPath, resolveFallbackRoot(deps))
    ? ['--prefix', deps.paths.userNpmPrefix]
    : []
  const result = await deps.exec('npm', ['i', '-g', ...prefix, `${PACKAGE_NAME}@${latest}`])
  if (result.code !== 0) {
    throw new Error(`npm install failed: ${result.stderr.trim()}`)
  }
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
  deps.print('The new version is in place; run "jaypost update" again or "jaypost init".')
  return result.code
}

async function update(deps: UpdateDeps): Promise<number> {
  const { print } = deps
  const existing = findExistingInstall(deps.paths, deps.targets, deps.env)
  const subject = await resolveSubject(deps, existing)
  const latest = await fetchLatest(deps, subject)
  const current = existing?.record.version ?? deps.version
  if (compareVersions(current, latest.version) >= 0) {
    print(`Already on ${current}.`)
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
        await replaceSubjectBinary(deps, subject.path, latest.release)
        break
      case 'npm':
        await installNpm(deps, subject, latest.version)
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
      deps.print('')
      return 130
    }
    deps.print(`Update failed: ${describeError(error)}`)
    return 1
  }
}

/** A valid token from the token file, else no auth; an unreadable file throws. */
function readAuth(tokenFile: string): ApiAuth {
  const raw = readTokenFile(tokenFile)
  const token = raw === undefined ? undefined : parseToken(raw)
  return token === undefined ? NO_AUTH : { kind: 'token', token }
}

/**
 * The `update --finish` step run by the new CLI: rewrites the install's files from this version's
 * templates with the saved port, provider, secrets and API token, restarts the service and records
 * this version in install.json. Returns 0 on success, 1 when not installed or on failure, 130 on
 * interrupt.
 */
export async function runFinishUpdate(deps: UpdateDeps): Promise<number> {
  const { print } = deps
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
    const auth = readAuth(deps.paths.tokenFile)
    // install.json doesn't record whether the old service required a token, so always say so.
    if (auth.kind === 'none') {
      print(
        `No API token file at ${deps.paths.tokenFile}; the service will not require an API token. Run "jaypost init" to set one.`,
      )
    }
    const next = await target.upgrade(
      {
        version: deps.version,
        port: record.port,
        provider,
        settings,
        auth,
        ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
        print,
      },
      record,
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
