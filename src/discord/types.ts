import type { Attachment } from '../approval/index.ts'

/**
 * Message content ready to send. `fallback` says how far rendering degraded to fit the limit:
 * 'none' keeps the formatting, 'unformatted' keeps the text with markup escaped, 'raw' is the
 * caller's text unchanged.
 */
export type RenderedContent = {
  readonly content: string
  readonly fallback: 'none' | 'unformatted' | 'raw'
}

/** Shared mutable cell: pairing sets `id`, and the messenger and handlers read it live. */
export type Owner = {
  id: string | undefined
}

/** What happened to a button tap: not from the owner, handled, or no longer valid. */
export type TapRoute = 'ignored' | 'accepted' | 'expired'

/** What `routeReply` decided; only 'accepted' settled a request. */
export type ReplyRoute =
  | 'ignored'
  | 'accepted'
  | 'expired'
  | 'buttonsOnly'
  | 'notOpen'
  | 'ambiguous'
  | 'notText'

/**
 * Records an answer for request `id`; 'expired' when it is unknown, already settled, or the option
 * index is invalid.
 */
export type Tap = (id: string, optionIndex: number) => 'accepted' | 'expired'

/**
 * Settles request `id` with typed text; 'expired' when it is unknown or already settled.
 */
export type Reply = (id: string, text: string) => 'accepted' | 'expired'

/** Clears the expiry of notification `id`; false when it is unknown or already expired. */
export type Dismiss = (id: string) => boolean

/** The parts of a Discord message that routing needs; `text` is undefined when content is empty. */
export type IncomingMessage = {
  readonly id: string
  readonly channelId: string
  readonly fromId: string
  readonly fromBot: boolean
  readonly isDirect: boolean
  readonly text: string | undefined
  readonly replyTo: { readonly messageId: string; readonly fromId: string | undefined } | undefined
}

/** A request awaiting an answer, keyed by message id in `OpenQuestions`. */
export type OpenQuestion = {
  readonly id: string
  readonly allowText: boolean
}

/** Open questions by message id: set after send, deleted in `finalize`. */
export type OpenQuestions = Map<string, OpenQuestion>

/** One row of buttons; Discord allows five per row. */
export type ButtonRow = readonly { readonly label: string; readonly customId: string }[]

/** A slash command with at most one optional string option. */
export type CommandDefinition = {
  readonly name: string
  readonly description: string
  readonly option?: { readonly name: string; readonly description: string }
}

/** What `getIdentity` found: the bot and its application, a refused token, or no answer at all. */
export type DiscordIdentity =
  | {
      readonly kind: 'ok'
      readonly userId: string
      readonly username: string
      readonly applicationId: string
    }
  | { readonly kind: 'rejected'; readonly status: number }
  | { readonly kind: 'unreachable' }

/** A message to send; `silent` skips the push notification, `file` rides in the same request. */
export type OutgoingMessage = {
  readonly content: string
  readonly rows: readonly ButtonRow[]
  readonly silent: boolean
  readonly file: Attachment | undefined
  readonly replyToMessageId?: string
}

/** Where a sent message lives, for later edits and deletes. */
export type SentMessage = {
  readonly id: string
  readonly channelId: string
}

/** What it takes to answer an interaction. */
export type InteractionHandle = {
  readonly id: string
  readonly token: string
}

/** 'acknowledge' closes a button tap without changing the message; 'message' replies with text. */
export type InteractionResponse =
  | { readonly kind: 'acknowledge' }
  | { readonly kind: 'message'; readonly content: string; readonly ephemeral: boolean }

/** The parts of a button tap or slash command that routing needs; 'other' for anything else. */
export type IncomingInteraction = (
  | {
      readonly kind: 'button'
      readonly userId: string | undefined
      readonly isDirect: boolean
      readonly customId: string
      readonly channelId: string
      readonly messageId: string
    }
  | {
      readonly kind: 'command'
      readonly userId: string | undefined
      readonly isDirect: boolean
      readonly name: string
      readonly argument: string
    }
  | { readonly kind: 'other' }
) &
  InteractionHandle

/** Gateway callbacks; `fatal` means the connection won't recover and its message has no token. */
export type GatewayEvents = {
  readonly ready: (username: string) => void
  readonly message: (message: IncomingMessage) => void
  readonly interaction: (interaction: IncomingInteraction) => void
  readonly fatal: (message: string) => void
}

/**
 * The narrow seam over discord.js. Every message and reply it sends mentions nobody. Methods
 * other than `getIdentity` and `connect` reject on REST failures.
 */
export type DiscordClient = {
  readonly getIdentity: () => Promise<DiscordIdentity>
  readonly openDirectChannel: (userId: string) => Promise<string>
  readonly createMessage: (channelId: string, message: OutgoingMessage) => Promise<SentMessage>
  readonly editMessage: (
    channelId: string,
    messageId: string,
    content: string,
    removeButtons: boolean,
  ) => Promise<void>
  readonly deleteMessage: (channelId: string, messageId: string) => Promise<void>
  readonly respond: (interaction: InteractionHandle, response: InteractionResponse) => Promise<void>
  readonly setCommands: (
    applicationId: string,
    commands: readonly CommandDefinition[],
  ) => Promise<void>
  readonly connect: (events: GatewayEvents) => void
  readonly destroy: () => Promise<void>
}

/** `apiRoot` points REST at another server (tests); `timeoutMs` bounds each REST request. */
export type DiscordClientOptions = {
  readonly apiRoot?: string
  readonly timeoutMs?: number
}

/** What `MessageReference` holds for Discord; cast back at the messenger's edge. */
export type DiscordMessageReference = {
  readonly channelId: string
  readonly messageId: string
  readonly hasButtons: boolean
}
