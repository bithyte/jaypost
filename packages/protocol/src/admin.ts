import { z } from 'zod'
import { botStateSchema } from './schema.ts'

/** Most characters a key label, key external id or bot label may have. */
export const MAX_LABEL_LENGTH = 200

const labelSchema = z.string().max(MAX_LABEL_LENGTH)

/** POST /admin/bots: a provider, its settings (never the owner) and an optional label. */
export const addBotBodySchema = z.strictObject({
  provider: z.string(),
  settings: z.record(z.string(), z.union([z.string(), z.number()])),
  label: labelSchema.optional(),
})

/** POST /admin/contacts: an approver invite on `bot`. */
export const createContactBodySchema = z.strictObject({ bot: z.string() })

/**
 * POST /admin/keys: exactly one of `bot` (a new contact), `contact` (an existing one) or
 * `sameAsKey` (the contact of that key), plus free-form details jaypost never interprets.
 */
export const createKeyBodySchema = z
  .strictObject({
    bot: z.string().optional(),
    contact: z.string().optional(),
    sameAsKey: z.string().optional(),
    label: labelSchema.optional(),
    externalId: labelSchema.optional(),
  })
  .refine(
    (body) =>
      [body.bot, body.contact, body.sameAsKey].filter((target) => target !== undefined).length ===
      1,
    { message: 'exactly one of bot, contact and sameAsKey is required' },
  )

/** PATCH /admin/keys/:id: a string sets the field, null deletes it, absent keeps it. */
export const updateKeyBodySchema = z.strictObject({
  label: labelSchema.nullable().optional(),
  externalId: labelSchema.nullable().optional(),
})

/** One stored bot as the admin sees it; never its settings. Unknown fields are kept. */
export const adminBotSchema = z.looseObject({
  id: z.string(),
  provider: z.string(),
  label: z.string().optional(),
  displayName: z.string().optional(),
  state: botStateSchema,
  error: z.string().optional(),
  contactCount: z.number(),
  keyCount: z.number(),
})

/** One contact; `code` (formatted) while pending, `person` once paired. Unknown fields are kept. */
export const adminContactSchema = z.looseObject({
  id: z.string(),
  bot: z.string(),
  person: z.string().optional(),
  state: z.enum(['paired', 'pending']),
  code: z.string().optional(),
  keys: z.array(z.string()),
})

/** One API key without its hash. Unknown fields are kept. */
export const adminKeySchema = z.looseObject({
  id: z.string(),
  contact: z.string(),
  bot: z.string(),
  label: z.string().optional(),
  externalId: z.string().optional(),
  createdAt: z.string(),
})

/** POST /admin/keys: the only place the plaintext `key` is ever shown. */
export const createdKeySchema = z.looseObject({
  id: z.string(),
  key: z.string(),
  contact: z.string(),
  code: z.string().optional(),
  instructions: z.string().optional(),
})

/** POST /admin/contacts and POST /admin/contacts/:id/reset; `code` while the contact waits. */
export const contactInviteSchema = z.looseObject({
  contact: adminContactSchema,
  code: z.string().optional(),
  instructions: z.string().optional(),
})

/** One question in a log; `bot` is set on admin reads. Unknown fields are kept. */
export const logEntrySchema = z.looseObject({
  id: z.string(),
  askedAt: z.string(),
  project: z.string().optional(),
  text: z.string(),
  options: z.array(z.string()),
  timeoutOption: z.string(),
  timeoutSeconds: z.number(),
  status: z.string(),
  answer: z.string().optional(),
  settledAt: z.string().optional(),
  key: z.string().optional(),
  contact: z.string().optional(),
  bot: z.string().optional(),
})

/** GET /log and GET /admin/log: entries oldest first, and how many lines couldn't be read. */
export const logPageSchema = z.looseObject({
  entries: z.array(logEntrySchema),
  skippedCount: z.number(),
})

/** DELETE /admin/bots/:id and DELETE /admin/contacts/:id: the keys that went with it. */
export const removedKeysSchema = z.looseObject({ removedKeys: z.array(z.string()) })

/** POST /admin/admin-key: the new admin key; the old one stopped working. */
export const rotatedAdminKeySchema = z.looseObject({ adminKey: z.string() })

/** GET /admin/bots. Unknown fields are kept. */
export const botListSchema = z.looseObject({ bots: z.array(adminBotSchema) })

/** POST /admin/bots: the bot just added, already starting. Unknown fields are kept. */
export const addedBotSchema = z.looseObject({ bot: adminBotSchema })

/** GET /admin/contacts. Unknown fields are kept. */
export const contactListSchema = z.looseObject({ contacts: z.array(adminContactSchema) })

/** GET /admin/keys. Unknown fields are kept. */
export const keyListSchema = z.looseObject({ keys: z.array(adminKeySchema) })

/** PATCH /admin/keys/:id: the key as it is now. Unknown fields are kept. */
export const updatedKeySchema = z.looseObject({ key: adminKeySchema })

/** DELETE /admin/keys/:id: an empty object. Unknown fields are kept. */
export const revokedKeySchema = z.looseObject({})
