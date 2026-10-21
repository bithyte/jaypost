import type {
  CredentialCheck,
  ProviderRuntime,
  RuntimeHandlers,
  SettingValues,
} from '../provider/index.ts'
import { formatCode } from '../pairing/index.ts'
import { createDiscordClient } from './client.ts'
import { toCommandDefinitions } from './commands.ts'
import { handleInteraction, handleMessage } from './events.ts'
import { createDiscordMessenger } from './messenger.ts'
import type { DiscordClient, DiscordIdentity, EventContext, OpenQuestions, Owner } from './types.ts'

type KnownIdentity = Extract<DiscordIdentity, { readonly kind: 'ok' }>

/**
 * Discord behind the provider contract. `checkCredentials` must succeed before `start` or
 * `pairingInstructions`. Pairing sets the in-memory owner; saving it is the daemon's job. The token
 * never appears in a reason, a log line or a fatal message.
 */
export function createDiscordRuntime(
  settings: SettingValues,
  log: (line: string) => void,
  createClient: (token: string) => DiscordClient = createDiscordClient,
): ProviderRuntime {
  const client = createClient(String(settings.botToken))
  const owner: Owner = {
    id: typeof settings.ownerId === 'string' ? settings.ownerId : undefined,
  }
  const openQuestions: OpenQuestions = new Map()
  const messenger = createDiscordMessenger(client, owner, openQuestions, log)
  let identity: KnownIdentity | undefined
  let stopped = false
  function requireIdentity(): KnownIdentity {
    if (identity === undefined) {
      throw new Error('discord bot identity unknown: checkCredentials must succeed first')
    }
    return identity
  }
  return {
    async checkCredentials(): Promise<CredentialCheck> {
      const result = await client.getIdentity()
      switch (result.kind) {
        case 'ok':
          identity = result
          return { ok: true, displayName: `@${result.username}` }
        case 'rejected':
          return {
            ok: false,
            reason: `Discord rejected the bot token (${result.status}); check it with \`jaypost init\``,
          }
        case 'unreachable':
          return {
            ok: false,
            reason: 'could not reach Discord to verify the bot token',
          }
      }
    },
    ...messenger,
    pairingInstructions(code: string): string {
      const { applicationId, username } = requireIdentity()
      return `Invite the bot to a server you're in with https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot+applications.commands&permissions=0 then DM "${formatCode(code)}" to @${username}`
    },
    start(handlers: RuntimeHandlers): void {
      const { userId, applicationId } = requireIdentity()
      const context: EventContext = {
        client,
        owner,
        botId: userId,
        openQuestions,
        handlers,
        onPaired: (id) => {
          owner.id = id
        },
        log,
      }
      // Never the error text: it could carry request details
      const logHandlerFailure = (error: unknown): void => {
        log(
          `discord event handler failed: ${error instanceof Error ? error.name : 'unknown error'}`,
        )
      }
      client.setCommands(applicationId, toCommandDefinitions(handlers.commands)).catch(() => {
        log('failed to set discord commands')
      })
      client.connect({
        ready: (username) => log(`bot @${username} connected`),
        message: (message) => {
          handleMessage(message, context).catch(logHandlerFailure)
        },
        interaction: (interaction) => {
          handleInteraction(interaction, context).catch(logHandlerFailure)
        },
        fatal: (message) => {
          if (!stopped) {
            handlers.fatal(message)
          }
        },
      })
    },
    async stop(): Promise<void> {
      stopped = true
      try {
        await client.destroy()
      } catch {
        // Stopping is best effort; the process is going away anyway.
      }
    },
  }
}
