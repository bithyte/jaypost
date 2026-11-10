import { findExistingInstall } from '@jaypost/install'
import type { ServiceControlDeps } from './types.ts'

/** Printed by `service start` and `service stop` when nothing is installed. */
const NOT_INSTALLED_MESSAGE = 'Not installed. Run "jaypost service install".'

/**
 * Starts the installed service through its target; a running one is left as is. Returns 0 on
 * success, 1 when nothing is installed or the target fails.
 */
export function runServiceStart(deps: ServiceControlDeps): Promise<number> {
  return controlService(deps, 'start', 'Started.')
}

/**
 * Stops the installed service through its target, keeping its files. Returns 0 on success, 1 when
 * nothing is installed or the target fails.
 */
export function runServiceStop(deps: ServiceControlDeps): Promise<number> {
  return controlService(deps, 'stop', 'Stopped.')
}

async function controlService(
  deps: ServiceControlDeps,
  verb: 'start' | 'stop',
  done: string,
): Promise<number> {
  const existing = findExistingInstall(deps.paths, deps.targets)
  if (!existing) {
    deps.printError(NOT_INSTALLED_MESSAGE)
    return 1
  }
  const { record } = existing
  try {
    await deps.targets[record.target][verb](record)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    deps.printError(`Couldn't ${verb} the service: ${message}`)
    return 1
  }
  deps.print(done)
  return 0
}
