import {
  ADMIN_KEY_ENV_VAR,
  findEnvValue,
  findRemote,
  readBook,
  resolveConfigPath,
  saveRemote,
  writeBook,
} from '@jaypost/store'
import { readAdminKeyFile } from '@jaypost/install'
import type { AdminResult } from '@jaypost/client'
import { openAdmin } from './admin-access.ts'
import { PromptAborted } from './prompts.ts'
import { redact } from './provider-setup.ts'
import { toLocalUrl } from './constants.ts'
import type { AdminDeps, AdminOutputArgs, ReachableEndpoint } from './types.ts'

/** What `formatTable` puts in an empty cell. */
const EMPTY_CELL = '-'

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
 * Asks the service for a new admin key, prints it and writes it to the book entry it went through
 * (`local` for the install, or the named remote). With `JAYPOST_URL` the book stays as it is and
 * the admin has to update `JAYPOST_ADMIN_KEY`.
 */
export function runAdminKeyRotate(args: AdminOutputArgs, deps: AdminDeps): Promise<number> {
  return runAdminCommand(deps, async () => {
    const opened = await openAdmin(deps)
    if (opened.kind !== 'opened') {
      deps.printError(opened.message)
      return 1
    }
    const result = await opened.caller.rotateAdminKey()
    // Printed before the book write, so a failed write can't lose the only copy of the new key.
    const code = printResult(result, args, deps, (value) => `New admin key: ${value.adminKey}`)
    if (result.kind === 'failed') {
      return code
    }
    const { endpoint } = opened
    saveRotatedKey(endpoint, result.value.adminKey, deps.bookPath)
    if (args.json) {
      return code
    }
    const isSaved =
      endpoint.kind === 'remote' ? endpoint.name !== undefined : endpoint.install !== undefined
    if (isSaved) {
      deps.printError('The old admin key stopped working. Saved the new one in your contacts.')
    } else if (endpoint.kind === 'local') {
      deps.printError(
        'The old admin key stopped working. The service saved the new one to its admin key file, where commands on this machine find it.',
      )
    } else {
      deps.printError('The old admin key stopped working.')
    }
    const isEnvKey =
      findEnvValue(deps.env, ADMIN_KEY_ENV_VAR) !== undefined &&
      !(endpoint.kind === 'remote' && endpoint.name !== undefined)
    if (isEnvKey) {
      deps.printError(`Set ${ADMIN_KEY_ENV_VAR} to the new key.`)
    }
    return code
  })
}

/**
 * Writes `adminKey` to the book entry `endpoint` came from: the named remote, or `local` for the
 * install. `JAYPOST_URL` and a service run by hand have no entry, so the book stays as it is.
 */
function saveRotatedKey(endpoint: ReachableEndpoint, adminKey: string, bookPath: string): void {
  const book = readBook(bookPath)
  if (endpoint.kind === 'remote') {
    const remote = endpoint.name === undefined ? undefined : findRemote(book, endpoint.name)
    if (remote !== undefined) {
      writeBook(bookPath, saveRemote(book, { ...remote, adminKey }))
    }
    return
  }
  if (endpoint.install !== undefined) {
    const url = book.local?.url ?? toLocalUrl(endpoint.port).href
    writeBook(bookPath, { ...book, local: { url, adminKey } })
  }
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
  let key: string
  try {
    key = readAdminKeyFile(resolveConfigPath(env))
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error))
    return 1
  }
  print(key)
  return 0
}
