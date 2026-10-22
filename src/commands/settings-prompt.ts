import type { Provider, SettingValues } from '../provider/index.ts'
import { PromptAborted } from './prompts.ts'
import type { Prompts } from './types.ts'

/** The bot's display name when the provider accepts `settings`; undefined otherwise. */
export async function findDisplayName(
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

/**
 * Asks for every prompted setting; empty answers are left out. Throws `PromptAborted` when `signal`
 * is aborted between prompts.
 */
export async function promptSettings(
  provider: Provider,
  prompt: Prompts,
  signal?: AbortSignal,
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

/** True when `settings` has every required setting of `provider`. */
export function isComplete(provider: Provider, settings: SettingValues): boolean {
  return provider.settings
    .filter((setting) => setting.required)
    .every((setting) => Object.hasOwn(settings, setting.configKey))
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
