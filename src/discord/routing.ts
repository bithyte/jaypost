import type { PairResult } from '../pairing/index.ts'
import {
  AMBIGUOUS_REPLY,
  BUTTONS_ONLY_REPLY,
  BUTTONS_PER_ROW,
  CUSTOM_ID_PATTERN,
  DISMISS_ID_PATTERN,
  NOT_OPEN_REPLY,
  NOT_TEXT_REPLY,
  PAIRED_REPLY,
  WRONG_CODE_REPLY,
} from './constants.ts'
import type {
  ButtonRow,
  IncomingMessage,
  OpenQuestion,
  Reply,
  ReplyRoute,
  Tap,
  TapRoute,
} from './types.ts'

/** Button custom id `<id>:<optionIndex>`; `routeTap` parses it. */
export function formatCustomId(id: string, optionIndex: number): string {
  return `${id}:${optionIndex}`
}

/** Dismiss button custom id `dismiss/<id>`; `parseDismissId` reads it back. */
export function formatDismissId(id: string): string {
  return `dismiss/${id}`
}

/** The notification id in a dismiss custom id, or undefined for anything else. */
export function parseDismissId(customId: string): string | undefined {
  return DISMISS_ID_PATTERN.exec(customId)?.[1]
}

/** Buttons for `options` in rows of five; each custom id carries the request id and index. */
export function toButtonRows(id: string, options: readonly string[]): readonly ButtonRow[] {
  const rows: ButtonRow[] = []
  for (let start = 0; start < options.length; start += BUTTONS_PER_ROW) {
    rows.push(
      options
        .slice(start, start + BUTTONS_PER_ROW)
        .map((label, offset) => ({ label, customId: formatCustomId(id, start + offset) })),
    )
  }
  return rows
}

/**
 * 'ignored' for anyone but the owner, 'expired' for a malformed custom id, else whatever `tap`
 * returns. Never throws.
 */
export function routeTap(
  fromId: string | undefined,
  customId: string,
  ownerId: string | undefined,
  tap: Tap,
): TapRoute {
  if (ownerId === undefined || fromId !== ownerId) {
    return 'ignored'
  }
  const [, id, rawIndex] = CUSTOM_ID_PATTERN.exec(customId) ?? []
  if (id === undefined || rawIndex === undefined) {
    return 'expired'
  }
  return tap(id, Number(rawIndex))
}

/**
 * Decides what an incoming message means: a reply to an open text question settles it, a non-reply
 * settles the only open text question, anything else is ignored or reported. Only the owner's
 * direct messages count. Never throws; calls `reply` at most once. The answer is trimmed; the `/`
 * check on non-replies uses the raw text.
 */
export function routeReply(
  message: IncomingMessage,
  ownerId: string | undefined,
  botId: string,
  openQuestions: ReadonlyMap<string, OpenQuestion>,
  reply: Reply,
): ReplyRoute {
  if (!message.isDirect || message.fromBot || ownerId === undefined || message.fromId !== ownerId) {
    return 'ignored'
  }
  const { replyTo, text } = message
  if (replyTo !== undefined) {
    const question = openQuestions.get(replyTo.messageId)
    if (question !== undefined) {
      if (text === undefined) {
        return question.allowText ? 'notText' : 'ignored'
      }
      return question.allowText ? reply(question.id, text.trim()) : 'buttonsOnly'
    }
    if (replyTo.fromId === botId) {
      return text === undefined ? 'ignored' : 'notOpen'
    }
  }
  if (text === undefined || text.startsWith('/')) {
    return 'ignored'
  }
  const textQuestions = [...openQuestions.values()].filter((question) => question.allowText)
  const [only, second] = textQuestions
  if (only === undefined) {
    return 'ignored'
  }
  if (second !== undefined) {
    return 'ambiguous'
  }
  return reply(only.id, text.trim()) === 'accepted' ? 'accepted' : 'ignored'
}

/** The bot's answer to a refused reply, or undefined when the route needs none. */
export function describeReplyRoute(route: ReplyRoute): string | undefined {
  switch (route) {
    case 'ignored':
    case 'accepted':
      return undefined
    case 'buttonsOnly':
      return BUTTONS_ONLY_REPLY
    case 'notOpen':
    case 'expired':
      return NOT_OPEN_REPLY
    case 'ambiguous':
      return AMBIGUOUS_REPLY
    case 'notText':
      return NOT_TEXT_REPLY
  }
}

/**
 * Reply text for a pairing attempt, or undefined to stay silent (not a DM, a bot, no text, blocked,
 * or already paired). Calls `onPaired` on success.
 */
export function handlePairingMessage(
  message: IncomingMessage,
  pair: (senderId: string, text: string) => PairResult,
  onPaired: (id: string) => void,
): string | undefined {
  if (!message.isDirect || message.fromBot || message.text === undefined) {
    return undefined
  }
  const result = pair(message.fromId, message.text.trim())
  if (result === 'paired') {
    onPaired(message.fromId)
    return PAIRED_REPLY
  }
  if (result === 'wrong') {
    return WRONG_CODE_REPLY
  }
  return undefined
}
