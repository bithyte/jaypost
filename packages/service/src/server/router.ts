import { isAuthorized, LOCAL_PERSON } from '@jaypost/store'
import { SINGLE_BOT_CALLER, SINGLE_BOT_ID } from './constants.ts'
import type { ApiBot, BotRouter, KeyRoute, OpenApiOptions, SingleBotOptions } from './types.ts'

/** The limits /status and /openapi.yaml report for one bot. */
export function toLimits(
  bot: Pick<ApiBot, 'maxTextLength' | 'maxAttachmentBytes' | 'maxOptionCount'>,
): Omit<OpenApiOptions, 'port' | 'version'> {
  return {
    maxAttachmentBytes: bot.maxAttachmentBytes ?? 0,
    maxTextLength: bot.maxTextLength,
    ...(bot.maxOptionCount === undefined ? {} : { maxOptionCount: bot.maxOptionCount }),
  }
}

/**
 * Routes every call to the one bot as key `k1` on pairing `p1`, after checking the token when
 * `auth` has one. The person is `recipient()` while `status()` says paired, else nobody.
 */
export function createSingleBotRouter(options: SingleBotOptions): BotRouter {
  const { auth, version, status, recipient, botId, ...rest } = options
  const bot: ApiBot = { ...rest, botId: botId ?? SINGLE_BOT_ID }
  const toRoute = (): KeyRoute => {
    const current = status()
    return {
      kind: 'key',
      caller: SINGLE_BOT_CALLER,
      person: current.paired ? (recipient() ?? LOCAL_PERSON) : undefined,
      bot,
      status: () => ({ ...status(), ...toLimits(bot) }),
      readLog: () => ({ entries: [], skippedCount: 0 }),
    }
  }
  return {
    route: (authorization) => {
      if (auth.kind === 'none' || isAuthorized(authorization, auth.token)) {
        return toRoute()
      }
      return { kind: 'unauthorized', reason: authorization === undefined ? 'missing' : 'wrong' }
    },
    openApi: () => ({ version, ...toLimits(bot) }),
  }
}
