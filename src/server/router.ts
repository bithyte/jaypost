import { isAuthorized } from '../auth/index.ts'
import type { BotRoute, BotRouter, SingleBotOptions } from './types.ts'

/** Routes every call to the one bot, after checking the token when `auth` has one. */
export function createSingleBotRouter(options: SingleBotOptions): BotRouter {
  const { auth, ...bot } = options
  const found: BotRoute = { kind: 'bot', bot }
  return {
    route: (authorization) => {
      if (auth.kind === 'none' || isAuthorized(authorization, auth.token)) {
        return found
      }
      return { kind: 'unauthorized', reason: authorization === undefined ? 'missing' : 'wrong' }
    },
    limits: {
      maxTextLength: bot.maxTextLength,
      maxAttachmentBytes: bot.maxAttachmentBytes ?? 0,
      ...(bot.maxOptionCount === undefined ? {} : { maxOptionCount: bot.maxOptionCount }),
    },
  }
}
