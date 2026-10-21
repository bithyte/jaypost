import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { readAuditFiles, resolveAuditPath } from '../audit/index.ts'
import { updateConfigFile } from '../config/index.ts'
import { ensureLinger, MissingCommandError } from '../system/index.ts'
import {
  CONFIG_ENV_PREFIX,
  ENVIRONMENT_LINE_PATTERN,
  ESCAPED_CHAR_PATTERN,
  EXEC_START_LINE_PATTERN,
  SERVICE_NAME,
} from './constants.ts'
import {
  findBinaryCopyConflict,
  printPathHint,
  purgeServiceFiles,
  readConfigSecrets,
  resolveCliCommand,
  resolveDefaultConfigFile,
  writeServiceConfig,
} from './native.ts'
import { requireRecordOwner } from './state.ts'
import { formatSystemdUnit } from './templates.ts'
import type { CliLocation, InstallRecord, Secrets, Target, TargetDeps } from './types.ts'

/** Best-effort read of the JAYPOST_CONFIG value from a unit's Environment= lines. */
export function findUnitConfigFile(unit: string): string | undefined {
  for (const line of unit.split('\n')) {
    const rawValue = ENVIRONMENT_LINE_PATTERN.exec(line)?.[1]
    if (rawValue === undefined) {
      continue
    }
    const trimmed = rawValue.trim()
    const unquoted =
      trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
        ? trimmed.slice(1, -1).replace(ESCAPED_CHAR_PATTERN, '$1')
        : trimmed
    const value = unquoted.replaceAll('%%', '%')
    if (value.startsWith(CONFIG_ENV_PREFIX) && value.length > CONFIG_ENV_PREFIX.length) {
      return resolve(value.slice(CONFIG_ENV_PREFIX.length))
    }
  }
  return undefined
}

/** Splits a unit command line into words, honoring double quotes and backslash escapes. */
function splitCommandLine(line: string): string[] {
  const words: string[] = []
  let word = ''
  let hasWord = false
  let isQuoted = false
  let isEscaped = false
  for (const char of line) {
    if (isEscaped) {
      word += char
      isEscaped = false
      continue
    }
    if (char === '\\') {
      isEscaped = true
      hasWord = true
      continue
    }
    if (char === '"') {
      isQuoted = !isQuoted
      hasWord = true
      continue
    }
    if (!isQuoted && /\s/.test(char)) {
      if (hasWord) {
        words.push(word)
      }
      word = ''
      hasWord = false
      continue
    }
    word += char
    hasWord = true
  }
  if (hasWord) {
    words.push(word)
  }
  return words
}

/**
 * The unquoted words of a unit's `ExecStart=` line minus the trailing `start`: the node path and
 * CLI script, or the binary path. Undefined without an `ExecStart=` line.
 */
export function findUnitExecWords(unit: string): readonly string[] | undefined {
  for (const line of unit.split('\n')) {
    const rawValue = EXEC_START_LINE_PATTERN.exec(line)?.[1]
    if (rawValue === undefined) {
      continue
    }
    const words = splitCommandLine(rawValue).map((word) =>
      word.replaceAll('$$', '$').replaceAll('%%', '%'),
    )
    return words.at(-1) === 'start' ? words.slice(0, -1) : words
  }
  return undefined
}

/**
 * systemd user service target running the npm-installed CLI, or a copy of the standalone binary in
 * ~/.local/bin; keeps its settings in the config file.
 */
export function createSystemdTarget(deps: TargetDeps, cli: CliLocation): Target {
  const { exec, paths, env, user, providers } = deps
  const systemctl = (...args: string[]) => exec('systemctl', ['--user', ...args])
  // The unit always pins JAYPOST_CONFIG to this absolute path, and install.json records it,
  // so later commands don't depend on the environment they happen to run in.
  const configFile = resolveDefaultConfigFile(paths, env)
  const resolveConfigFile = (record: InstallRecord) => record.configFile ?? configFile
  const target: Target = {
    name: 'systemd',
    async available() {
      const conflict = findBinaryCopyConflict(paths, cli)
      if (conflict !== undefined) {
        return { ok: false, reason: conflict }
      }
      let result: Awaited<ReturnType<typeof systemctl>>
      try {
        result = await systemctl('show-environment')
      } catch (error) {
        if (error instanceof MissingCommandError) {
          return { ok: false, reason: 'systemctl not available' }
        }
        throw error
      }
      return result.code === 0
        ? { ok: true }
        : { ok: false, reason: 'systemd user session not available' }
    },
    async install(options): Promise<InstallRecord> {
      const command = await resolveCliCommand(deps, cli, options)
      writeServiceConfig(configFile, providers, options)
      mkdirSync(dirname(paths.systemdUnit), { recursive: true })
      writeFileSync(
        paths.systemdUnit,
        formatSystemdUnit({ exec: command.words, config: configFile }),
      )
      for (const args of [['daemon-reload'], ['enable', '--now', SERVICE_NAME]]) {
        const result = await systemctl(...args)
        if (result.code !== 0) {
          throw new Error(`systemctl ${args.join(' ')} failed: ${result.stderr.trim()}`)
        }
      }
      await ensureLinger(exec, user, options.print)
      printPathHint(deps, cli, options.print)
      return {
        target: 'systemd',
        provider: options.provider.name,
        port: options.port,
        version: options.version,
        cliPath: command.cliPath,
        cliKind: cli.kind,
        configFile,
      }
    },
    async upgrade(options): Promise<InstallRecord> {
      const record = await target.install(options)
      // `enable --now` leaves an already running unit on the old command.
      await target.restart(record)
      return record
    },
    async readSecrets(record): Promise<Secrets> {
      return readConfigSecrets(resolveConfigFile(record), providers)
    },
    async remove(record, purge) {
      await systemctl('disable', '--now', SERVICE_NAME)
      rmSync(paths.systemdUnit, { force: true })
      await systemctl('daemon-reload')
      if (purge) {
        purgeServiceFiles(record, resolveConfigFile(record), paths)
      }
    },
    async restart() {
      const result = await systemctl('restart', SERVICE_NAME)
      if (result.code !== 0) {
        throw new Error(`systemctl restart failed (exit ${result.code})`)
      }
    },
    async clearOwner(record) {
      updateConfigFile(resolveConfigFile(record), {
        [requireRecordOwner(providers, record).configKey]: null,
      })
    },
    async readAuditLog(record) {
      return readAuditFiles(resolveAuditPath(resolveConfigFile(record)))
    },
    async isRunning() {
      return (await systemctl('is-active', '--quiet', SERVICE_NAME)).code === 0
    },
    logsHint() {
      return `journalctl --user -u ${SERVICE_NAME} -f`
    },
  }
  return target
}
