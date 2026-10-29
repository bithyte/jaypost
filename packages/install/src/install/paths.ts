import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveConfigDirectory } from '@jaypost/store'
import { LAUNCHD_LABEL } from './constants.ts'
import type { InstallPaths } from './types.ts'

function toNonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

/** Where each target keeps its files, derived from the env; touches no files. */
export function resolveInstallPaths(env: NodeJS.ProcessEnv = process.env): InstallPaths {
  const home = toNonEmpty(env.HOME) ?? homedir()
  const configDirectory = resolveConfigDirectory(env)
  const xdgConfigHome = toNonEmpty(env.XDG_CONFIG_HOME) ?? join(home, '.config')
  const xdgDataHome = toNonEmpty(env.XDG_DATA_HOME) ?? join(home, '.local', 'share')
  return {
    configDirectory,
    configFile: join(configDirectory, 'config.json'),
    installFile: join(configDirectory, 'install.json'),
    composeDirectory: join(configDirectory, 'compose'),
    quadletDirectory: join(configDirectory, 'quadlet'),
    systemdUnit: join(xdgConfigHome, 'systemd', 'user', 'jaypost.service'),
    quadletUnit: join(xdgConfigHome, 'containers', 'systemd', 'jaypost.container'),
    userNpmPrefix: join(xdgDataHome, 'jaypost', 'npm'),
    binaryCopy: join(home, '.local', 'bin', 'jaypost'),
    launchdPlist: join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`),
    launchdLogFile: join(home, 'Library', 'Logs', 'jaypost', 'jaypost.log'),
  }
}
