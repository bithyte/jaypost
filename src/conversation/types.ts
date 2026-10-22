import type { RuntimeHandlers } from '../provider/index.ts'

/** One incoming chat message in platform-free terms; the adapter fills it from its event. */
export type ConversationMessage = {
  readonly senderId: string | undefined
  readonly fromBot: boolean
  readonly isDirect: boolean
  readonly text: string | undefined
  /** `key` is the adapter's open-question key for the replied-to message. */
  readonly replyTo: { readonly key: string; readonly fromSelf: boolean } | undefined
}

/** One button tap in platform-free terms; `payload` is the button's callback data. */
export type ConversationTap = {
  readonly senderId: string | undefined
  readonly isDirect: boolean
  readonly payload: string | undefined
}

/** What the adapter does next; `text` is the bot's answer. 'refused' replies to the message. */
export type MessageOutcome =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'answered' }
  | { readonly kind: 'refused'; readonly text: string }
  | { readonly kind: 'paired'; readonly ownerId: string; readonly text: string }
  | { readonly kind: 'wrongCode'; readonly text: string }

/** What the adapter does next after a tap. */
export type TapOutcome =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'answered' }
  | { readonly kind: 'expired'; readonly text: string }
  | { readonly kind: 'dismissed' }

/** The runtime callbacks the conversation drives. */
export type ConversationHandlers = Pick<RuntimeHandlers, 'answer' | 'reply' | 'dismiss' | 'pair'>

/**
 * A tracked bot question awaiting an answer; allowText lets a plain reply answer it. `recipient`
 * is the voter it was sent to, or undefined when it went to the owner.
 */
export type OpenQuestion = {
  readonly id: string
  readonly allowText: boolean
  readonly recipient: string | undefined
}
