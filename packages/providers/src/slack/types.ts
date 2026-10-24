import type { Attachment, OwnerConversation, RuntimeHandlers } from '@jaypost/core'

/** Formatting of one rich text run; each key is present only when on. */
export type TextStyle = {
  readonly bold?: true
  readonly italic?: true
  readonly strike?: true
  readonly code?: true
}

/** A run of literal text or a link inside a rich text element. */
export type RichTextInline =
  | { readonly type: 'text'; readonly text: string; readonly style?: TextStyle }
  | { readonly type: 'link'; readonly url: string; readonly style?: TextStyle }

/** One paragraph-level part of a rich text block. */
export type RichTextElement =
  | { readonly type: 'rich_text_section'; readonly elements: readonly RichTextInline[] }
  | {
      readonly type: 'rich_text_preformatted'
      readonly elements: readonly RichTextInline[]
      readonly language?: string
    }
  | { readonly type: 'rich_text_quote'; readonly elements: readonly RichTextInline[] }

/** A Block Kit button; `action_id` and `value` both carry the button payload. */
export type SlackButton = {
  readonly type: 'button'
  readonly text: { readonly type: 'plain_text'; readonly text: string; readonly emoji: false }
  readonly action_id: string
  readonly value: string
}

/** The two Block Kit blocks jaypost sends: the message text and its buttons. */
export type SlackBlock =
  | { readonly type: 'rich_text'; readonly elements: readonly RichTextElement[] }
  | { readonly type: 'actions'; readonly elements: readonly SlackButton[] }

/**
 * What `getIdentity` found: the bot and its app, the scopes the bot token lacks, a token Slack
 * refused (with Slack's error string), or no answer at all.
 */
export type SlackIdentity =
  | {
      readonly kind: 'ok'
      readonly userId: string
      readonly botName: string
      readonly teamId: string
      readonly appId: string
    }
  | { readonly kind: 'missingScopes'; readonly scopes: readonly string[] }
  | { readonly kind: 'rejected'; readonly token: 'bot' | 'app'; readonly error: string }
  | { readonly kind: 'unreachable' }

/** A message to send: `text` is the notification fallback, `blocks` what the chat shows. */
export type OutgoingMessage = {
  readonly text: string
  readonly blocks: readonly SlackBlock[]
  readonly threadTs?: string
}

/** Where a sent message lives, for later edits and deletes. */
export type SentMessage = {
  readonly channelId: string
  readonly ts: string
}

/** The parts of a Slack message event that routing needs; `text` is undefined when empty. */
export type IncomingMessage = {
  readonly channelId: string
  readonly ts: string
  readonly fromId: string | undefined
  readonly fromBot: boolean
  readonly isDirect: boolean
  readonly text: string | undefined
  /** The thread a reply was posted in; undefined for a top-level message. */
  readonly thread: { readonly ts: string; readonly parentUserId: string | undefined } | undefined
}

/** A button tap. */
export type IncomingAction = {
  readonly userId: string | undefined
  readonly channelId: string
  readonly messageTs: string
  readonly isDirect: boolean
  readonly actionId: string
}

/** The `/jaypost` slash command with its text unescaped. */
export type IncomingCommand = {
  readonly userId: string | undefined
  readonly channelId: string
  readonly isDirect: boolean
  readonly text: string
}

/** Socket Mode callbacks; `fatal` means the app can't recover and its message has no token. */
export type SocketEvents = {
  readonly ready: () => void
  readonly message: (message: IncomingMessage) => void
  readonly action: (action: IncomingAction) => void
  readonly command: (command: IncomingCommand) => void
  readonly fatal: (message: string) => void
}

/**
 * The narrow seam over Slack's Web API and Socket Mode. Methods other than `getIdentity` and
 * `connect` reject on HTTP failures and on `ok: false`.
 */
export type SlackClient = {
  readonly getIdentity: () => Promise<SlackIdentity>
  readonly openDirectChannel: (userId: string) => Promise<string>
  readonly postMessage: (channelId: string, message: OutgoingMessage) => Promise<SentMessage>
  readonly updateMessage: (channelId: string, ts: string, message: OutgoingMessage) => Promise<void>
  readonly deleteMessage: (channelId: string, ts: string) => Promise<void>
  /** Shows `text` to `userId` alone; Slack drops it on reload. */
  readonly postEphemeral: (channelId: string, userId: string, text: string) => Promise<void>
  /** Uploads `file` as a reply in the thread of `threadTs`. */
  readonly uploadFile: (channelId: string, threadTs: string, file: Attachment) => Promise<void>
  readonly connect: (events: SocketEvents) => void
  readonly destroy: () => Promise<void>
}

/** `apiRoot` points the Web API at another server (tests); `timeoutMs` bounds each request. */
export type SlackClientOptions = {
  readonly apiRoot?: string
  readonly timeoutMs?: number
}

/** What `MessageReference` holds for Slack; cast back at the messenger's edge. */
export type SlackMessageReference = {
  readonly channelId: string
  readonly ts: string
}

/**
 * What the Socket Mode handlers read: `conversation` is the runtime's live owner and open
 * questions, and `botId` is the bot's own user id.
 */
export type EventContext = {
  readonly client: SlackClient
  readonly conversation: OwnerConversation
  readonly botId: string
  readonly handlers: RuntimeHandlers
  readonly log: (line: string) => void
}

/** One open Socket Mode connection, as `createSocket` opens it. */
export type SocketConnection = {
  readonly send: (data: string) => void
  readonly close: () => void
}

/** What a Socket Mode connection reports back to the client. */
export type SocketListeners = {
  readonly message: (data: string) => void
  readonly close: () => void
}
