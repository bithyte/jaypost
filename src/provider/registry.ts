import { discordProvider } from '../discord/index.ts'
import { telegramProvider } from '../telegram/index.ts'
import type { Provider } from './types.ts'

/** Every provider the CLI and daemon can use. */
export const PROVIDERS: readonly Provider[] = [telegramProvider, discordProvider]
