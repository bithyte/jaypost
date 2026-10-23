import { findOwnerSetting } from '../provider/index.ts'
import { createPairingWaiter, openPairingRuntime, runCiPairing, stopRuntime } from './ci-pairing.ts'
import { PAIRED_APPROVERS_HEADING } from './constants.ts'
import { PromptAborted } from './prompts.ts'
import { redact } from './provider-setup.ts'
import type { PairApproverArgs, PairApproverDeps, PairingWaiter } from './types.ts'

/**
 * Asks for the provider and its settings, starts an in-process bot and pairs one approver, then
 * one more for each yes to "Pair another?". Prints each id as it pairs and ends with the ids as a
 * comma list. Needs no owner and writes no files. Returns 0 once done, 1 on failure, 130 on
 * interrupt (after printing the ids so far); error text is shown with known secrets masked.
 */
export async function runPairApprover(
  args: PairApproverArgs,
  deps: PairApproverDeps,
): Promise<number> {
  return runCiPairing(deps, (seen) => runPairApproverInner(args, deps, seen))
}

async function runPairApproverInner(
  args: PairApproverArgs,
  deps: PairApproverDeps,
  seen: string[],
): Promise<number> {
  const opened = await openPairingRuntime(args.provider, deps, seen)
  if (opened.kind === 'failed') {
    return 1
  }
  const { provider, runtime } = opened
  try {
    if (findOwnerSetting(provider) === undefined) {
      deps.print(`Setup failed: ${provider.label} has no pairing, so it has no approvers to pair`)
      return 1
    }
    const instructions = runtime.approverPairingInstructions ?? runtime.pairingInstructions
    if (instructions === undefined) {
      throw new Error('provider has no pairing support')
    }
    return await pairApprovers(instructions, createPairingWaiter(runtime, deps), deps, seen)
  } finally {
    await stopRuntime(runtime)
  }
}

/** Waits for one approver, then asks "Pair another?" after each attempt until the answer is no. */
async function pairApprovers(
  instructions: (code: string) => string,
  waitFor: PairingWaiter,
  deps: PairApproverDeps,
  seen: string[],
): Promise<number> {
  const { print } = deps
  const approvers: string[] = []
  for (;;) {
    const outcome = await waitFor(instructions)
    switch (outcome.kind) {
      case 'interrupted':
        return interruptApprovers(approvers, print)
      case 'fatal':
        printApprovers(approvers, print)
        print(`Setup failed: ${redact(outcome.message, seen)}`)
        return 1
      case 'blocked':
        print('Too many wrong pairing codes for that approver.')
        break
      case 'paired':
        approvers.push(outcome.senderId)
        print(`Approver paired: ${outcome.senderId}`)
    }
    let wanted: boolean
    try {
      wanted = !deps.signal?.aborted && (await deps.prompt.confirm('Pair another?', false))
    } catch (error) {
      if (!(error instanceof PromptAborted)) {
        throw error
      }
      return interruptApprovers(approvers, print)
    }
    if (deps.signal?.aborted) {
      return interruptApprovers(approvers, print)
    }
    if (!wanted) {
      break
    }
  }
  printApprovers(approvers, print)
  return 0
}

function interruptApprovers(approvers: readonly string[], print: (text: string) => void): number {
  print('')
  printApprovers(approvers, print)
  return 130
}

function printApprovers(approvers: readonly string[], print: (text: string) => void): void {
  if (approvers.length === 0) {
    return
  }
  print(PAIRED_APPROVERS_HEADING)
  print(approvers.join(','))
}
