import {
  API,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  ButtonStyle,
  ComponentType,
  GatewayDispatchEvents,
  GatewayIntentBits,
  InteractionContextType,
  InteractionType,
} from '@discordjs/core'
import type {
  APIActionRowComponent,
  APIButtonComponentWithCustomId,
  APIInteraction,
  GatewayDispatchPayload,
  GatewayMessageCreateDispatchData,
  RESTPutAPIApplicationCommandsJSONBody,
} from '@discordjs/core'
import { DiscordAPIError, REST, RESTEvents } from '@discordjs/rest'
import type { RestEvents } from '@discordjs/rest'
import { WebSocketManager, WebSocketShardEvents } from '@discordjs/ws'
import {
  DISCORD_API_ROOT,
  FATAL_CLOSE_CODES,
  MESSAGE_FLAG_EPHEMERAL,
  MESSAGE_FLAG_SUPPRESS_EMBEDS,
  MESSAGE_FLAG_SUPPRESS_NOTIFICATIONS,
  REJECTED_TOKEN_FATAL,
} from './constants.ts'
import type {
  ButtonRow,
  CommandDefinition,
  DiscordClient,
  DiscordClientOptions,
  DiscordIdentity,
  GatewayEvents,
  IncomingInteraction,
  IncomingMessage,
} from './types.ts'

const NO_MENTIONS = { parse: [] }

/** The slice of `WebSocketManager` the client uses; tests swap in a fake. */
type GatewayLike = {
  readonly on: {
    (
      event: WebSocketShardEvents.Dispatch,
      listener: (payload: GatewayDispatchPayload) => void,
    ): unknown
    (event: WebSocketShardEvents.Closed, listener: (code: number) => void): unknown
    (event: WebSocketShardEvents.Error, listener: (error: Error) => void): unknown
  }
  readonly connect: () => Promise<void>
  readonly destroy: () => PromiseLike<void> | void
}

/** Internal: `createGateway` replaces the real websocket in tests; not exported from index.ts. */
type GatewayOptions = {
  readonly createGateway?: (rest: REST) => GatewayLike
}

/**
 * A `DiscordClient` over one REST instance; the gateway opens only in `connect`. The token is never
 * put in a fatal message.
 */
export function createDiscordClient(
  token: string,
  options: DiscordClientOptions & GatewayOptions = {},
): DiscordClient {
  const rest = new REST({
    version: '10',
    api: options.apiRoot ?? DISCORD_API_ROOT,
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  }).setToken(token)
  const api = new API(rest)
  const createGateway: (client: REST) => GatewayLike =
    options.createGateway ??
    ((client: REST) =>
      new WebSocketManager({ token, intents: GatewayIntentBits.DirectMessages, rest: client }))
  let gateway: GatewayLike | undefined
  let hasConnected = false
  let isDestroyed = false
  let onResponse: ((...args: RestEvents[RESTEvents.Response]) => void) | undefined
  // An empty token would make replaceAll insert the marker between every character
  const redact = (text: string): string => (token === '' ? text : text.replaceAll(token, '<token>'))
  return {
    async getIdentity(): Promise<DiscordIdentity> {
      try {
        const [user, application] = await Promise.all([
          api.users.getCurrent(),
          api.applications.getCurrent(),
        ])
        return {
          kind: 'ok',
          userId: user.id,
          username: user.username,
          applicationId: application.id,
        }
      } catch (error) {
        return error instanceof DiscordAPIError
          ? { kind: 'rejected', status: error.status }
          : { kind: 'unreachable' }
      }
    },
    async openDirectChannel(userId) {
      const channel = await api.users.createDM(userId)
      return channel.id
    },
    async createMessage(channelId, message) {
      const sent = await api.channels.createMessage(channelId, {
        content: message.content,
        allowed_mentions: NO_MENTIONS,
        flags:
          MESSAGE_FLAG_SUPPRESS_EMBEDS | (message.silent ? MESSAGE_FLAG_SUPPRESS_NOTIFICATIONS : 0),
        components: message.rows.map(toActionRow),
        ...(message.file === undefined
          ? {}
          : { files: [{ name: message.file.name, data: Buffer.from(message.file.content) }] }),
        ...(message.replyToMessageId === undefined
          ? {}
          : { message_reference: { message_id: message.replyToMessageId } }),
      })
      return { id: sent.id, channelId: sent.channel_id }
    },
    async editMessage(channelId, messageId, content, removeButtons) {
      await api.channels.editMessage(channelId, messageId, {
        content,
        allowed_mentions: NO_MENTIONS,
        flags: MESSAGE_FLAG_SUPPRESS_EMBEDS,
        ...(removeButtons ? { components: [] } : {}),
      })
    },
    async deleteMessage(channelId, messageId) {
      await api.channels.deleteMessage(channelId, messageId)
    },
    async respond(interaction, response) {
      switch (response.kind) {
        case 'acknowledge':
          await api.interactions.deferMessageUpdate(interaction.id, interaction.token)
          return
        case 'message':
          await api.interactions.reply(interaction.id, interaction.token, {
            content: response.content,
            allowed_mentions: NO_MENTIONS,
            flags: MESSAGE_FLAG_SUPPRESS_EMBEDS | (response.ephemeral ? MESSAGE_FLAG_EPHEMERAL : 0),
          })
          return
      }
    },
    async setCommands(applicationId, commands) {
      await api.applicationCommands.bulkOverwriteGlobalCommands(
        applicationId,
        toCommandBodies(commands),
      )
    },
    connect(events) {
      if (hasConnected) {
        throw new RangeError('discord client connect called twice')
      }
      hasConnected = true
      let isFatal = false
      const fatal = (message: string): void => {
        if (isFatal || isDestroyed) {
          return
        }
        isFatal = true
        events.fatal(redact(message))
      }
      onResponse = (request, response) => {
        // Interaction callbacks authenticate with their own token, so their 401 says nothing about ours
        if (response.status === 401 && request.data.auth !== false) {
          fatal(REJECTED_TOKEN_FATAL)
        }
      }
      rest.on(RESTEvents.Response, onResponse)
      const manager = createGateway(rest)
      gateway = manager
      manager.on(WebSocketShardEvents.Dispatch, (payload) => {
        if (!isDestroyed) {
          dispatch(payload, events)
        }
      })
      manager.on(WebSocketShardEvents.Closed, (code) => {
        if (FATAL_CLOSE_CODES.includes(code)) {
          fatal(code === 4004 ? REJECTED_TOKEN_FATAL : `discord gateway closed (${code})`)
        }
      })
      // The shard emits 'error' next to fatal closes, which `Closed` already reports; without a
      // listener the emitter would throw
      manager.on(WebSocketShardEvents.Error, () => {})
      manager
        .connect()
        .then(async () => {
          // destroy() during the connect only reached the shards that existed then
          if (isDestroyed) {
            await manager.destroy()
          }
        })
        .catch((error: unknown) => {
          if (error instanceof DiscordAPIError && error.status === 401) {
            fatal(REJECTED_TOKEN_FATAL)
            return
          }
          fatal(
            `could not connect to Discord: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
    },
    async destroy() {
      isDestroyed = true
      if (onResponse !== undefined) {
        rest.off(RESTEvents.Response, onResponse)
        onResponse = undefined
      }
      const current = gateway
      gateway = undefined
      await current?.destroy()
    },
  }
}

/** The parts of a gateway message that routing needs. Never throws. */
export function toIncomingMessage(data: GatewayMessageCreateDispatchData): IncomingMessage {
  const replyToId = data.message_reference?.message_id
  return {
    id: data.id,
    channelId: data.channel_id,
    fromId: data.author.id,
    fromBot: data.author.bot === true,
    isDirect: data.guild_id === undefined,
    text: data.content === '' ? undefined : data.content,
    replyTo:
      replyToId === undefined
        ? undefined
        : { messageId: replyToId, fromId: data.referenced_message?.author.id },
  }
}

/** A button tap, a slash command with its first string option, or 'other'. Never throws. */
export function toIncomingInteraction(data: APIInteraction): IncomingInteraction {
  const handle = { id: data.id, token: data.token }
  const userId = (data.user ?? data.member?.user)?.id
  const isDirect = data.guild_id === undefined
  if (
    data.type === InteractionType.MessageComponent &&
    data.data.component_type === ComponentType.Button
  ) {
    return {
      ...handle,
      kind: 'button',
      userId,
      isDirect,
      customId: data.data.custom_id,
      channelId: data.channel.id,
      messageId: data.message.id,
    }
  }
  if (
    data.type === InteractionType.ApplicationCommand &&
    data.data.type === ApplicationCommandType.ChatInput
  ) {
    const option = data.data.options?.find(
      (candidate) => candidate.type === ApplicationCommandOptionType.String,
    )
    return {
      ...handle,
      kind: 'command',
      userId,
      isDirect,
      name: data.data.name,
      argument: option?.type === ApplicationCommandOptionType.String ? option.value : '',
    }
  }
  return { ...handle, kind: 'other' }
}

function dispatch(payload: GatewayDispatchPayload, events: GatewayEvents): void {
  switch (payload.t) {
    case GatewayDispatchEvents.Ready:
      events.ready(payload.d.user.username)
      return
    case GatewayDispatchEvents.MessageCreate:
      events.message(toIncomingMessage(payload.d))
      return
    case GatewayDispatchEvents.InteractionCreate:
      events.interaction(toIncomingInteraction(payload.d))
      return
    default:
      return
  }
}

function toActionRow(row: ButtonRow): APIActionRowComponent<APIButtonComponentWithCustomId> {
  return {
    type: ComponentType.ActionRow,
    components: row.map((button) => ({
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      label: button.label,
      custom_id: button.customId,
    })),
  }
}

function toCommandBodies(
  commands: readonly CommandDefinition[],
): RESTPutAPIApplicationCommandsJSONBody {
  return commands.map((command) => ({
    name: command.name,
    description: command.description,
    type: ApplicationCommandType.ChatInput,
    contexts: [InteractionContextType.BotDM],
    integration_types: [ApplicationIntegrationType.GuildInstall],
    ...(command.option === undefined
      ? {}
      : {
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: command.option.name,
              description: command.option.description,
              required: false,
            },
          ],
        }),
  }))
}
