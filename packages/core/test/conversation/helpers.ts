import { vi } from 'vite-plus/test'
import type { Mock } from 'vite-plus/test'
import { OwnerConversation } from '../../src/conversation/index.ts'
import type { MessageOutcome } from '../../src/conversation/index.ts'

/** The owner replies 'x' in a DM to the bot message tracked under `key`. */
export function receiveReplyTo(
  conversation: OwnerConversation,
  key: string,
): { readonly outcome: MessageOutcome; readonly reply: Mock } {
  const reply = vi.fn(() => 'accepted' as const)
  const outcome = conversation.receive(
    {
      senderId: conversation.ownerId,
      fromBot: false,
      isDirect: true,
      text: 'x',
      replyTo: { key, fromSelf: true },
    },
    { answer: vi.fn(() => 'accepted' as const), reply, dismiss: vi.fn(() => true) },
  )
  return { outcome, reply }
}

/** Pairs `ownerId` through a DM that the pairing handler accepts. */
export function pairOwner(conversation: OwnerConversation, ownerId: string): void {
  conversation.receive(
    { senderId: ownerId, fromBot: false, isDirect: true, text: 'CODE', replyTo: undefined },
    {
      answer: vi.fn(() => 'accepted' as const),
      reply: vi.fn(() => 'accepted' as const),
      dismiss: vi.fn(() => true),
      pair: () => 'paired',
    },
  )
}
