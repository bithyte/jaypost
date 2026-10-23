import { discordProvider } from '../discord/index.ts'
import type { Provider } from '@jaypost/core'
import { ntfyProvider } from '../ntfy/index.ts'
import { telegramProvider } from '../telegram/index.ts'
import { terminalProvider } from '../terminal/index.ts'

/** Every provider `init` offers and the installed service can use. */
export const PROVIDERS: readonly Provider[] = [telegramProvider, discordProvider, ntfyProvider]

/** `PROVIDERS` plus the dev-only terminal provider, which only `JAYPOST_PROVIDER=terminal` picks. */
export const SERVICE_PROVIDERS: readonly Provider[] = [...PROVIDERS, terminalProvider]
