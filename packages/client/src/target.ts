import {
  BOT_ENV_VAR,
  DEFAULT_PORT,
  findBot,
  findEnvPort,
  findEnvValue,
  NO_CLIENT_TOKEN,
  readInbox,
  resolveInboxPath,
  resolveEnvToken,
  TOKEN_ENV_VAR,
  URL_ENV_VAR,
} from '@jaypost/store'
import { findEnvEndpoint, toLocalEndpoint } from './endpoint.ts'
import type { Inbox, InboxBot } from '@jaypost/store'
import type { ResolvedBot, ResolvedBotFailure } from './types.ts'

/**
 * The service and token a call goes to: the inbox bot named by `alias` or $JAYPOST_BOT, else env
 * mode (JAYPOST_URL, JAYPOST_TOKEN, JAYPOST_PORT; the inbox isn't read), else the inbox default. A
 * inbox key never goes to an env URL and an env token never goes to an inbox URL. Never throws: a
 * failure is an `invalid` endpoint carrying the message, with no token, and `failure` says which
 * kind it is. Messages never hold a key.
 */
export function resolveBot(env: NodeJS.ProcessEnv, alias: string | undefined): ResolvedBot {
  const name = alias ?? findEnvValue(env, BOT_ENV_VAR)
  if (name === undefined && hasEnvTarget(env)) {
    return resolveEnvBot(env)
  }
  const path = resolveInboxPath(env)
  let inbox
  try {
    inbox = readInbox(path)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // readInbox names the file for bad contents; an I/O error needs the path added.
    return toFailure(
      message.includes(path)
        ? message
        : `inbox ${JSON.stringify(path)} couldn't be read: ${message}`,
      'unresolvable',
    )
  }
  if (name !== undefined) {
    return resolveNamedBot(inbox, name)
  }
  const fallback = inbox.default === undefined ? undefined : findBot(inbox, inbox.default)
  return fallback === undefined
    ? toFailure('no bot to send to; run "jaypost service install" or "jaypost inbox join"', 'noBot')
    : toResolvedBot(fallback)
}

function resolveNamedBot(inbox: Inbox, name: string): ResolvedBot {
  const bot = findBot(inbox, name)
  if (bot !== undefined) {
    return toResolvedBot(bot)
  }
  const known =
    inbox.bots.length === 0
      ? "it's empty"
      : `known: ${inbox.bots.map((entry) => entry.alias).join(', ')}`
  return toFailure(`no bot "${name}" in your inbox; ${known}`, 'unresolvable')
}

function toResolvedBot(bot: InboxBot): ResolvedBot {
  return {
    endpoint: { kind: 'url', url: new URL(bot.url) },
    token:
      bot.key === undefined ? NO_CLIENT_TOKEN : { kind: 'token', token: bot.key, source: 'inbox' },
    alias: bot.alias,
    failure: undefined,
  }
}

function hasEnvTarget(env: NodeJS.ProcessEnv): boolean {
  return (
    findEnvValue(env, URL_ENV_VAR) !== undefined || findEnvValue(env, TOKEN_ENV_VAR) !== undefined
  )
}

function resolveEnvBot(env: NodeJS.ProcessEnv): ResolvedBot {
  const endpoint = findEnvEndpoint(env) ?? toLocalEndpoint(findEnvPort(env) ?? DEFAULT_PORT)
  return {
    endpoint,
    token: resolveEnvToken(env),
    alias: undefined,
    failure: endpoint.kind === 'invalid' ? 'unresolvable' : undefined,
  }
}

function toFailure(message: string, failure: ResolvedBotFailure): ResolvedBot {
  return {
    endpoint: { kind: 'invalid', message },
    token: NO_CLIENT_TOKEN,
    alias: undefined,
    failure,
  }
}
