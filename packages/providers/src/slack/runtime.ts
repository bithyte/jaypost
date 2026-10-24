import type {
  CredentialCheck,
  ProviderRuntime,
  RuntimeHandlers,
  SettingValues,
} from '@jaypost/core'
import { formatCode, OwnerConversation } from '@jaypost/core'
import { createSlackClient } from './client.ts'
import { handleAction, handleCommand, handleMessage } from './events.ts'
import { createSlackMessenger } from './messenger.ts'
import type { EventContext, SlackClient, SlackIdentity } from './types.ts'

type KnownIdentity = Extract<SlackIdentity, { readonly kind: 'ok' }>

/** Why `identity` isn't usable, in words for the daemon log and `init`; never holds a token. */
export function describeIdentityFailure(
  identity: Exclude<SlackIdentity, { readonly kind: 'ok' }>,
): string {
  switch (identity.kind) {
    case 'missingScopes':
      return `the Slack bot token lacks ${identity.scopes.join(', ')}; add the scopes from the app manifest and reinstall the app`
    case 'rejected':
      return identity.token === 'bot'
        ? `Slack rejected the bot token (${identity.error}); check it with \`jaypost init\``
        : `Slack rejected the app-level token (${identity.error}); check it with \`jaypost init\``
    case 'unreachable':
      return 'could not reach Slack to verify the tokens'
  }
}

/**
 * Slack behind the provider contract. `checkCredentials` must succeed before `start` or
 * `pairingInstructions`. Pairing sets the in-memory owner; saving it is the daemon's job. Neither
 * token appears in a reason, a log line or a fatal message.
 */
export function createSlackRuntime(
  settings: SettingValues,
  log: (line: string) => void,
  createClient: (botToken: string, appToken: string) => SlackClient = createSlackClient,
): ProviderRuntime {
  const client = createClient(String(settings.botToken), String(settings.appToken))
  const conversation = new OwnerConversation(
    typeof settings.ownerId === 'string' ? settings.ownerId : undefined,
  )
  const messenger = createSlackMessenger(client, conversation, log)
  let identity: KnownIdentity | undefined
  let stopped = false
  function requireIdentity(): KnownIdentity {
    if (identity === undefined) {
      throw new Error('slack app identity unknown: checkCredentials must succeed first')
    }
    return identity
  }
  return {
    async checkCredentials(): Promise<CredentialCheck> {
      const result = await client.getIdentity()
      if (result.kind !== 'ok') {
        return { ok: false, reason: describeIdentityFailure(result) }
      }
      identity = result
      return { ok: true, displayName: `@${result.botName}` }
    },
    ...messenger,
    pairingInstructions(code: string): string {
      const { appId, teamId, botName } = requireIdentity()
      return `Open https://slack.com/app_redirect?app=${appId}&team=${teamId} (or @${botName} under Apps in Slack) and send "${formatCode(code)}" in its Messages tab`
    },
    approverPairingInstructions(code: string): string {
      const { botName } = requireIdentity()
      return `Have them open @${botName} under Apps in your Slack workspace and send "${formatCode(code)}" in its Messages tab`
    },
    start(handlers: RuntimeHandlers): void {
      const { userId, botName } = requireIdentity()
      const context: EventContext = { client, conversation, botId: userId, handlers, log }
      // Never the error text: it could carry request details
      const logHandlerFailure = (error: unknown): void => {
        log(`slack event handler failed: ${error instanceof Error ? error.name : 'unknown error'}`)
      }
      client.connect({
        ready: () => log(`app @${botName} connected`),
        message: (message) => {
          handleMessage(message, context).catch(logHandlerFailure)
        },
        action: (action) => {
          handleAction(action, context).catch(logHandlerFailure)
        },
        command: (command) => {
          handleCommand(command, context).catch(logHandlerFailure)
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
