import { URL_ENV_VAR } from '../config/constants.ts'
import { findEnvValue } from '../config/paths.ts'
import { TOKEN_ENV_VAR } from '../auth/constants.ts'
import { BOT_ENV_VAR } from './constants.ts'
import { findBot } from './operations.ts'
import type { Inbox, InboxBot } from './types.ts'

/** Where a command goes: a bot in the inbox, the JAYPOST_URL/JAYPOST_TOKEN env pair, or nowhere. */
export type BotTarget =
  | { readonly kind: 'bot'; readonly bot: InboxBot }
  | { readonly kind: 'env' }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * Picks the target: `alias`, then $JAYPOST_BOT, then env mode (JAYPOST_URL or JAYPOST_TOKEN set),
 * then the inbox's default. An alias never mixes with env mode. Never throws.
 */
export function resolveBotTarget(
  env: NodeJS.ProcessEnv,
  inbox: Inbox,
  alias: string | undefined,
): BotTarget {
  const name = alias ?? findEnvValue(env, BOT_ENV_VAR)
  if (name !== undefined) {
    return findNamed(inbox, name)
  }
  if (
    findEnvValue(env, URL_ENV_VAR) !== undefined ||
    findEnvValue(env, TOKEN_ENV_VAR) !== undefined
  ) {
    return { kind: 'env' }
  }
  const fallback = inbox.default === undefined ? undefined : findBot(inbox, inbox.default)
  if (fallback !== undefined) {
    return { kind: 'bot', bot: fallback }
  }
  return {
    kind: 'failed',
    message: 'no bot to send to; run "jaypost service install" or "jaypost inbox join"',
  }
}

function findNamed(inbox: Inbox, name: string): BotTarget {
  const bot = findBot(inbox, name)
  if (bot !== undefined) {
    return { kind: 'bot', bot }
  }
  const known =
    inbox.bots.length === 0
      ? "it's empty"
      : `known: ${inbox.bots.map((entry) => entry.alias).join(', ')}`
  return { kind: 'failed', message: `no bot "${name}" in your inbox; ${known}` }
}
