import type { Attachment } from '@jaypost/core'
import type {
  OutgoingMessage,
  SlackClient,
  SlackIdentity,
  SocketEvents,
} from '../../src/slack/index.ts'

export type FakeSlack = {
  readonly client: SlackClient
  readonly openedFor: string[]
  readonly posted: { readonly channelId: string; readonly message: OutgoingMessage }[]
  readonly updated: {
    readonly channelId: string
    readonly ts: string
    readonly message: OutgoingMessage
  }[]
  readonly deleted: { readonly channelId: string; readonly ts: string }[]
  readonly ephemeral: {
    readonly channelId: string
    readonly userId: string
    readonly text: string
  }[]
  readonly uploaded: {
    readonly channelId: string
    readonly threadTs: string
    readonly file: Attachment
  }[]
  /** Events passed to `connect`; undefined until it is called. */
  readonly events: () => SocketEvents | undefined
  readonly connectCalls: () => number
  readonly destroyCalls: () => number
}

export const DEFAULT_IDENTITY: SlackIdentity = {
  kind: 'ok',
  userId: 'UBOT',
  botName: 'jaypost',
  teamId: 'T1',
  appId: 'A1',
}

/**
 * A `SlackClient` that records every call. Channels are `D<n>` per opened user and timestamps
 * `<n>.0` in post order; `overrides` replace whole methods (the override is not recorded).
 */
export function createFakeSlack(overrides: Partial<SlackClient> = {}): FakeSlack {
  const openedFor: string[] = []
  const posted: FakeSlack['posted'][number][] = []
  const updated: FakeSlack['updated'][number][] = []
  const deleted: FakeSlack['deleted'][number][] = []
  const ephemeral: FakeSlack['ephemeral'][number][] = []
  const uploaded: FakeSlack['uploaded'][number][] = []
  let events: SocketEvents | undefined
  let connectCalls = 0
  let destroyCalls = 0
  const client: SlackClient = {
    getIdentity: async () => DEFAULT_IDENTITY,
    openDirectChannel: async (userId) => {
      openedFor.push(userId)
      return `D${openedFor.length}`
    },
    postMessage: async (channelId, message) => {
      posted.push({ channelId, message })
      return { channelId, ts: `${posted.length}.0` }
    },
    updateMessage: async (channelId, ts, message) => {
      updated.push({ channelId, ts, message })
    },
    deleteMessage: async (channelId, ts) => {
      deleted.push({ channelId, ts })
    },
    postEphemeral: async (channelId, userId, text) => {
      ephemeral.push({ channelId, userId, text })
    },
    uploadFile: async (channelId, threadTs, file) => {
      uploaded.push({ channelId, threadTs, file })
    },
    connect: (socketEvents) => {
      connectCalls += 1
      events = socketEvents
    },
    destroy: async () => {
      destroyCalls += 1
    },
    ...overrides,
  }
  return {
    client,
    openedFor,
    posted,
    updated,
    deleted,
    ephemeral,
    uploaded,
    events: () => events,
    connectCalls: () => connectCalls,
    destroyCalls: () => destroyCalls,
  }
}
