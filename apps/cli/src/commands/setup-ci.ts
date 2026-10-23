import { MODE_ENV_VAR, PROVIDER_ENV_VAR } from '@jaypost/store'
import { DIRECT_MODE } from '@jaypost/service'
import { findOwnerSetting } from '@jaypost/core'
import type { Provider, ProviderRuntime, SettingValues } from '@jaypost/core'
import { createPairingWaiter, openPairingRuntime, runCiPairing, stopRuntime } from './ci-pairing.ts'
import { SETUP_CI_APPROVERS_HINT, SETUP_CI_SECRETS_HINT } from './constants.ts'
import { redact } from './provider-setup.ts'
import type { SetupCiArgs, SetupCiDeps } from './types.ts'

/**
 * Asks for the provider and its settings, pairs the owner against an in-process bot, then prints
 * the `JAYPOST_*` env vars for direct mode and a hint to run `jaypost pair approver` for
 * approvers. Providers without an owner setting print the env vars with no pairing and no hint.
 * Writes no files. Returns 0 once done, 1 on failure, 130 on interrupt; error text is shown with
 * known secrets masked.
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
  const note = deps.progress.note
  const opened = await openPairingRuntime(args.provider, deps, seen)
  if (opened.kind === 'failed') {
    return 1
  }
  const { provider, settings, runtime } = opened
  try {
    const ownerSetting = findOwnerSetting(provider)
    if (ownerSetting === undefined) {
      printEnvBlock(provider, settings, print)
      return 0
    }
    const waitFor = createPairingWaiter(runtime, deps)
    const outcome = await waitFor(describeOwnerPairing(provider, runtime), OWNER_STEP_TITLES)
    switch (outcome.kind) {
      case 'interrupted':
        note('')
        return 130
      case 'blocked':
        note('Too many wrong pairing codes. Run jaypost setup-ci again.')
        return 1
      case 'fatal':
        note(`Setup failed: ${redact(outcome.message, seen)}`)
        return 1
      case 'paired': {
        const owner = ownerSetting.parse(outcome.senderId)
        if (owner === undefined) {
          note(`Setup failed: ${provider.label} sent an owner id jaypost can't use`)
          return 1
        }
        printEnvBlock(provider, { ...settings, [ownerSetting.configKey]: owner }, print)
        note('')
        note(SETUP_CI_APPROVERS_HINT)
        return 0
      }
    }
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

const OWNER_STEP_TITLES = {
  waiting: 'Waiting for the owner to pair',
  paired: 'Owner paired',
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
