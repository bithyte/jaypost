import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  isMissingFileError,
  MissingCommandError,
  readSeedAuditLog,
  updateConfigFile,
} from '@jaypost/store'
import {
  LAUNCHD_LABEL,
  LAUNCHD_NOT_LOADED_PATTERN,
  LAUNCHD_PID_PATTERN,
  QUARANTINE_ATTRIBUTE,
} from './constants.ts'
import { readAdminKeyFile } from './admin-key.ts'
import {
  findBinaryCopyConflict,
  printPathHint,
  purgeServiceFiles,
  readConfigApiToken,
  readConfigSecrets,
  resolveCliCommand,
  resolveDefaultConfigFile,
  writeServiceConfig,
} from './native.ts'
import { requireRecordOwner } from './state.ts'
import { formatLaunchdPlist } from './templates.ts'
import type {
  CliCommand,
  CliLocation,
  InstallOptions,
  InstallRecord,
  Secrets,
  Target,
  TargetDeps,
} from './types.ts'

/**
 * For a Homebrew Cellar node (`<prefix>/Cellar/<formula>/<version>/bin/node`), the stable
 * `<prefix>/opt/<formula>/bin/node` when it exists and is the same file; otherwise `execPath`.
 * The Cellar path goes away on `brew upgrade` and cleanup, and the agent would fail forever.
 */
export function resolveStableNodePath(execPath: string): string {
  const match = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(execPath)
  if (match === null) {
    return execPath
  }
  const stable = join(match[1] ?? '', 'opt', match[2] ?? '', 'bin', 'node')
  try {
    return realpathSync(stable) === realpathSync(execPath) ? stable : execPath
  } catch {
    // No opt link, or a dangling one: keep the path node is actually running from.
    return execPath
  }
}

function readTextFile(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) {
      return ''
    }
    throw error
  }
}

/**
 * Per-user launchd agent in the `gui/<uid>` domain running the npm-installed CLI, or a copy of the
 * standalone binary in ~/.local/bin; keeps its settings in the config file.
 */
export function createLaunchdTarget(deps: TargetDeps, cli: CliLocation): Target {
  const { exec, paths, env, providers } = deps
  const domain = `gui/${deps.uid}`
  const service = `${domain}/${LAUNCHD_LABEL}`
  const launchctl = (...args: string[]) => exec('launchctl', args)
  // Pinned in the plist and recorded in install.json, as for systemd.
  const configFile = resolveDefaultConfigFile(paths, env)
  const resolveConfigFile = (record: InstallRecord) => record.configFile ?? configFile
  async function bootout(): Promise<void> {
    const result = await launchctl('bootout', service)
    if (result.code !== 0 && !LAUNCHD_NOT_LOADED_PATTERN.test(result.stderr)) {
      throw new Error(`launchctl bootout failed: ${result.stderr.trim()}`)
    }
  }
  async function reload(): Promise<void> {
    await bootout()
    // A previous `launchctl disable` makes bootstrap fail; enable is a no-op otherwise.
    await launchctl('enable', service)
    const result = await launchctl('bootstrap', domain, paths.launchdPlist)
    if (result.code !== 0) {
      throw new Error(`launchctl bootstrap failed: ${result.stderr.trim()}`)
    }
  }
  async function clearQuarantine(): Promise<void> {
    try {
      // Fails when the attribute isn't there, which is the usual case.
      await exec('xattr', ['-d', QUARANTINE_ATTRIBUTE, paths.binaryCopy])
    } catch (error) {
      if (!(error instanceof MissingCommandError)) {
        throw error
      }
    }
  }
  /** Resolves the CLI and writes the config; returns the command and the plist to write. */
  async function prepare(options: InstallOptions): Promise<{ command: CliCommand; plist: string }> {
    const location: CliLocation =
      cli.kind === 'npm' ? { ...cli, nodePath: resolveStableNodePath(cli.nodePath) } : cli
    const command = await resolveCliCommand(deps, location, options)
    if (cli.kind === 'binary') {
      await clearQuarantine()
    }
    writeServiceConfig(configFile, providers, options)
    mkdirSync(dirname(paths.launchdLogFile), { recursive: true })
    mkdirSync(dirname(paths.launchdPlist), { recursive: true })
    const plist = formatLaunchdPlist({
      label: LAUNCHD_LABEL,
      exec: command.words,
      config: configFile,
      logFile: paths.launchdLogFile,
      exposed: options.exposed ?? false,
    })
    return { command, plist }
  }
  function toRecord(options: InstallOptions, command: CliCommand): InstallRecord {
    return {
      target: 'launchd',
      provider: options.provider.name,
      port: options.port,
      version: options.version,
      cliPath: command.cliPath,
      cliKind: cli.kind,
      configFile,
      ...(options.exposed ? { exposed: true } : {}),
    }
  }
  const target: Target = {
    name: 'launchd',
    async available() {
      if (deps.platform !== 'darwin') {
        return { ok: false, reason: 'launchd is macOS only' }
      }
      const conflict = findBinaryCopyConflict(paths, cli)
      if (conflict !== undefined) {
        return { ok: false, reason: conflict }
      }
      let code: number
      try {
        code = (await launchctl('print', domain)).code
      } catch (error) {
        if (error instanceof MissingCommandError) {
          return { ok: false, reason: 'launchctl not available' }
        }
        throw error
      }
      // The gui domain only exists while someone is logged in to the desktop.
      return code === 0
        ? { ok: true }
        : { ok: false, reason: 'no desktop session; log in on the Mac first' }
    },
    async install(options): Promise<InstallRecord> {
      const { command, plist } = await prepare(options)
      writeFileSync(paths.launchdPlist, plist)
      // Booting out first keeps a re-init from leaving the old agent running.
      await reload()
      printPathHint(deps, cli, options.print)
      return toRecord(options, command)
    },
    async upgrade(options, previousRecord): Promise<InstallRecord> {
      const upgradeOptions = { ...options, exposed: previousRecord.exposed ?? false }
      const { command, plist } = await prepare(upgradeOptions)
      const previous = readTextFile(paths.launchdPlist)
      writeFileSync(paths.launchdPlist, plist)
      // kickstart only works on a loaded agent, and a changed plist needs a fresh bootstrap.
      if (plist !== previous || (await launchctl('print', service)).code !== 0) {
        await reload()
      } else {
        await target.restart(toRecord(upgradeOptions, command))
      }
      printPathHint(deps, cli, options.print)
      return toRecord(upgradeOptions, command)
    },
    async readSecrets(record): Promise<Secrets> {
      return readConfigSecrets(resolveConfigFile(record), providers)
    },
    async remove(record, purge, print) {
      // Throws before the plist goes, so a still-loaded agent can be found and removed later.
      await bootout()
      rmSync(paths.launchdPlist, { force: true })
      if (purge) {
        purgeServiceFiles(record, resolveConfigFile(record), paths, print)
      }
    },
    async restart() {
      const result = await launchctl('kickstart', '-k', service)
      if (result.code !== 0) {
        throw new Error(`launchctl kickstart failed (exit ${result.code})`)
      }
    },
    // bootstrap/bootout rather than kickstart/kill: bootout unloads the agent, so KeepAlive can't
    // bring it back, and bootstrap is what loads it again (as install does).
    async start() {
      if ((await launchctl('print', service)).code === 0) {
        return
      }
      // A previous `launchctl disable` makes bootstrap fail; enable is a no-op otherwise.
      await launchctl('enable', service)
      const result = await launchctl('bootstrap', domain, paths.launchdPlist)
      if (result.code !== 0) {
        throw new Error(`launchctl bootstrap failed (exit ${result.code})`)
      }
    },
    async stop() {
      const result = await launchctl('bootout', service)
      if (result.code !== 0 && !LAUNCHD_NOT_LOADED_PATTERN.test(result.stderr)) {
        throw new Error(`launchctl bootout failed (exit ${result.code})`)
      }
    },
    async readApiToken(record) {
      return readConfigApiToken(resolveConfigFile(record))
    },
    async clearOwner(record) {
      await target.forgetSeedOwner(record)
    },
    // The service never writes config.json, so this is the whole of clearing the owner.
    async forgetSeedOwner(record) {
      updateConfigFile(resolveConfigFile(record), {
        [requireRecordOwner(providers, record).configKey]: null,
      })
    },
    async readAuditLog(record) {
      return readSeedAuditLog(resolveConfigFile(record))
    },
    async readAdminKey(record) {
      return readAdminKeyFile(resolveConfigFile(record))
    },
    async isRunning() {
      const result = await launchctl('print', service)
      // A pid, not `state = running`: the state reads `xpcproxy` while launchd spawns it.
      return result.code === 0 && LAUNCHD_PID_PATTERN.test(result.stdout)
    },
    logsHint() {
      return 'tail -f ~/Library/Logs/jaypost/jaypost.log'
    },
  }
  return target
}
