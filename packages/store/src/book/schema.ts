import { z } from 'zod'
import { toServiceUrl } from './operations.ts'

// A bad url becomes an issue at its path (never quoting the value); a good one is normalized, so
// a hand-written `http://host:8787` matches the CLI-written `http://host:8787/`.
const serviceUrl = z.string().transform((value, context) => {
  const url = toServiceUrl(value)
  if (url === undefined) {
    context.addIssue({ code: 'custom', message: "isn't an http(s) service url" })
    return z.NEVER
  }
  return url
})

/** Entries are loose so unknown fields survive a rewrite. */
export const bookSchema = z.object({
  version: z.literal(1),
  default: z.string().optional(),
  local: z.looseObject({ url: serviceUrl, adminKey: z.string().optional() }).optional(),
  remotes: z.array(z.looseObject({ name: z.string(), url: serviceUrl, adminKey: z.string() })),
  bots: z.array(z.looseObject({ alias: z.string(), url: serviceUrl, key: z.string().optional() })),
})
