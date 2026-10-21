import type { Attachment, MessageReference, Messenger } from '../approval/index.ts'
import {
  DISMISS_LABEL,
  formatChoicePayload,
  formatDismissPayload,
  withTextHint,
} from '../conversation/index.ts'
import type { OwnerConversation } from '../conversation/index.ts'
import type { FormattedText } from '../format/index.ts'
import type { Notifier } from '../notify/index.ts'
import { BUTTONS_PER_ROW, DISCORD_MAX_CONTENT_LENGTH } from './constants.ts'
import { renderContent } from './markdown.ts'
import type { ButtonRow, DiscordClient, DiscordMessageReference, RenderedContent } from './types.ts'

/** Buttons for `options` in rows of five; each custom id carries the request id and index. */
export function toButtonRows(id: string, options: readonly string[]): readonly ButtonRow[] {
  const rows: ButtonRow[] = []
  for (let start = 0; start < options.length; start += BUTTONS_PER_ROW) {
    rows.push(
      options
        .slice(start, start + BUTTONS_PER_ROW)
        .map((label, offset) => ({ label, customId: formatChoicePayload(id, start + offset) })),
    )
  }
  return rows
}

/**
 * Sends requests as direct messages with button rows to the owner; the final edit removes the
 * buttons. A request without options has no buttons, and `allowText` appends a hint on how to
 * reply. A sent request is tracked by the conversation only after Discord accepted it, and removed
 * again by `finalize`, even when the final edit fails. Notifications get a single Dismiss button.
 * Sending throws when nobody is paired. The owner's DM channel is opened once per owner id.
 */
export function createDiscordMessenger(
  client: DiscordClient,
  conversation: OwnerConversation,
  log: (line: string) => void,
): Required<Messenger> & Required<Notifier> {
  let channel: { readonly ownerId: string; readonly channelId: string } | undefined
  async function resolveChannel(): Promise<string> {
    const ownerId = conversation.ownerId
    if (ownerId === undefined) {
      throw new Error('bot is not paired yet')
    }
    if (channel?.ownerId === ownerId) {
      return channel.channelId
    }
    const channelId = await client.openDirectChannel(ownerId)
    channel = { ownerId, channelId }
    return channelId
  }
  function render(message: FormattedText): string {
    const rendered: RenderedContent = renderContent(message, DISCORD_MAX_CONTENT_LENGTH)
    switch (rendered.fallback) {
      case 'none':
        break
      case 'unformatted':
        log('discord message too long with formatting, sent unformatted')
        break
      case 'raw':
        log('discord message too long with formatting, sent as raw text')
        break
    }
    return rendered.content
  }
  return {
    async sendRequest(
      id: string,
      message: FormattedText,
      options: readonly string[],
      allowText: boolean,
      attachment: Attachment | undefined,
    ): Promise<MessageReference> {
      const channelId = await resolveChannel()
      const rows = toButtonRows(id, options)
      const hasButtons = options.length > 0
      const shown = withTextHint(message, hasButtons, allowText)
      const sent = await client.createMessage(channelId, {
        content: render(shown),
        rows,
        silent: false,
        file: attachment,
      })
      conversation.track(sent.id, id, allowText)
      return {
        channelId: sent.channelId,
        messageId: sent.id,
        hasButtons,
      } satisfies DiscordMessageReference
    },
    async finalize(reference, message): Promise<void> {
      const { channelId, messageId, hasButtons } = reference as DiscordMessageReference
      conversation.forget(messageId)
      await client.editMessage(channelId, messageId, render(message), hasButtons)
    },
    async sendNotification(id, message, options, attachment): Promise<MessageReference> {
      const channelId = await resolveChannel()
      const sent = await client.createMessage(channelId, {
        content: render(message),
        rows: [[{ label: DISMISS_LABEL, customId: formatDismissPayload(id) }]],
        silent: options.silent,
        file: attachment,
      })
      return {
        channelId: sent.channelId,
        messageId: sent.id,
        hasButtons: true,
      } satisfies DiscordMessageReference
    },
    async deleteMessage(reference): Promise<void> {
      const { channelId, messageId } = reference as DiscordMessageReference
      await client.deleteMessage(channelId, messageId)
    },
  }
}
