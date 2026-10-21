import { z } from 'zod'

/**
 * Shape of the /status response; `code` is present only while unpaired. `bot` is a Telegram-only
 * field older CLIs read; the limits come from the provider. Unknown fields are kept.
 */
export const statusInfoSchema = z.discriminatedUnion('paired', [
  z.looseObject({
    paired: z.literal(true),
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
    provider: z.string().optional(),
    displayName: z.string().optional(),
    instructions: z.string().optional(),
    bot: z.string().optional(),
    maxAttachmentBytes: z.number().optional(),
    maxTextLength: z.number().optional(),
    maxOptionCount: z.number().optional(),
  }),
])
