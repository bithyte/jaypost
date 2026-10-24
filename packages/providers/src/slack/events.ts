import { toOutgoingMessage } from './blocks.ts'
import { NOT_OWNER_COMMAND_REPLY, SLASH_COMMAND, WHITESPACE_PATTERN } from './constants.ts'
import { toMessageKey } from './messenger.ts'
import type { EventContext, IncomingAction, IncomingCommand, IncomingMessage } from './types.ts'

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function post(
  channelId: string,
  text: string,
  threadTs: string | undefined,
  context: EventContext,
): Promise<void> {
  try {
    await context.client.postMessage(channelId, {
      ...toOutgoingMessage({ text, spans: [] }, []),
      ...(threadTs === undefined ? {} : { threadTs }),
    })
  } catch (error) {
    context.log(`failed to reply: ${describeError(error)}`)
  }
}

async function postEphemeral(
  channelId: string,
  userId: string | undefined,
  text: string,
  context: EventContext,
): Promise<void> {
  if (userId === undefined) {
    return
  }
  try {
    await context.client.postEphemeral(channelId, userId, text)
  } catch (error) {
    context.log(`failed to answer a tap: ${describeError(error)}`)
  }
}

/** Usage line, then one line per owner command with its description. */
export function formatCommandHelp(context: EventContext): string {
  return [
    `Usage: ${SLASH_COMMAND} <command> [argument]`,
    ...context.handlers.commands.map((command) => `${command.name}: ${command.description}`),
  ].join('\n')
}

/**
 * Lets the conversation decide what a DM means and sends its answer: refusals in the message's
 * thread, pairing results as a plain message. A thread reply counts as a reply to the message the
 * thread hangs off. The bot's own messages and channel messages are ignored. Never throws; client
 * failures are logged.
 */
export async function handleMessage(
  message: IncomingMessage,
  context: EventContext,
): Promise<void> {
  const { thread } = message
  const outcome = context.conversation.receive(
    {
      senderId: message.fromId,
      fromBot: message.fromBot,
      isDirect: message.isDirect,
      text: message.text,
      replyTo: thread && {
        key: toMessageKey(message.channelId, thread.ts),
        fromSelf: thread.parentUserId === context.botId,
      },
    },
    context.handlers,
  )
  switch (outcome.kind) {
    case 'ignored':
    case 'answered':
      return
    case 'refused':
      await post(message.channelId, outcome.text, thread?.ts ?? message.ts, context)
      return
    case 'paired':
    case 'wrongCode':
      await post(message.channelId, outcome.text, undefined, context)
      return
  }
}

/**
 * Answers a button tap: only the owner's (or the asked voter's), in a DM, reach the handlers. An
 * expired tap gets an ephemeral note, a dismissal deletes the notification. Slack already got its
 * acknowledgement from the client. Never throws; client failures are logged.
 */
export async function handleAction(action: IncomingAction, context: EventContext): Promise<void> {
  const outcome = context.conversation.tap(
    { senderId: action.userId, isDirect: action.isDirect, payload: action.actionId },
    context.handlers,
  )
  switch (outcome.kind) {
    case 'ignored':
    case 'answered':
      return
    case 'expired':
      await postEphemeral(action.channelId, action.userId, outcome.text, context)
      return
    case 'dismissed':
      try {
        await context.client.deleteMessage(action.channelId, action.messageTs)
      } catch (error) {
        context.log(`failed to delete notification: ${describeError(error)}`)
      }
      return
  }
}

/**
 * Runs `/jaypost <command> [argument]` for the owner in their DM and posts the reply there; an
 * unknown or missing command gets the command list. Anyone else gets an ephemeral not-paired
 * note. Never throws; client failures are logged.
 */
export async function handleCommand(
  command: IncomingCommand,
  context: EventContext,
): Promise<void> {
  if (!context.conversation.isOwner(command.userId, command.isDirect)) {
    await postEphemeral(command.channelId, command.userId, NOT_OWNER_COMMAND_REPLY, context)
    return
  }
  const trimmed = command.text.trim()
  const space = trimmed.search(WHITESPACE_PATTERN)
  const name = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase()
  const argument = space === -1 ? '' : trimmed.slice(space + 1).trim()
  const isKnown = context.handlers.commands.some((candidate) => candidate.name === name)
  const reply = isKnown ? context.handlers.command(name, argument) : undefined
  await post(command.channelId, reply ?? formatCommandHelp(context), undefined, context)
}
