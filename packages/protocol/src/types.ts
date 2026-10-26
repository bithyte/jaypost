import type { z } from 'zod'
import type {
  addBotBodySchema,
  adminBotSchema,
  adminKeySchema,
  adminPairingSchema,
  createdKeySchema,
  createKeyBodySchema,
  createPairingBodySchema,
  logEntrySchema,
  logPageSchema,
  pairingInviteSchema,
  removedKeysSchema,
  rotatedAdminKeySchema,
  updateKeyBodySchema,
} from './admin.ts'
import type { statusInfoSchema } from './schema.ts'

/** Body of /status: paired, or the pairing code to send to the bot. */
export type StatusInfo = Readonly<z.infer<typeof statusInfoSchema>>

export type AddBotBody = Readonly<z.infer<typeof addBotBodySchema>>
export type CreatePairingBody = Readonly<z.infer<typeof createPairingBodySchema>>
export type CreateKeyBody = Readonly<z.infer<typeof createKeyBodySchema>>
export type UpdateKeyBody = Readonly<z.infer<typeof updateKeyBodySchema>>
export type AdminBot = Readonly<z.infer<typeof adminBotSchema>>
export type AdminPairing = Readonly<z.infer<typeof adminPairingSchema>>
export type AdminKey = Readonly<z.infer<typeof adminKeySchema>>
export type CreatedKey = Readonly<z.infer<typeof createdKeySchema>>
export type PairingInvite = Readonly<z.infer<typeof pairingInviteSchema>>
export type LogEntry = Readonly<z.infer<typeof logEntrySchema>>
export type LogPage = Readonly<z.infer<typeof logPageSchema>>
export type RemovedKeys = Readonly<z.infer<typeof removedKeysSchema>>
export type RotatedAdminKey = Readonly<z.infer<typeof rotatedAdminKeySchema>>
