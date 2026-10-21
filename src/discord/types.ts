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
