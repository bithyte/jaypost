import { discordProvider } from '../discord/index.ts'
import type { Provider } from '@jaypost/core'
import { slackProvider } from '../slack/index.ts'
import { telegramProvider } from '../telegram/index.ts'
import { terminalProvider } from '../terminal/index.ts'

/** Every provider `init` offers and the installed service can use. */
export const PROVIDERS: readonly Provider[] = [telegramProvider, discordProvider, slackProvider]

/** `PROVIDERS` plus the dev-only terminal provider, which only `JAYPOST_PROVIDER=terminal` picks. */
export const SERVICE_PROVIDERS: readonly Provider[] = [...PROVIDERS, terminalProvider]
