import {
  DISCORD_MAX_CONTENT_LENGTH,
  NOT_OWNER_COMMAND_REPLY,
  UNKNOWN_COMMAND_REPLY,
} from './constants.ts'
import { renderContent } from './markdown.ts'
import type {
  EventContext,
  IncomingInteraction,
  IncomingMessage,
  InteractionHandle,
  InteractionResponse,
} from './types.ts'

type ButtonInteraction = Extract<IncomingInteraction, { readonly kind: 'button' }>
type CommandInteraction = Extract<IncomingInteraction, { readonly kind: 'command' }>

const ACKNOWLEDGE: InteractionResponse = { kind: 'acknowledge' }

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function respond(
  interaction: InteractionHandle,
  response: InteractionResponse,
  context: EventContext,
): Promise<void> {
  try {
    await context.client.respond({ id: interaction.id, token: interaction.token }, response)
  } catch (error) {
    context.log(`failed to answer interaction: ${describeError(error)}`)
  }
}

async function sendReply(
  message: IncomingMessage,
  content: string,
  isReply: boolean,
  context: EventContext,
): Promise<void> {
  try {
    await context.client.createMessage(message.channelId, {
      content,
      rows: [],
      silent: false,
      file: undefined,
      ...(isReply ? { replyToMessageId: message.id } : {}),
    })
  } catch (error) {
    context.log(`failed to reply: ${describeError(error)}`)
  }
}

async function deleteDismissed(
  interaction: ButtonInteraction,
  context: EventContext,
): Promise<void> {
  try {
    await context.client.deleteMessage(interaction.channelId, interaction.messageId)
  } catch (error) {
    context.log(`failed to delete notification: ${describeError(error)}`)
  }
}

// Server taps are only acknowledged: the bot is in a server just so its DMs are allowed
async function handleTap(interaction: ButtonInteraction, context: EventContext): Promise<void> {
  const outcome = context.conversation.tap(
    {
      senderId: interaction.userId,
      isDirect: interaction.isDirect,
      payload: interaction.customId,
    },
    context.handlers,
  )
  switch (outcome.kind) {
    case 'ignored':
    case 'answered':
      await respond(interaction, ACKNOWLEDGE, context)
      return
    case 'expired':
      await respond(
        interaction,
        { kind: 'message', content: outcome.text, ephemeral: true },
        context,
      )
      return
    case 'dismissed':
      // Acknowledge first: Discord gives an interaction three seconds
      await respond(interaction, ACKNOWLEDGE, context)
      await deleteDismissed(interaction, context)
      return
  }
}

async function handleCommand(
  interaction: CommandInteraction,
  context: EventContext,
): Promise<void> {
  if (!context.conversation.isOwner(interaction.userId, interaction.isDirect)) {
    await respond(
      interaction,
      { kind: 'message', content: NOT_OWNER_COMMAND_REPLY, ephemeral: true },
      context,
    )
    return
  }
  const text = context.handlers.command(interaction.name, interaction.argument)
  await respond(
    interaction,
    text === undefined
      ? { kind: 'message', content: UNKNOWN_COMMAND_REPLY, ephemeral: true }
      : {
          kind: 'message',
          content: renderContent({ text, spans: [] }, DISCORD_MAX_CONTENT_LENGTH).content,
          ephemeral: false,
        },
    context,
  )
}

/**
 * Answers a button tap or slash command: only the owner's, in a DM, reach the handlers, and every
 * tap is answered so Discord never shows "interaction failed". Never throws; client failures are
 * logged.
 */
export async function handleInteraction(
  interaction: IncomingInteraction,
  context: EventContext,
): Promise<void> {
  switch (interaction.kind) {
    case 'button':
      await handleTap(interaction, context)
      return
    case 'command':
      await handleCommand(interaction, context)
      return
    case 'other':
      return
  }
}

/**
 * Lets the conversation decide what a DM means and sends its answer: refusals as a reply, pairing
 * results as a plain message. The bot's own messages and server messages are ignored. Never
 * throws; client failures are logged.
 */
export async function handleMessage(
  message: IncomingMessage,
  context: EventContext,
): Promise<void> {
  const { replyTo } = message
  const outcome = context.conversation.receive(
    {
      senderId: message.fromId,
      fromBot: message.fromBot,
      isDirect: message.isDirect,
      text: message.text,
      replyTo: replyTo && { key: replyTo.messageId, fromSelf: replyTo.fromId === context.botId },
    },
    context.handlers,
  )
  switch (outcome.kind) {
    case 'ignored':
    case 'answered':
      return
    case 'refused':
      await sendReply(message, outcome.text, true, context)
      return
    case 'paired':
    case 'wrongCode':
      await sendReply(message, outcome.text, false, context)
      return
  }
}
