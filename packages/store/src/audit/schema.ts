import { z } from 'zod'
import { AUDIT_FORMAT_VERSION } from './constants.ts'

const ASKED_SCHEMA = z.looseObject({
  v: z.literal(AUDIT_FORMAT_VERSION),
  event: z.literal('asked'),
  id: z.string().min(1),
  at: z.iso.datetime(),
  project: z.string().optional(),
  text: z.string(),
  options: z.array(z.string()),
  timeoutOption: z.string(),
  timeoutSeconds: z.number().positive(),
  key: z.string().optional(),
  pairing: z.string().optional(),
})

const SETTLED_SCHEMA = z.looseObject({
  v: z.literal(AUDIT_FORMAT_VERSION),
  event: z.literal('settled'),
  id: z.string().min(1),
  at: z.iso.datetime(),
  outcome: z.string().min(1),
  answer: z.string().optional(),
  key: z.string().optional(),
  pairing: z.string().optional(),
})

export const auditLineSchema = z.discriminatedUnion('event', [ASKED_SCHEMA, SETTLED_SCHEMA])
