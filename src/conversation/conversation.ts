import {
  AMBIGUOUS_REPLY,
  BUTTONS_ONLY_REPLY,
  EXPIRED_REPLY,
  NOT_OPEN_REPLY,
  NOT_TEXT_REPLY,
  PAIRED_REPLY,
  START_COMMAND_PATTERN,
  WRONG_CODE_REPLY,
} from './constants.ts'
import { parseChoicePayload, parseDismissPayload } from './payload.ts'
import type {
  ConversationHandlers,
  ConversationMessage,
  ConversationTap,
  MessageOutcome,
  OpenQuestion,
  TapOutcome,
} from './types.ts'

type ReplyRoute = 'ignored' | 'accepted' | 'buttonsOnly' | 'notOpen' | 'ambiguous' | 'notText'

/** The owner, their open questions, and what each message or tap means. Never throws. */
export class OwnerConversation {
  #ownerId: string | undefined
  #questions = new Map<string, OpenQuestion>()

  constructor(ownerId: string | undefined) {
    this.#ownerId = ownerId
  }

  /** The paired owner, or undefined until pairing succeeds. */
  get ownerId(): string | undefined {
    return this.#ownerId
  }

  /** True only for the paired owner in a direct chat. */
  isOwner(senderId: string | undefined, isDirect: boolean): boolean {
    return isDirect && senderId !== undefined && senderId === this.#ownerId
  }

  /**
   * Opens a question under the adapter's message `key`. Call after the platform accepted the send;
   * `forget` in finalize, even if the edit fails.
   */
  track(key: string, id: string, allowText: boolean): void {
    this.#questions.set(key, { id, allowText })
  }

  /** Closes the question under `key`; unknown keys are fine. */
  forget(key: string): void {
    this.#questions.delete(key)
  }

  /** Decides what a message means: an answer, a refusal, a pairing attempt, or nothing. */
  receive(message: ConversationMessage, handlers: ConversationHandlers): MessageOutcome {
    if (message.fromBot || !message.isDirect) {
      return { kind: 'ignored' }
    }
    if (this.isOwner(message.senderId, true)) {
      const route = this.#routeReply(message, handlers.reply)
      if (route === 'accepted') {
        return { kind: 'answered' }
      }
      if (route !== 'ignored') {
        return { kind: 'refused', text: describeRefusal(route) }
      }
    }
    return this.#pair(message, handlers)
  }

  /** Decides what a button tap means; only the owner's taps count. */
  tap(tap: ConversationTap, handlers: ConversationHandlers): TapOutcome {
    if (!this.isOwner(tap.senderId, tap.isDirect)) {
      return { kind: 'ignored' }
    }
    const dismissId = parseDismissPayload(tap.payload)
    if (dismissId !== undefined) {
      handlers.dismiss(dismissId)
      return { kind: 'dismissed' }
    }
    const choice = parseChoicePayload(tap.payload)
    if (choice === undefined) {
      return { kind: 'expired', text: EXPIRED_REPLY }
    }
    return handlers.answer(choice.id, choice.optionIndex) === 'accepted'
      ? { kind: 'answered' }
      : { kind: 'expired', text: EXPIRED_REPLY }
  }

  #routeReply(message: ConversationMessage, reply: ConversationHandlers['reply']): ReplyRoute {
    const { replyTo, text } = message
    if (replyTo !== undefined) {
      const question = this.#questions.get(replyTo.key)
      if (question !== undefined) {
        if (text === undefined) {
          return question.allowText ? 'notText' : 'ignored'
        }
        if (!question.allowText) {
          return 'buttonsOnly'
        }
        return reply(question.id, text.trim()) === 'accepted' ? 'accepted' : 'notOpen'
      }
      if (replyTo.fromSelf) {
        return text === undefined ? 'ignored' : 'notOpen'
      }
    }
    if (text === undefined || text.startsWith('/')) {
      return 'ignored'
    }
    const textQuestions = [...this.#questions.values()].filter((question) => question.allowText)
    const [only, second] = textQuestions
    if (only === undefined) {
      return 'ignored'
    }
    if (second !== undefined) {
      return 'ambiguous'
    }
    return reply(only.id, text.trim()) === 'accepted' ? 'accepted' : 'ignored'
  }

  #pair(message: ConversationMessage, handlers: ConversationHandlers): MessageOutcome {
    const { senderId, text } = message
    if (handlers.pair === undefined || senderId === undefined || text === undefined) {
      return { kind: 'ignored' }
    }
    const result = handlers.pair(senderId, text.trim().replace(START_COMMAND_PATTERN, ''))
    if (result === 'paired') {
      this.#ownerId = senderId
      return { kind: 'paired', ownerId: senderId, text: PAIRED_REPLY }
    }
    if (result === 'wrong') {
      return { kind: 'wrongCode', text: WRONG_CODE_REPLY }
    }
    return { kind: 'ignored' }
  }
}

function describeRefusal(route: Exclude<ReplyRoute, 'ignored' | 'accepted'>): string {
  switch (route) {
    case 'buttonsOnly':
      return BUTTONS_ONLY_REPLY
    case 'notOpen':
      return NOT_OPEN_REPLY
    case 'ambiguous':
      return AMBIGUOUS_REPLY
    case 'notText':
      return NOT_TEXT_REPLY
  }
}
