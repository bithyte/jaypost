import { findProvider, listSecretValues } from '@jaypost/core'
import type { Provider, SettingValues } from '@jaypost/core'
import { PromptAborted } from './prompts.ts'
import type { ProviderSettingsOptions, ProviderSettingsResult, Prompts } from './types.ts'

/**
 * The only provider in `providers`, or the user's pick with `preselected` (else the first)
 * selected. Shared by `init` and `pnpm dev`. Throws when `providers` is empty.
 */
export async function selectProvider(
  providers: readonly Provider[],
  select: Prompts['select'],
  preselected: string | undefined,
): Promise<Provider | undefined> {
  const [first, second] = providers
  if (first === undefined) {
    throw new Error('no provider is registered')
  }
  if (second === undefined) {
    return first
  }
  const current = preselected === undefined ? undefined : findProvider(providers, preselected)
  const chosen = await select(
    'Which chat app should the bot use?',
    providers.map((provider) => ({ value: provider.name, label: provider.label })),
    current?.name ?? first.name,
  )
  return findProvider(providers, chosen)
}

/**
 * The provider's settings: `saved` when they pass its credential check, else asked for until they
 * do. A provider with no settings is accepted as is when the check passes. Rejected when there's
 * nothing to ask for and the saved settings fail. Throws PromptAborted on Ctrl-C or abort.
 */
export async function resolveProviderSettings(
  options: ProviderSettingsOptions,
): Promise<ProviderSettingsResult> {
  const { provider, saved, print, signal, seen } = options
  const { text } = provider.setup
  if (provider.settings.length === 0 && (await findDisplayName(provider, {}))) {
    return { kind: 'accepted', settings: {} }
  }
  // The `some` check stops a provider with no required settings from reusing an empty bag.
  if (
    isComplete(provider, saved) &&
    provider.settings.some((setting) => Object.hasOwn(saved, setting.configKey))
  ) {
    const displayName = await findDisplayName(provider, saved)
    if (displayName) {
      print(text.reusing(displayName))
      return { kind: 'accepted', settings: saved, displayName }
    }
  }
  const isPrompted = provider.settings.some((setting) => setting.prompt !== undefined)
  for (;;) {
    if (signal?.aborted) {
      throw new PromptAborted()
    }
    // Nothing to ask for, so asking again can't change the answer.
    if (!isPrompted) {
      print(text.rejected)
      return { kind: 'rejected' }
    }
    const candidate = await promptSettings(provider, options.prompt, signal)
    seen.push(...listSecretValues(provider, candidate))
    const merged = { ...saved, ...candidate }
    const displayName = isComplete(provider, merged)
      ? await findDisplayName(provider, merged)
      : undefined
    if (displayName) {
      return { kind: 'accepted', settings: merged, displayName }
    }
    print(text.rejected)
  }
}

/** `message` with every non-empty value of `secrets` replaced by `***`. */
export function redact(message: string, secrets: readonly string[]): string {
  let redacted = message
  for (const secret of secrets) {
    if (secret !== '') {
      redacted = redacted.replaceAll(secret, '***')
    }
  }
  return redacted
}

async function findDisplayName(
  provider: Provider,
  settings: SettingValues,
): Promise<string | undefined> {
  try {
    const check = await provider.setup.checkCredentials(settings)
    return check.ok ? check.displayName : undefined
  } catch {
    return undefined
  }
}

/** Asks for every prompted setting; empty answers are left out. */
async function promptSettings(
  provider: Provider,
  prompt: Prompts,
  signal: AbortSignal | undefined,
): Promise<SettingValues> {
  const values: Record<string, string> = {}
  for (const setting of provider.settings) {
    if (setting.prompt === undefined) {
      continue
    }
    if (signal?.aborted) {
      throw new PromptAborted()
    }
    const answer = await (setting.secret ? prompt.password : prompt.text)(setting.prompt)
    if (answer !== '') {
      values[setting.configKey] = answer
    }
  }
  return values
}

function isComplete(provider: Provider, settings: SettingValues): boolean {
  return provider.settings
    .filter((setting) => setting.required)
    .every((setting) => Object.hasOwn(settings, setting.configKey))
}
