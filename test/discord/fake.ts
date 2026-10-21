import type {
  CommandDefinition,
  DiscordClient,
  DiscordIdentity,
  GatewayEvents,
  InteractionHandle,
  InteractionResponse,
  OutgoingMessage,
} from '../../src/discord/index.ts'

export type FakeDiscord = {
  readonly client: DiscordClient
  readonly identityCalls: number[]
  readonly openedFor: string[]
  readonly created: { readonly channelId: string; readonly message: OutgoingMessage }[]
  readonly edited: {
    readonly channelId: string
    readonly messageId: string
    readonly content: string
    readonly removeButtons: boolean
  }[]
  readonly deleted: { readonly channelId: string; readonly messageId: string }[]
  readonly responses: {
    readonly interaction: InteractionHandle
    readonly response: InteractionResponse
  }[]
  readonly commandSets: {
    readonly applicationId: string
    readonly commands: readonly CommandDefinition[]
  }[]
  /** Events passed to `connect`; undefined until it is called. */
  readonly events: () => GatewayEvents | undefined
  readonly connectCalls: () => number
  readonly destroyCalls: () => number
}

const DEFAULT_IDENTITY: DiscordIdentity = {
  kind: 'ok',
  userId: 'bot1',
  username: 'jaybot',
  applicationId: 'app1',
}

/**
 * A `DiscordClient` that records every call. Channels are `dm<n>` per opened user and message ids
 * `m<n>` in send order; `overrides` replace whole methods (the override is not recorded).
 */
export function createFakeDiscord(overrides: Partial<DiscordClient> = {}): FakeDiscord {
  const identityCalls: number[] = []
  const openedFor: string[] = []
  const created: { channelId: string; message: OutgoingMessage }[] = []
  const edited: FakeDiscord['edited'][number][] = []
  const deleted: { channelId: string; messageId: string }[] = []
  const responses: FakeDiscord['responses'][number][] = []
  const commandSets: FakeDiscord['commandSets'][number][] = []
  let events: GatewayEvents | undefined
  let connectCalls = 0
  let destroyCalls = 0
  const client: DiscordClient = {
    getIdentity: async () => {
      identityCalls.push(identityCalls.length + 1)
      return DEFAULT_IDENTITY
    },
    openDirectChannel: async (userId) => {
      openedFor.push(userId)
      return `dm${openedFor.length}`
    },
    createMessage: async (channelId, message) => {
      created.push({ channelId, message })
      return { id: `m${created.length}`, channelId }
    },
    editMessage: async (channelId, messageId, content, removeButtons) => {
      edited.push({ channelId, messageId, content, removeButtons })
    },
    deleteMessage: async (channelId, messageId) => {
      deleted.push({ channelId, messageId })
    },
    respond: async (interaction, response) => {
      responses.push({ interaction, response })
    },
    setCommands: async (applicationId, commands) => {
      commandSets.push({ applicationId, commands })
    },
    connect: (gatewayEvents) => {
      connectCalls += 1
      events = gatewayEvents
    },
    destroy: async () => {
      destroyCalls += 1
    },
    ...overrides,
  }
  return {
    client,
    identityCalls,
    openedFor,
    created,
    edited,
    deleted,
    responses,
    commandSets,
    events: () => events,
    connectCalls: () => connectCalls,
    destroyCalls: () => destroyCalls,
  }
}
