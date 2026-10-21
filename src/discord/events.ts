import {
  DISCORD_MAX_CONTENT_LENGTH,
  EXPIRED_REPLY,
  NOT_OWNER_COMMAND_REPLY,
  UNKNOWN_COMMAND_REPLY,
} from './constants.ts'
import { renderContent } from './markdown.ts'
import {
  describeReplyRoute,
  handlePairingMessage,
  parseDismissId,
  routeReply,
  routeTap,
} from './routing.ts'
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

function isOwner(userId: string | undefined, context: EventContext): boolean {
  return context.owner.id !== undefined && userId === context.owner.id
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

// Server taps are only acknowledged: the bot is in a server just so its DMs are allowed
async function handleTap(interaction: ButtonInteraction, context: EventContext): Promise<void> {
  if (!interaction.isDirect) {
    await respond(interaction, ACKNOWLEDGE, context)
    return
  }
  const dismissId = parseDismissId(interaction.customId)
  if (dismissId !== undefined) {
    if (!isOwner(interaction.userId, context)) {
      await respond(interaction, ACKNOWLEDGE, context)
      return
    }
    context.handlers.dismiss(dismissId)
    // Acknowledge first: Discord gives an interaction three seconds
    await respond(interaction, ACKNOWLEDGE, context)
    try {
      await context.client.deleteMessage(interaction.channelId, interaction.messageId)
    } catch (error) {
      context.log(`failed to delete notification: ${describeError(error)}`)
    }
    return
  }
  const route = routeTap(
    interaction.userId,
    interaction.customId,
    context.owner.id,
    context.handlers.answer,
  )
  await respond(
    interaction,
    route === 'expired'
      ? { kind: 'message', content: EXPIRED_REPLY, ephemeral: true }
      : ACKNOWLEDGE,
    context,
  )
}

async function handleCommand(
  interaction: CommandInteraction,
  context: EventContext,
): Promise<void> {
  if (!interaction.isDirect || !isOwner(interaction.userId, context)) {
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
 * Routes a DM to `handlers.reply`, answering refused replies, and passes what it ignores to
 * pairing. The bot's own messages and server messages are dropped first, so they never reach
 * pairing. Never throws; client failures are logged.
 */
export async function handleMessage(
  message: IncomingMessage,
  context: EventContext,
): Promise<void> {
  if (message.fromBot || !message.isDirect) {
    return
  }
  const route = routeReply(
    message,
    context.owner.id,
    context.botId,
    context.openQuestions,
    context.handlers.reply,
  )
  const copy = describeReplyRoute(route)
  if (copy !== undefined) {
    await sendReply(message, copy, true, context)
    return
  }
  if (route !== 'ignored' || context.handlers.pair === undefined) {
    return
  }
  const pairingReply = handlePairingMessage(message, context.handlers.pair, context.onPaired)
  if (pairingReply !== undefined) {
    await sendReply(message, pairingReply, false, context)
  }
}
