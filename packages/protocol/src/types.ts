import type { z } from 'zod'
import type {
  addBotBodySchema,
  addedBotSchema,
  adminBotSchema,
  adminKeySchema,
  adminPairingSchema,
  botListSchema,
  createdKeySchema,
  createKeyBodySchema,
  createPairingBodySchema,
  keyListSchema,
  logEntrySchema,
  logPageSchema,
  pairingInviteSchema,
  pairingListSchema,
  removedKeysSchema,
  revokedKeySchema,
  rotatedAdminKeySchema,
  updatedKeySchema,
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
export type BotsBody = Readonly<z.infer<typeof botListSchema>>
export type AddedBotBody = Readonly<z.infer<typeof addedBotSchema>>
export type PairingsBody = Readonly<z.infer<typeof pairingListSchema>>
export type KeysBody = Readonly<z.infer<typeof keyListSchema>>
export type UpdatedKeyBody = Readonly<z.infer<typeof updatedKeySchema>>
export type RevokedKey = Readonly<z.infer<typeof revokedKeySchema>>
