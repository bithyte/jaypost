import { z } from 'zod'

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

export const requestRecordSchema = z.object({
  id: z.string(),
  reference: referenceSchema,
  text: z.string(),
  spans: z.array(spanSchema).optional(),
  caller: z.object({ key: z.string(), contact: z.string() }).optional(),
})

export const notificationRecordSchema = z.object({
  id: z.string(),
  reference: referenceSchema,
  expiresAtMs: z.number().finite(),
})
