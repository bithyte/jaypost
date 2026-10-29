import { z } from 'zod'

/** Entries are loose so unknown fields survive a rewrite. */
export const bookSchema = z.object({
  version: z.literal(1),
  default: z.string().optional(),
  local: z.looseObject({ url: z.string(), adminKey: z.string().optional() }).optional(),
  remotes: z.array(z.looseObject({ name: z.string(), url: z.string(), adminKey: z.string() })),
  bots: z.array(z.looseObject({ alias: z.string(), url: z.string(), key: z.string().optional() })),
})
