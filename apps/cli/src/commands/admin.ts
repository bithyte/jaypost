import {
  ADMIN_KEY_ENV_VAR,
  findEnvValue,
  parseToken,
  readTokenFile,
  resolveAdminKeyPath,
  resolveConfigPath,
} from '@jaypost/store'
import { AdminCaller } from '@jaypost/client'
import type { AdminResult } from '@jaypost/client'
import { resolveAdminEndpoint } from './admin-endpoint.ts'
import { PromptAborted } from './prompts.ts'
import { redact } from './provider-setup.ts'
import type { AdminDeps, AdminOutputArgs, OpenedAdmin } from './types.ts'

/** What `formatTable` puts in an empty cell. */
const EMPTY_CELL = '-'

/**
 * The admin caller for this machine or `JAYPOST_URL`; `noKey` for a local service whose admin
 * key can't be read, or `failed`. Prints nothing. Never throws.
 */
export async function openAdmin(deps: AdminDeps): Promise<OpenedAdmin> {
  const endpoint = await resolveAdminEndpoint(deps.env, deps.paths, deps.targets)
  if (endpoint.kind === 'failed') {
    return endpoint
  }
  if (endpoint.kind === 'remote') {
    const caller = new AdminCaller({ endpoint: endpoint.endpoint, adminKey: endpoint.adminKey })
    return { kind: 'opened', caller, endpoint }
  }
  if (endpoint.adminKey.kind === 'missing') {
    return { kind: 'noKey', endpoint, message: endpoint.adminKey.message }
  }
  const caller = new AdminCaller({
    endpoint: endpoint.endpoint,
    adminKey: endpoint.adminKey.adminKey,
  })
  return { kind: 'opened', caller, endpoint }
}

/** `openAdmin`'s caller, or undefined once the reason is printed. Never throws. */
export async function openAdminCaller(deps: AdminDeps): Promise<AdminCaller | undefined> {
  const opened = await openAdmin(deps)
  if (opened.kind !== 'opened') {
    deps.printError(opened.message)
    return undefined
  }
  return opened.caller
}

/**
 * Prints `result`: its value as JSON with `--json`, else `format(value)`; a failure goes to stderr.
 * Returns the exit code.
 */
export function printResult<T>(
  result: AdminResult<T>,
  args: AdminOutputArgs,
  deps: Pick<AdminDeps, 'print' | 'printError'>,
  format: (value: T) => string,
): number {
  if (result.kind === 'failed') {
    deps.printError(result.message)
    return 1
  }
  deps.print(args.json ? JSON.stringify(result.value, null, 2) : format(result.value))
  return 0
}

/** Columns padded to their widest cell, two spaces apart; an empty cell shows as `-`. */
export function formatTable(
  header: readonly string[],
  rows: readonly (readonly (string | undefined)[])[],
): string {
  const cells = [header, ...rows.map((row) => row.map((cell) => cell || EMPTY_CELL))]
  const widths = header.map((_title, column) =>
    Math.max(...cells.map((row) => (row[column] ?? '').length)),
  )
  return cells
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}

/** `count` and the noun, plural unless it's 1. */
export function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * Runs an admin command: Ctrl-C on a prompt exits 130, any other throw prints its message (with
 * the `seen` secrets masked) and exits 1.
 */
export async function runAdminCommand(
  deps: Pick<AdminDeps, 'printError' | 'signal'>,
  run: (seen: string[]) => Promise<number>,
): Promise<number> {
  // Secrets typed in while the command runs, masked in any error shown.
  const seen: string[] = []
  try {
    return await run(seen)
  } catch (error) {
    if (error instanceof PromptAborted || deps.signal?.aborted) {
      return 130
    }
    deps.printError(redact(error instanceof Error ? error.message : String(error), seen))
    return 1
  }
}

/**
 * Asks the service for a new admin key and prints it. Locally the service already wrote it to its
 * admin key file; a remote admin has to update `JAYPOST_ADMIN_KEY`.
 */
export function runAdminKeyRotate(args: AdminOutputArgs, deps: AdminDeps): Promise<number> {
  return runAdminCommand(deps, async () => {
    const opened = await openAdmin(deps)
    if (opened.kind !== 'opened') {
      deps.printError(opened.message)
      return 1
    }
    const result = await opened.caller.rotateAdminKey()
    const code = printResult(result, args, deps, (value) => `New admin key: ${value.adminKey}`)
    if (result.kind === 'failed' || args.json) {
      return code
    }
    const isEnvSet = findEnvValue(deps.env, ADMIN_KEY_ENV_VAR) !== undefined
    if (opened.endpoint.kind === 'local') {
      deps.printError(
        'The old admin key stopped working. The service saved the new one to its admin key file, where commands on this machine find it.',
      )
    } else {
      deps.printError('The old admin key stopped working.')
    }
    if (isEnvSet) {
      deps.printError(`Set ${ADMIN_KEY_ENV_VAR} to the new key.`)
    }
    return code
  })
}

/**
 * Hidden helper; runs inside containers so the CLI can read the admin key in the data volume.
 * Prints the key and returns 0, or 1 when the file is missing or invalid (never quoting it).
 */
export function runAdminKeyShow(
  env: NodeJS.ProcessEnv,
  print: (text: string) => void,
  printError: (text: string) => void,
): number {
  const path = resolveAdminKeyPath(resolveConfigPath(env))
  let raw: string | undefined
  try {
    raw = readTokenFile(path)
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error))
    return 1
  }
  if (raw === undefined) {
    printError(
      `no admin key in ${JSON.stringify(path)} yet; start the service once so it writes one`,
    )
    return 1
  }
  const key = parseToken(raw)
  if (key === undefined) {
    printError(`admin key file ${JSON.stringify(path)} isn't a valid jaypost admin key`)
    return 1
  }
  print(key)
  return 0
}
