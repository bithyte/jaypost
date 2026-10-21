import { Bot, GrammyError } from 'grammy'
import type {
  CredentialCheck,
  ProviderRuntime,
  RuntimeHandlers,
  SettingValues,
} from '../provider/index.ts'
import {
  createTelegramMessenger,
  formatPairingInstructions,
  registerCommandHandler,
  registerPairingHandler,
  registerReplyHandler,
  registerTapHandler,
  setCommandMenu,
} from './adapter.ts'
import type { OpenQuestions, Owner } from './types.ts'

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Telegram behind the provider contract. `checkCredentials` must succeed before the bot username
 * is used. Pairing sets the in-memory owner; saving it is the daemon's job.
 */
export function createTelegramRuntime(
  settings: SettingValues,
  log: (line: string) => void,
  createBot: (token: string) => Bot = (token) => new Bot(token),
): ProviderRuntime {
  const bot = createBot(String(settings.botToken))
  const owner: Owner = { id: typeof settings.ownerId === 'number' ? settings.ownerId : undefined }
  const openQuestions: OpenQuestions = new Map()
  const messenger = createTelegramMessenger(bot, owner, openQuestions, log)
  let stopped = false
  return {
    async checkCredentials(): Promise<CredentialCheck> {
      try {
        await bot.init()
      } catch (error) {
        // Never the error text; it can embed the request URL with the token.
        return {
          ok: false,
          reason:
            error instanceof GrammyError
              ? `Telegram rejected the bot token (${error.error_code}); check it with \`jaypost init\``
              : 'could not reach Telegram to verify the bot token',
        }
      }
      return { ok: true, displayName: `@${bot.botInfo.username}` }
    },
    ...messenger,
    pairingInstructions: (code) => formatPairingInstructions(code, bot.botInfo.username),
    statusFields: () => ({ bot: bot.botInfo.username }),
    start(handlers: RuntimeHandlers): void {
      // Log handler errors instead of crashing; grammY's error text doesn't include the token.
      bot.catch((error) => {
        log(`bot error: ${describeError(error.error)}`)
      })
      registerTapHandler(bot, owner, handlers.answer, handlers.dismiss, log)
      registerCommandHandler(bot, owner, handlers.commands, handlers.command)
      registerReplyHandler(bot, owner, openQuestions, handlers.reply, log)
      if (handlers.pair !== undefined) {
        registerPairingHandler(bot, handlers.pair, (id) => {
          owner.id = id
          setCommandMenu(bot, id, handlers.commands, log)
        })
      }
      if (owner.id !== undefined) {
        setCommandMenu(bot, owner.id, handlers.commands, log)
      }
      bot
        .start({ onStart: (botUser) => log(`bot @${botUser.username} polling`) })
        .catch((error: unknown) => {
          if (stopped) {
            return
          }
          handlers.fatal(
            error instanceof GrammyError && error.error_code === 409
              ? 'another instance is already polling with this bot token; exiting'
              : `bot stopped: ${describeError(error)}`,
          )
        })
    },
    async stop(): Promise<void> {
      stopped = true
      try {
        await bot.stop()
      } catch {
        // Stopping is best effort; the process is going away anyway.
      }
    },
  }
}
