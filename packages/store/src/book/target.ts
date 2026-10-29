import { URL_ENV_VAR } from '../config/constants.ts'
import { findEnvValue } from '../config/paths.ts'
import { TOKEN_ENV_VAR } from '../auth/constants.ts'
import { BOT_ENV_VAR } from './constants.ts'
import { findBot } from './operations.ts'
import type { Book, BookBot } from './types.ts'

/** Where a command goes: a contact, the JAYPOST_URL/JAYPOST_TOKEN env pair, or nowhere. */
export type BotTarget =
  | { readonly kind: 'bot'; readonly bot: BookBot }
  | { readonly kind: 'env' }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * Picks the target: `alias`, then $JAYPOST_BOT, then env mode (JAYPOST_URL or JAYPOST_TOKEN set),
 * then the book's default. An alias never mixes with env mode. Never throws.
 */
export function resolveBotTarget(
  env: NodeJS.ProcessEnv,
  book: Book,
  alias: string | undefined,
): BotTarget {
  const name = alias ?? findEnvValue(env, BOT_ENV_VAR)
  if (name !== undefined) {
    return findNamed(book, name)
  }
  if (
    findEnvValue(env, URL_ENV_VAR) !== undefined ||
    findEnvValue(env, TOKEN_ENV_VAR) !== undefined
  ) {
    return { kind: 'env' }
  }
  const fallback = book.default === undefined ? undefined : findBot(book, book.default)
  if (fallback !== undefined) {
    return { kind: 'bot', bot: fallback }
  }
  return {
    kind: 'failed',
    message: 'no bot to send to; run "jaypost service install" or "jaypost join"',
  }
}

function findNamed(book: Book, name: string): BotTarget {
  const bot = findBot(book, name)
  if (bot !== undefined) {
    return { kind: 'bot', bot }
  }
  const known =
    book.bots.length === 0
      ? "it's empty"
      : `known: ${book.bots.map((entry) => entry.alias).join(', ')}`
  return { kind: 'failed', message: `no bot "${name}" in your contacts; ${known}` }
}
