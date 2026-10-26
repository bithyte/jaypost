import { vi } from 'vite-plus/test'
import type { Mock } from 'vite-plus/test'
import { OwnerConversation } from '../../src/conversation/index.ts'
import type { MessageOutcome } from '../../src/conversation/index.ts'

/** `senderId`, paired, replies 'x' in a DM to the bot message tracked under `key`. */
export function receiveReplyTo(
  conversation: OwnerConversation,
  key: string,
  senderId: string,
): { readonly outcome: MessageOutcome; readonly reply: Mock } {
  const reply = vi.fn(() => 'accepted' as const)
  const outcome = conversation.receive(
    {
      senderId,
      fromBot: false,
      isDirect: true,
      text: 'x',
      replyTo: { key, fromSelf: true },
    },
    {
      answer: vi.fn(() => 'accepted' as const),
      reply,
      dismiss: vi.fn(() => true),
      isPaired: (id) => id === senderId,
    },
  )
  return { outcome, reply }
}
