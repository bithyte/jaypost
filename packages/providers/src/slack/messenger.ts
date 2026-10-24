import type {
  Attachment,
  FormattedText,
  MessageReference,
  Messenger,
  Notifier,
  OwnerConversation,
} from '@jaypost/core'
import { DISMISS_LABEL, formatDismissPayload, withTextHint } from '@jaypost/core'
import { toButton, toChoiceButtons, toOutgoingMessage } from './blocks.ts'
import type { SentMessage, SlackClient, SlackMessageReference } from './types.ts'

/** The conversation's key for a sent message: its channel and timestamp. */
export function toMessageKey(channelId: string, ts: string): string {
  return `${channelId}/${ts}`
}

/**
 * Sends requests as direct messages with buttons to the owner, or to `recipient` when given; the
 * final edit removes the buttons. A request without options has no buttons, and `allowText`
 * appends a hint on how to reply. An attachment follows as a reply in the message's thread; when
 * that upload fails, the message is deleted again and the send rejects. A sent request is tracked
 * by the conversation only after Slack accepted it, and removed again by `finalize`, even when
 * the final edit fails. Notifications get a single Dismiss button when `options.dismissible` is
 * set; Slack has no silent send, so `options.silent` changes nothing. Sending throws when nobody
 * is paired. A DM channel is opened once per user id.
 */
export function createSlackMessenger(
  client: SlackClient,
  conversation: OwnerConversation,
  log: (line: string) => void,
): Required<Messenger> & Required<Notifier> {
  const channelIdsByUser = new Map<string, string>()
  async function resolveChannel(recipient?: string): Promise<string> {
    const userId = recipient ?? conversation.ownerId
    if (userId === undefined) {
      throw new Error('bot is not paired yet')
    }
    const known = channelIdsByUser.get(userId)
    if (known !== undefined) {
      return known
    }
    const channelId = await client.openDirectChannel(userId)
    channelIdsByUser.set(userId, channelId)
    return channelId
  }
  async function attach(sent: SentMessage, attachment: Attachment | undefined): Promise<void> {
    if (attachment === undefined) {
      return
    }
    try {
      await client.uploadFile(sent.channelId, sent.ts, attachment)
    } catch (error) {
      await client.deleteMessage(sent.channelId, sent.ts).catch(() => {
        log('failed to delete a slack message after its attachment failed')
      })
      throw error
    }
  }
  return {
    async sendRequest(
      id: string,
      message: FormattedText,
      options: readonly string[],
      allowText: boolean,
      attachment: Attachment | undefined,
      recipient: string | undefined,
    ): Promise<MessageReference> {
      const channelId = await resolveChannel(recipient)
      const shown = withTextHint(message, options.length > 0, allowText)
      const sent = await client.postMessage(
        channelId,
        toOutgoingMessage(shown, toChoiceButtons(id, options)),
      )
      await attach(sent, attachment)
      conversation.track(toMessageKey(sent.channelId, sent.ts), id, allowText, recipient)
      return { channelId: sent.channelId, ts: sent.ts } satisfies SlackMessageReference
    },
    async finalize(reference, message): Promise<void> {
      const { channelId, ts } = reference as SlackMessageReference
      conversation.forget(toMessageKey(channelId, ts))
      await client.updateMessage(channelId, ts, toOutgoingMessage(message, []))
    },
    async update(reference, message, buttons): Promise<void> {
      const { channelId, ts } = reference as SlackMessageReference
      // An edit replaces every block, so buttons that stay are sent again
      await client.updateMessage(
        channelId,
        ts,
        toOutgoingMessage(
          message,
          buttons === undefined ? [] : toChoiceButtons(buttons.id, buttons.options),
        ),
      )
    },
    async sendNotification(id, message, options, attachment): Promise<MessageReference> {
      const channelId = await resolveChannel()
      const sent = await client.postMessage(
        channelId,
        toOutgoingMessage(
          message,
          options.dismissible ? [toButton(DISMISS_LABEL, formatDismissPayload(id))] : [],
        ),
      )
      await attach(sent, attachment)
      return { channelId: sent.channelId, ts: sent.ts } satisfies SlackMessageReference
    },
    async deleteMessage(reference): Promise<void> {
      const { channelId, ts } = reference as SlackMessageReference
      await client.deleteMessage(channelId, ts)
    },
  }
}
