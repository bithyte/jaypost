import { GrammyError, InputFile } from 'grammy'
import type { Bot } from 'grammy'
import type { MessageEntity } from 'grammy/types'
import type { Attachment, MessageReference, Messenger, OwnerCommand } from '../approval/index.ts'
import {
  DISMISS_LABEL,
  formatChoicePayload,
  formatDismissPayload,
  withTextHint,
} from '../conversation/index.ts'
import type { ConversationHandlers, OwnerConversation } from '../conversation/index.ts'
import type { FormattedText, Span } from '../format/index.ts'
import type { Notifier } from '../notify/index.ts'
import { formatCode } from '../pairing/index.ts'
import type { RuntimeHandlers } from '../provider/index.ts'
import type { TelegramMessageReference } from './types.ts'

/** How to pair: `code` is raw (no dash), `bot` the username without `@`. */
export function formatPairingInstructions(code: string, bot: string): string {
  return `Send "/start ${formatCode(code)}" to @${bot}, or open https://t.me/${bot}?start=${code}`
}

/** `formatPairingInstructions` for the dashed code an old /status body carries. */
export function formatLegacyInstructions(displayCode: string, bot: string): string {
  return formatPairingInstructions(displayCode.replaceAll('-', ''), bot)
}

// Key of an open question in the conversation: `<chatId>:<messageId>`.
function formatMessageKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`
}

function toEntity(span: Span, offset: number, length: number): MessageEntity {
  switch (span.kind) {
    case 'pre':
      return span.language === undefined
        ? { type: 'pre', offset, length }
        : { type: 'pre', offset, length, language: span.language }
    case 'bold':
    case 'italic':
    case 'strikethrough':
    case 'code':
    case 'blockquote':
      return { type: span.kind, offset, length }
  }
}

function isCodeSpan(span: Span): boolean {
  return span.kind === 'code' || span.kind === 'pre'
}

/**
 * Maps spans to Telegram entities, obeying its nesting rules: bold, italic and strikethrough are
 * split around code, and a blockquote holding code is dropped (code wins, it's what gets approved).
 * Sorted by offset, longer first on ties. Never throws.
 */
export function toEntities(spans: readonly Span[]): MessageEntity[] {
  const codeSpans = spans.filter(isCodeSpan)
  const entities: MessageEntity[] = []
  for (const span of spans) {
    const end = span.offset + span.length
    const inside = codeSpans.filter(
      (code) => code !== span && code.offset >= span.offset && code.offset + code.length <= end,
    )
    if (isCodeSpan(span) || inside.length === 0) {
      entities.push(toEntity(span, span.offset, span.length))
      continue
    }
    if (span.kind === 'blockquote') {
      continue
    }
    let pieceStart = span.offset
    for (const code of inside) {
      if (code.offset > pieceStart) {
        entities.push(toEntity(span, pieceStart, code.offset - pieceStart))
      }
      pieceStart = code.offset + code.length
    }
    if (end > pieceStart) {
      entities.push(toEntity(span, pieceStart, end - pieceStart))
    }
  }
  return entities.toSorted(
    (left, right) => left.offset - right.offset || right.length - left.length,
  )
}

/**
 * Runs `send` with the message's entities; when Telegram answers 400 to a call that carried them,
 * logs once and repeats it without, so formatting never stops a message from arriving.
 */
async function sendFormatted<Result>(
  message: FormattedText,
  log: (line: string) => void,
  send: (extra: { readonly entities?: MessageEntity[] }) => Promise<Result>,
): Promise<Result> {
  const entities = toEntities(message.spans)
  if (entities.length === 0) {
    return send({})
  }
  try {
    return await send({ entities })
  } catch (error) {
    if (!(error instanceof GrammyError) || error.error_code !== 400) {
      throw error
    }
    log(`telegram rejected formatting, sent as plain text: ${error.description}`)
  }
  return send({})
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// The conversation keeps ids as strings; grammY wants the numeric chat id.
function requireOwnerChatId(conversation: OwnerConversation): number {
  return requireChatId(conversation.ownerId)
}

function requireChatId(userId: string | undefined): number {
  if (userId === undefined) {
    throw new Error('bot is not paired yet')
  }
  return Number(userId)
}

/**
 * Sends requests as inline-keyboard messages to the owner; the final edit removes the buttons.
 * A request without options has no keyboard, and `allowText` appends a hint on how to reply.
 * A sent request is tracked by the conversation only after Telegram accepted it, and forgotten
 * again by `finalize`, even when the final edit fails. Notifications get a single Dismiss button
 * when `options.dismissible` is set. Sending throws when nobody is paired.
 */
export function createTelegramMessenger(
  bot: Bot,
  conversation: OwnerConversation,
  log: (line: string) => void = console.error,
): Required<Messenger> & Required<Notifier> {
  // The document is always silent; the message that follows decides whether the phone pings.
  async function sendDocument(ownerId: number, attachment: Attachment): Promise<number> {
    const sent = await bot.api.sendDocument(
      ownerId,
      new InputFile(attachment.content, attachment.name),
      { disable_notification: true },
    )
    return sent.message_id
  }
  // Runs `send`; when it throws after the document went out, removes the document and rethrows.
  async function sendAfterDocument<Result>(
    ownerId: number,
    documentMessageId: number | undefined,
    send: () => Promise<Result>,
  ): Promise<Result> {
    try {
      return await send()
    } catch (error) {
      if (documentMessageId !== undefined) {
        try {
          await bot.api.deleteMessage(ownerId, documentMessageId)
        } catch (cleanupError) {
          log(`failed to delete attachment: ${describeError(cleanupError)}`)
        }
      }
      throw error
    }
  }
  return {
    async sendRequest(
      id,
      message,
      options,
      allowText,
      attachment,
      recipient,
    ): Promise<MessageReference> {
      const ownerId = requireChatId(recipient ?? conversation.ownerId)
      const hasButtons = options.length > 0
      const shown = withTextHint(message, hasButtons, allowText)
      const documentMessageId =
        attachment === undefined ? undefined : await sendDocument(ownerId, attachment)
      const sent = await sendAfterDocument(ownerId, documentMessageId, () =>
        sendFormatted(shown, log, (extra) =>
          bot.api.sendMessage(ownerId, shown.text, {
            ...extra,
            ...(hasButtons && {
              reply_markup: {
                inline_keyboard: options.map((label, index) => [
                  { text: label, callback_data: formatChoicePayload(id, index) },
                ]),
              },
            }),
            ...(documentMessageId !== undefined && {
              reply_parameters: { message_id: documentMessageId },
            }),
          }),
        ),
      )
      conversation.track(formatMessageKey(sent.chat.id, sent.message_id), id, allowText, recipient)
      return {
        chatId: sent.chat.id,
        messageId: sent.message_id,
        hasButtons,
        ...(documentMessageId !== undefined && { documentMessageId }),
      } satisfies TelegramMessageReference
    },
    async finalize(reference, message) {
      const { chatId, messageId, hasButtons } = reference as TelegramMessageReference
      conversation.forget(formatMessageKey(chatId, messageId))
      await sendFormatted(message, log, (extra) =>
        bot.api.editMessageText(chatId, messageId, message.text, {
          ...extra,
          ...(hasButtons !== false && {
            reply_markup: { inline_keyboard: [] },
          }),
        }),
      )
    },
    async sendNotification(id, message, options, attachment): Promise<MessageReference> {
      const ownerId = requireOwnerChatId(conversation)
      const documentMessageId =
        attachment === undefined ? undefined : await sendDocument(ownerId, attachment)
      const sent = await sendAfterDocument(ownerId, documentMessageId, () =>
        sendFormatted(message, log, (extra) =>
          bot.api.sendMessage(ownerId, message.text, {
            ...extra,
            disable_notification: options.silent,
            ...(options.dismissible && {
              reply_markup: {
                inline_keyboard: [
                  [{ text: DISMISS_LABEL, callback_data: formatDismissPayload(id) }],
                ],
              },
            }),
            ...(documentMessageId !== undefined && {
              reply_parameters: { message_id: documentMessageId },
            }),
          }),
        ),
      )
      return {
        chatId: sent.chat.id,
        messageId: sent.message_id,
        ...(documentMessageId !== undefined && { documentMessageId }),
      } satisfies TelegramMessageReference
    },
    async deleteMessage(reference) {
      const { chatId, messageId, documentMessageId } = reference as TelegramMessageReference
      if (documentMessageId === undefined) {
        await bot.api.deleteMessage(chatId, messageId)
        return
      }
      await bot.api.deleteMessages(chatId, [documentMessageId, messageId])
    },
  }
}

/**
 * Lets the conversation decide what a button tap means; only the owner's taps in a private chat
 * count. A Dismiss tap deletes the tapped message (so it works without in-memory state, e.g. after
 * a restart) and the bot's document it replies to; a failed delete is logged. Always answers the
 * callback, once, so the button stops spinning.
 */
export function registerTapHandler(
  bot: Bot,
  conversation: OwnerConversation,
  handlers: ConversationHandlers,
  log: (line: string) => void = console.error,
): void {
  bot.on('callback_query:data', async (context) => {
    // The chat comes from the tapped message, which is absent when Telegram drops it.
    const message = context.callbackQuery.message
    const outcome = conversation.tap(
      {
        senderId: String(context.from.id),
        isDirect: message?.chat.type === 'private',
        payload: context.callbackQuery.data,
      },
      handlers,
    )
    switch (outcome.kind) {
      case 'ignored':
      case 'answered':
        await context.answerCallbackQuery()
        return
      case 'expired':
        await context.answerCallbackQuery({ text: outcome.text })
        return
      case 'dismissed': {
        const document =
          message !== undefined && 'reply_to_message' in message
            ? message.reply_to_message
            : undefined
        try {
          await context.deleteMessage()
        } catch (error) {
          log(`failed to delete notification: ${describeError(error)}`)
        }
        if (
          message !== undefined &&
          document?.from?.id === bot.botInfo.id &&
          'document' in document
        ) {
          try {
            await context.api.deleteMessage(message.chat.id, document.message_id)
          } catch (error) {
            log(`failed to delete notification: ${describeError(error)}`)
          }
        }
        await context.answerCallbackQuery()
        return
      }
    }
  })
}

/**
 * Lets the conversation decide what a message means and sends its answer: refusals as a reply to
 * the owner's message, pairing results as a plain message. Pairing also shows the command menu to
 * the new owner. A failed reply is logged, never thrown. Register after `registerCommandHandler`
 * so registered commands never become answers.
 */
export function registerMessageHandler(
  bot: Bot,
  conversation: OwnerConversation,
  handlers: RuntimeHandlers,
  log: (line: string) => void = console.error,
): void {
  async function sendReply(send: () => Promise<unknown>): Promise<void> {
    try {
      await send()
    } catch (error) {
      log(`failed to reply: ${describeError(error)}`)
    }
  }
  bot.on('message', async (context) => {
    const replyTo = context.message.reply_to_message
    const outcome = conversation.receive(
      {
        senderId: context.from === undefined ? undefined : String(context.from.id),
        fromBot: context.from?.is_bot === true,
        isDirect: context.chat.type === 'private',
        text: context.message.text,
        replyTo:
          replyTo === undefined
            ? undefined
            : {
                key: formatMessageKey(context.chat.id, replyTo.message_id),
                fromSelf: replyTo.from?.id === bot.botInfo.id,
              },
      },
      handlers,
    )
    switch (outcome.kind) {
      case 'ignored':
      case 'answered':
        return
      case 'refused':
        await sendReply(() =>
          context.reply(outcome.text, {
            reply_parameters: { message_id: context.message.message_id },
          }),
        )
        return
      case 'paired':
        setCommandMenu(bot, Number(outcome.ownerId), handlers.commands, log)
        await sendReply(() => context.reply(outcome.text))
        return
      case 'wrongCode':
        await sendReply(() => context.reply(outcome.text))
        return
    }
  })
}

/**
 * Registers one handler per command. Replies with `command`'s text when it returns one; anyone but
 * the owner in a private chat is ignored, and the update goes no further (so a stranger's command
 * never reaches the message handler).
 */
export function registerCommandHandler(
  bot: Bot,
  conversation: OwnerConversation,
  commands: readonly OwnerCommand[],
  command: (name: string, argument: string) => string | undefined,
): void {
  for (const { name } of commands) {
    bot.command(name, async (context) => {
      const senderId = context.from === undefined ? undefined : String(context.from.id)
      if (!conversation.isOwner(senderId, context.chat.type === 'private')) {
        return
      }
      const reply = command(name, context.match)
      if (reply !== undefined) {
        await context.reply(reply)
      }
    })
  }
}

/**
 * Shows `commands` in the owner's chat menu only, so lists set in BotFather stay. Fire and forget:
 * a failure is logged by error code, never by text (it can embed the token), and never thrown.
 */
export function setCommandMenu(
  bot: Bot,
  chatId: number,
  commands: readonly OwnerCommand[],
  log: (line: string) => void,
): void {
  void (async () => {
    try {
      await bot.api.setMyCommands(
        commands.map(({ name, description }) => ({
          command: name,
          description,
        })),
        { scope: { type: 'chat', chat_id: chatId } },
      )
    } catch (error) {
      log(
        error instanceof GrammyError
          ? `failed to set bot commands (${error.error_code})`
          : 'failed to set bot commands',
      )
    }
  })()
}
