import { z } from 'zod'
import { VOTE_RULES } from '@jaypost/core'

/** Where the key's bot is; `failed` comes with `error`, and the bot is retried with backoff. */
const BOT_STATE_SCHEMA = z.enum(['starting', 'running', 'failed'])

/**
 * Shape of the /status response; `code` is present only while unpaired. `bot` is a Telegram-only
 * field older CLIs read; the limits come from the provider. `key` and `pairing` are the caller
 * key's ids. Unknown fields are kept.
 */
export const statusInfoSchema = z.discriminatedUnion('paired', [
  z.looseObject({
    paired: z.literal(true),
    key: z.string().optional(),
    pairing: z.string().optional(),
    state: BOT_STATE_SCHEMA.optional(),
    error: z.string().optional(),
    provider: z.string().optional(),
    displayName: z.string().optional(),
    bot: z.string().optional(),
    maxAttachmentBytes: z.number().optional(),
    maxTextLength: z.number().optional(),
    maxOptionCount: z.number().optional(),
  }),
  z.looseObject({
    paired: z.literal(false),
    code: z.string(),
    key: z.string().optional(),
    pairing: z.string().optional(),
    state: BOT_STATE_SCHEMA.optional(),
    error: z.string().optional(),
    provider: z.string().optional(),
    displayName: z.string().optional(),
    instructions: z.string().optional(),
    bot: z.string().optional(),
    maxAttachmentBytes: z.number().optional(),
    maxTextLength: z.number().optional(),
    maxOptionCount: z.number().optional(),
  }),
])

/** Shape of the /vote response; `null` in `votes` is a voter who never voted. Unknown fields are kept. */
export const voteReportSchema = z.looseObject({
  answer: z.string(),
  timedOut: z.boolean(),
  approved: z.boolean(),
  require: z.enum(VOTE_RULES),
  votes: z.record(z.string(), z.string().nullable()),
  rounds: z.number(),
})
