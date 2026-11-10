import { readInbox, removeLocal, writeInbox } from '@jaypost/store'
import { findExistingInstall, removeInstall } from '@jaypost/install'
import { runStep } from '../progress/index.ts'
import { PromptAborted } from './prompts.ts'
import type { UninstallDeps } from './types.ts'

/**
 * Removes the service after asking whether to purge the credentials, owner and question log, then
 * drops the local service and its bots from the inbox and names the new default if it
 * moved. An inbox that can't be updated is only a note. Returns 0 on success or when nothing is
 * installed, 1 on failure, 130 on interrupt.
 */
export async function runUninstall(deps: UninstallDeps): Promise<number> {
  const print = deps.progress.note
  const existing = findExistingInstall(deps.paths, deps.targets)
  if (!existing) {
    print('Not installed.')
    return 0
  }
  const { record } = existing
  try {
    const purge = await deps.confirm(
      'Also delete the saved credentials, paired owner and question log?',
      false,
    )
    const subject = purge ? 'the service and its data' : 'the service'
    // Held until the step settles: printed under the live step, they would read as part of it.
    const hints: string[] = []
    await runStep(
      deps.progress,
      `Removing ${subject}`,
      async () => {
        await deps.targets[record.target].remove(record, purge, (text) => hints.push(text))
        removeInstall(deps.paths.installFile)
      },
      {
        settle: (step) => step.succeed(`Removed ${subject}`),
        ...(deps.signal ? { signal: deps.signal } : {}),
      },
    )
    for (const hint of hints) {
      print(hint)
    }
  } catch (error) {
    if (error instanceof PromptAborted || deps.signal?.aborted) {
      print('')
      return 130
    }
    print('Uninstall failed. Check the service logs and try again.')
    return 1
  }
  forgetLocal(deps.inboxPath, print)
  print('Uninstalled.')
  return 0
}

/** Drops the local service and its bots from the inbox; says when the default moved. Never throws. */
function forgetLocal(inboxPath: string, print: (text: string) => void): void {
  try {
    const inbox = readInbox(inboxPath)
    const next = removeLocal(inbox)
    if (next === inbox) {
      return
    }
    writeInbox(inboxPath, next)
    if (next.default !== undefined && next.default !== inbox.default) {
      print(`Default bot is now "${next.default}".`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    print(`Couldn't update the inbox: ${message}`)
  }
}
