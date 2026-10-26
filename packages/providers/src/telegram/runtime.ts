import { Bot, GrammyError } from 'grammy'
import type {
  CredentialCheck,
  ProviderRuntime,
  RuntimeHandlers,
  SettingValues,
} from '@jaypost/core'
import { OwnerConversation } from '@jaypost/core'
import {
  createTelegramMessenger,
  formatPairingInstructions,
  registerCommandHandler,
  registerMessageHandler,
  registerTapHandler,
  setCommandMenu,
} from './adapter.ts'

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Telegram behind the provider contract. `checkCredentials` must succeed before the bot username
 * is used. Who is paired is the daemon's to know; the runtime asks `handlers.isPaired`.
 */
export function createTelegramRuntime(
  settings: SettingValues,
  log: (line: string) => void,
  createBot: (token: string) => Bot = (token) => new Bot(token),
): ProviderRuntime {
  const bot = createBot(String(settings.botToken))
  const conversation = new OwnerConversation()
  const messenger = createTelegramMessenger(bot, conversation, log)
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
      registerTapHandler(bot, conversation, handlers, log)
      registerCommandHandler(bot, conversation, handlers.commands, handlers)
      registerMessageHandler(bot, conversation, handlers, log)
      for (const pairedId of handlers.listPaired()) {
        setCommandMenu(bot, Number(pairedId), handlers.commands, log)
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
