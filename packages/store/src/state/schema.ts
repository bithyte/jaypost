import { z } from 'zod'
import { STATE_VERSION } from './constants.ts'

// z.unknown() accepts a missing key, so reject undefined explicitly.
const referenceSchema = z.unknown().refine((value) => value !== undefined)

const spanFieldsSchema = {
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
}

const spanSchema = z.union([
  z.object({
    kind: z.enum(['bold', 'italic', 'strikethrough', 'code', 'blockquote']),
    ...spanFieldsSchema,
  }),
  z.object({ kind: z.literal('pre'), ...spanFieldsSchema, language: z.string().optional() }),
])

export const stateFileSchema = z.object({
  version: z.literal(STATE_VERSION),
  provider: z.string(),
  requests: z.array(
    z.object({
      id: z.string(),
      reference: referenceSchema,
      text: z.string(),
      spans: z.array(spanSchema).optional(),
      caller: z.object({ key: z.string(), pairing: z.string() }).optional(),
    }),
  ),
  notifications: z.array(
    z.object({ id: z.string(), reference: referenceSchema, expiresAtMs: z.number().finite() }),
  ),
})
