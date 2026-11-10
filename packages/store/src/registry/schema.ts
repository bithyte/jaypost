import { z } from 'zod'
import { REGISTRY_VERSION } from './constants.ts'

const idCounterSchema = z.number().int().nonnegative()

// Loose objects throughout, so fields a newer version adds survive a read-modify-write.
export const registrySchema = z.looseObject({
  version: z.literal(REGISTRY_VERSION),
  lastIds: z.looseObject({ bot: idCounterSchema, contact: idCounterSchema, key: idCounterSchema }),
  bots: z.array(
    z.looseObject({
      id: z.string(),
      provider: z.string(),
      settings: z.record(z.string(), z.union([z.string(), z.number()])),
      label: z.string().optional(),
      createdAt: z.string(),
    }),
  ),
  contacts: z.array(
    z.looseObject({
      id: z.string(),
      botId: z.string(),
      person: z.string().optional(),
      code: z.string().optional(),
      quietHours: z.string().optional(),
      mutedUntil: z.string().optional(),
      createdAt: z.string(),
    }),
  ),
  keys: z.array(
    z.looseObject({
      id: z.string(),
      contactId: z.string(),
      hash: z.string().optional(),
      label: z.string().optional(),
      externalId: z.string().optional(),
      createdAt: z.string(),
    }),
  ),
  seed: z
    .looseObject({
      fingerprint: z.string(),
      botId: z.string(),
      contactId: z.string(),
      keyId: z.string(),
      isOpen: z.boolean(),
    })
    .optional(),
})
