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
import type { RuntimeHandlers } from '../provider/index.ts'
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

/**
 * The open questions of a bot and what each message or tap means. Who is paired is the daemon's
 * to know: every decision asks `handlers.isPaired`. Never throws.
 */
export class OwnerConversation {
  #questions = new Map<string, OpenQuestion>()

  /** True only for a paired sender in a direct chat. */
  isPaired(
    senderId: string | undefined,
    isDirect: boolean,
    handlers: Pick<RuntimeHandlers, 'isPaired'>,
  ): boolean {
    return isDirect && senderId !== undefined && handlers.isPaired(senderId)
  }

  /**
   * Opens a question under the adapter's message `key`. Call after the platform accepted the send;
   * `forget` in finalize, even if the edit fails. Only the `recipient` can answer it.
   */
  track(key: string, id: string, allowText: boolean, recipient?: string): void {
    this.#questions.set(key, { id, allowText, recipient })
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
    const { senderId } = message
    if (senderId !== undefined && this.isPaired(senderId, true, handlers)) {
      const route = this.#routeReply(message, senderId, handlers.reply)
      if (route === 'accepted') {
        return { kind: 'answered' }
      }
      if (route !== 'ignored') {
        return { kind: 'refused', text: describeRefusal(route) }
      }
    }
    return this.#pair(message, handlers)
  }

  /**
   * Decides what a button tap means. A choice on a tracked question counts only from the person it
   * was sent to; dismissals only from a paired sender. A choice on a request nobody has open goes
   * to the handler for a paired sender and is expired for anyone else in a direct chat.
   */
  tap(tap: ConversationTap, handlers: ConversationHandlers): TapOutcome {
    if (!tap.isDirect || tap.senderId === undefined) {
      return { kind: 'ignored' }
    }
    const isPaired = this.isPaired(tap.senderId, true, handlers)
    const dismissId = parseDismissPayload(tap.payload)
    if (dismissId !== undefined) {
      if (!isPaired) {
        return { kind: 'ignored' }
      }
      handlers.dismiss(dismissId)
      return { kind: 'dismissed' }
    }
    const choice = parseChoicePayload(tap.payload)
    if (choice === undefined) {
      return isPaired ? { kind: 'expired', text: EXPIRED_REPLY } : { kind: 'ignored' }
    }
    const question = [...this.#questions.values()].find((open) => open.id === choice.id)
    if (question === undefined && !isPaired) {
      return { kind: 'expired', text: EXPIRED_REPLY }
    }
    // A paired tap on an untracked id still goes to the handler, which knows if it is settled.
    if (question !== undefined && question.recipient !== tap.senderId) {
      return { kind: 'ignored' }
    }
    return handlers.answer(choice.id, choice.optionIndex) === 'accepted'
      ? { kind: 'answered' }
      : { kind: 'expired', text: EXPIRED_REPLY }
  }

  #routeReply(
    message: ConversationMessage,
    senderId: string,
    reply: ConversationHandlers['reply'],
  ): ReplyRoute {
    const { replyTo, text } = message
    if (replyTo !== undefined) {
      const found = this.#questions.get(replyTo.key)
      // Someone else's question is, for this sender, a message that isn't waiting for an answer.
      const question = found?.recipient === senderId ? found : undefined
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
    const textQuestions = [...this.#questions.values()].filter(
      (question) => question.allowText && question.recipient === senderId,
    )
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
      return { kind: 'paired', senderId, text: PAIRED_REPLY }
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
