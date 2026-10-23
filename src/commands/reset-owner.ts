import { describeUnauthorized } from '../client/index.ts'
import { findExistingInstall, resolveRecordProvider } from '../install/index.ts'
import { findOwnerSetting, requireProvider } from '../provider/index.ts'
import type { Provider } from '../provider/index.ts'
import { runStep } from '../progress/index.ts'
import { PromptAborted } from './prompts.ts'
import type { ResetOwnerDeps, WaitResult } from './types.ts'

/**
 * Unlinks the paired owner, restarts the service and waits for a new pairing. Returns 0 on success
 * or if the user declines, 1 on failure, not installed or a provider that doesn't pair, 130 on
 * interrupt.
 */
export async function runResetOwner(deps: ResetOwnerDeps): Promise<number> {
  const print = deps.progress.note
  const existing = findExistingInstall(deps.paths, deps.targets)
  if (!existing) {
    print('Not installed. Run "jaypost init".')
    return 1
  }
  const { record } = existing
  if (deps.token.kind === 'unusable') {
    print(deps.token.message)
    return 1
  }
  const target = deps.targets[record.target]
  let provider: Provider
  try {
    provider = requireProvider(deps.providers, resolveRecordProvider(record))
  } catch (error) {
    print(error instanceof Error ? error.message : String(error))
    return 1
  }
  const warning = provider.setup.text.resetOwnerWarning
  if (findOwnerSetting(provider) === undefined || warning === undefined) {
    print(`${provider.label} doesn't support re-pairing.`)
    return 1
  }
  const stepOptions = deps.signal ? { signal: deps.signal } : {}
  try {
    if (!(await deps.confirm(`${warning} Continue?`, false))) {
      return 0
    }
    deps.progress.plan([
      'Clearing the owner',
      'Restarting the service',
      'Waiting for the service to start',
      'Waiting for pairing',
    ])
    await runStep(deps.progress, 'Clearing the owner', () => target.clearOwner(record), {
      ...stepOptions,
      settle: (step) => step.succeed('Cleared the owner'),
    })
    await runStep(deps.progress, 'Restarting the service', () => target.restart(record), {
      ...stepOptions,
      settle: (step) => step.succeed('Restarted the service'),
    })
  } catch (error) {
    if (error instanceof PromptAborted || deps.signal?.aborted) {
      print('')
      return 130
    }
    print(`Reset failed. ${target.logsHint(record)}`)
    return 1
  }
  let result: WaitResult
  try {
    result = await deps.wait({
      port: record.port,
      isRunning: () => target.isRunning(record),
      logsHint: target.logsHint(record),
      ...(deps.token.kind === 'token' ? { token: deps.token.token } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
      progress: deps.progress,
    })
  } catch {
    if (deps.signal?.aborted) {
      print('')
      return 130
    }
    print(`Waiting for pairing failed. ${target.logsHint(record)}`)
    return 1
  }
  if (result === 'paired') {
    print('Paired. Try it: jaypost test')
    return 0
  }
  if (result === 'interrupted') {
    return 130
  }
  if (result === 'unauthorized') {
    print(describeUnauthorized(deps.token.kind === 'token'))
    return 1
  }
  print(target.logsHint(record))
  return 1
}
