import { MODE_ENV_VAR, PROVIDER_ENV_VAR } from '../config/index.ts'
import { DIRECT_MODE } from '../direct/index.ts'
import { formatCode, generateCode, Pairing } from '../pairing/index.ts'
import { findOwnerSetting, findProvider, listSecretValues } from '../provider/index.ts'
import type { Provider, ProviderRuntime, SettingValues } from '../provider/index.ts'
import { BLOCKED_PAIRING, INTERRUPTED_PAIRING, SETUP_CI_SECRETS_HINT } from './constants.ts'
import { PromptAborted } from './prompts.ts'
import { findDisplayName, isComplete, promptSettings, redact } from './settings-prompt.ts'
import type { OwnerPairing, SetupCiArgs, SetupCiDeps } from './types.ts'

/**
 * Asks for the provider and its settings, pairs the owner against an in-process bot, then prints
 * the `JAYPOST_*` env vars for direct mode. Writes no files. Returns 0 once the env vars are
 * printed, 1 on failure, 130 on interrupt; error text is shown with known secrets masked.
 */
export async function runSetupCi(args: SetupCiArgs, deps: SetupCiDeps): Promise<number> {
  // Every secret value setup-ci has seen, so error messages can be shown with them masked.
  const seen: string[] = []
  try {
    return await runSetupCiInner(args, deps, seen)
  } catch (error) {
    if (error instanceof PromptAborted || deps.signal?.aborted) {
      deps.print('')
      return 130
    }
    const message = error instanceof Error ? error.message : String(error)
    deps.print(`Setup failed: ${redact(message, seen)}`)
    return 1
  }
}

async function runSetupCiInner(
  args: SetupCiArgs,
  deps: SetupCiDeps,
  seen: string[],
): Promise<number> {
  const { print } = deps
  const provider = await chooseProvider(args, deps)
  if (provider === undefined) {
    print(`Unknown provider "${args.provider}".`)
    return 1
  }
  const isPrompted = provider.settings.some((setting) => setting.prompt !== undefined)
  let settings: SettingValues | undefined
  while (settings === undefined) {
    if (deps.signal?.aborted) {
      throw new PromptAborted()
    }
    // Nothing to ask for, so asking again can't change the answer.
    if (!isPrompted) {
      print(provider.setup.text.rejected)
      return 1
    }
    const candidate = await promptSettings(provider, deps.prompt, deps.signal)
    seen.push(...listSecretValues(provider, candidate))
    if (isComplete(provider, candidate) && (await findDisplayName(provider, candidate))) {
      settings = candidate
    } else {
      print(provider.setup.text.rejected)
    }
  }
  const runtime = provider.createRuntime(settings, deps.log ?? ((line) => console.error(line)))
  let paired: SettingValues
  try {
    const check = await runtime.checkCredentials()
    if (!check.ok) {
      print(`Setup failed: ${check.reason}`)
      return 1
    }
    const ownerSetting = findOwnerSetting(provider)
    if (ownerSetting === undefined) {
      paired = settings
    } else {
      const outcome = await pairOwner(provider, runtime, deps)
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
          paired = { ...settings, [ownerSetting.configKey]: owner }
        }
      }
    }
  } finally {
    await stopRuntime(runtime)
  }
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
  return 0
}

/**
 * The provider from `--provider`, the only registered one, or the user's pick (defaulting to the
 * first). Undefined when `--provider` names an unregistered one.
 */
async function chooseProvider(args: SetupCiArgs, deps: SetupCiDeps): Promise<Provider | undefined> {
  const { providers } = deps
  if (args.provider !== undefined) {
    return findProvider(providers, args.provider)
  }
  const [first, second] = providers
  if (first === undefined) {
    throw new Error('no provider is registered')
  }
  if (second === undefined) {
    return first
  }
  const chosen = await deps.prompt.select(
    'Which chat app should the bot use?',
    providers.map((provider) => ({ value: provider.name, label: provider.label })),
    first.name,
  )
  return findProvider(providers, chosen)
}

/**
 * Shows a pairing code and starts the runtime with handlers that only pair, until someone pairs,
 * someone is blocked, the provider fails or `deps.signal` aborts.
 */
async function pairOwner(
  provider: Provider,
  runtime: ProviderRuntime,
  deps: SetupCiDeps,
): Promise<OwnerPairing> {
  if (runtime.pairingInstructions === undefined) {
    throw new Error(
      `provider ${JSON.stringify(provider.name)} has an owner setting but no pairing support`,
    )
  }
  const { signal } = deps
  if (signal?.aborted) {
    return INTERRUPTED_PAIRING
  }
  const code = (deps.generateCode ?? generateCode)()
  deps.print(`Pairing code: ${formatCode(code)}`)
  deps.print(runtime.pairingInstructions(code))
  const pairing = new Pairing(code)
  let onAbort: (() => void) | undefined
  try {
    return await new Promise<OwnerPairing>((resolve) => {
      onAbort = () => resolve(INTERRUPTED_PAIRING)
      signal?.addEventListener('abort', onAbort, { once: true })
      runtime.start({
        answer: () => 'expired',
        reply: () => 'expired',
        dismiss: () => false,
        pair: (senderId, text) => {
          const result = pairing.attempt(senderId, text)
          if (result === 'paired') {
            resolve({ kind: 'paired', senderId })
          } else if (result === 'blocked') {
            resolve(BLOCKED_PAIRING)
          }
          return result
        },
        commands: [],
        command: () => undefined,
        fatal: (message) => resolve({ kind: 'fatal', message }),
      })
    })
  } finally {
    if (onAbort !== undefined) {
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

async function stopRuntime(runtime: ProviderRuntime): Promise<void> {
  try {
    await runtime.stop()
  } catch {
    // Stopping is best effort, and the error could carry provider details we don't want shown.
  }
}
