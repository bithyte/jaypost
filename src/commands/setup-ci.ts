import { MODE_ENV_VAR, PROVIDER_ENV_VAR } from '../config/index.ts'
import { DIRECT_MODE } from '../direct/index.ts'
import { findOwnerSetting } from '../provider/index.ts'
import type { Provider, ProviderRuntime, SettingValues } from '../provider/index.ts'
import { createPairingWaiter, openPairingRuntime, runCiPairing, stopRuntime } from './ci-pairing.ts'
import { SETUP_CI_SECRETS_HINT } from './constants.ts'
import { PromptAborted } from './prompts.ts'
import { redact } from './provider-setup.ts'
import type { PairingWaiter, SetupCiArgs, SetupCiDeps } from './types.ts'

/**
 * Asks for the provider and its settings, pairs the owner against an in-process bot, prints the
 * `JAYPOST_*` env vars for direct mode, then pairs as many approvers as asked for and prints their
 * `-u` flags. `approversOnly` skips the owner and the env vars. Writes no files. Returns 0 once
 * done, 1 on failure, 130 on interrupt (after printing what paired so far); error text is shown
 * with known secrets masked.
 */
export async function runSetupCi(args: SetupCiArgs, deps: SetupCiDeps): Promise<number> {
  return runCiPairing(deps, (seen) => runSetupCiInner(args, deps, seen))
}

async function runSetupCiInner(
  args: SetupCiArgs,
  deps: SetupCiDeps,
  seen: string[],
): Promise<number> {
  const { print } = deps
  const opened = await openPairingRuntime(args.provider, deps, seen)
  if (opened.kind === 'failed') {
    return 1
  }
  const { provider, settings, runtime } = opened
  try {
    const ownerSetting = findOwnerSetting(provider)
    if (args.approversOnly === true && ownerSetting === undefined) {
      print(`Setup failed: ${provider.label} has no pairing, so it has no approvers to pair`)
      return 1
    }
    const waitFor = createPairingWaiter(runtime, deps)
    if (args.approversOnly !== true && ownerSetting !== undefined) {
      const outcome = await waitFor(describeOwnerPairing(provider, runtime))
      switch (outcome.kind) {
        case 'interrupted':
          print('')
          return 130
        case 'blocked':
          print('Too many wrong pairing codes. Run jaypost setup-ci again.')
          return 1
        case 'fatal':
          print(`Setup failed: ${redact(outcome.message, seen)}`)
          return 1
        case 'paired': {
          const owner = ownerSetting.parse(outcome.senderId)
          if (owner === undefined) {
            print(`Setup failed: ${provider.label} sent an owner id jaypost can't use`)
            return 1
          }
          printEnvBlock(provider, { ...settings, [ownerSetting.configKey]: owner }, print)
        }
      }
    } else if (ownerSetting === undefined) {
      printEnvBlock(provider, settings, print)
      return 0
    }
    return await pairApprovers(runtime, waitFor, deps, seen)
  } finally {
    await stopRuntime(runtime)
  }
}

function printEnvBlock(
  provider: Provider,
  paired: SettingValues,
  print: (text: string) => void,
): void {
  print('')
  print(SETUP_CI_SECRETS_HINT)
  print(`${MODE_ENV_VAR}=${DIRECT_MODE.kind}`)
  print(`${PROVIDER_ENV_VAR}=${provider.name}`)
  for (const setting of provider.settings) {
    const value = paired[setting.configKey]
    if (value !== undefined) {
      print(`${setting.envVar}=${String(value)}`)
    }
  }
}

/** Asks "Pair an approver?" until the answer is no, printing each one that pairs. */
async function pairApprovers(
  runtime: ProviderRuntime,
  waitFor: PairingWaiter,
  deps: SetupCiDeps,
  seen: string[],
): Promise<number> {
  const { print } = deps
  const approvers: string[] = []
  const instructions = runtime.approverPairingInstructions ?? runtime.pairingInstructions
  if (instructions === undefined) {
    throw new Error('provider has no pairing support')
  }
  for (;;) {
    let wanted: boolean
    try {
      wanted = !deps.signal?.aborted && (await deps.prompt.confirm('Pair an approver?', false))
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
  print('Approvers (pass to send request):')
  print(approvers.map((id) => `-u ${id}`).join(' '))
}

function describeOwnerPairing(
  provider: Provider,
  runtime: ProviderRuntime,
): (code: string) => string {
  if (runtime.pairingInstructions === undefined) {
    throw new Error(
      `provider ${JSON.stringify(provider.name)} has an owner setting but no pairing support`,
    )
  }
  return runtime.pairingInstructions
}
