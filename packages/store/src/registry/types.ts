import type { Provider, SettingValues } from '@jaypost/core'

/** A provider runtime with its credentials; the owner setting is never stored here. */
export type BotRecord = {
  readonly id: string
  readonly provider: string
  readonly settings: SettingValues
  readonly label?: string
  readonly createdAt: string
}

/** No `person` means pending: it has a `code` and waits for someone to redeem it. */
export type PairingRecord = {
  readonly id: string
  readonly botId: string
  readonly person?: string
  readonly code?: string
  readonly quietHours?: string
  readonly mutedUntil?: string
  readonly createdAt: string
}

/** `hash` is absent only for the seed key of a tokenless install. */
export type KeyRecord = {
  readonly id: string
  readonly pairingId: string
  readonly hash?: string
  readonly label?: string
  readonly externalId?: string
  readonly createdAt: string
}

/** What init/env seeded: bot 1, pairing 1 and key 1, and whether calls without a token act as key 1. */
export type SeedRecord = {
  readonly fingerprint: string
  readonly botId: string
  readonly pairingId: string
  readonly keyId: string
  readonly isOpen: boolean
}

/** Every bot, pairing and API key of an install. */
export type Registry = {
  readonly version: 1
  /** Ids are never reused, so an old audit line can't be read as a new key's. */
  readonly lastIds: {
    readonly bot: number
    readonly pairing: number
    readonly key: number
  }
  readonly bots: readonly BotRecord[]
  readonly pairings: readonly PairingRecord[]
  readonly keys: readonly KeyRecord[]
  readonly seed?: SeedRecord
}

/** Which pairing a new key points to. */
export type KeyTarget =
  | { readonly kind: 'newPairing'; readonly botId: string }
  | { readonly kind: 'pairing'; readonly pairingId: string }
  | { readonly kind: 'sameAsKey'; readonly keyId: string }

/** Bot 1, pairing 1 and key 1 as init or the env describe them; `fingerprint` changes with them. */
export type SeedInput = {
  readonly fingerprint: string
  readonly provider: string
  readonly settings: SettingValues
  readonly owner?: string
  readonly tokenHash?: string
  readonly quietHours?: string
  readonly mutedUntil?: string
}

export type BotInput = {
  readonly provider: Provider
  readonly settings: SettingValues
  readonly label?: string
}

/** Free-form key details jaypost stores and never interprets. */
export type KeyDetails = {
  readonly label?: string
  readonly externalId?: string
}

/** Key details to change; `null` deletes the field. */
export type KeyPatch = {
  readonly label?: string | null
  readonly externalId?: string | null
}

export type NotFound = {
  readonly kind: 'notFound'
  readonly what: 'bot' | 'pairing' | 'key'
  readonly id: string
}

export type AddBotResult =
  | { readonly kind: 'added'; readonly registry: Registry; readonly bot: BotRecord }
  | { readonly kind: 'duplicate'; readonly botId: string }

/** `keyIds` are the removed keys, so the caller can cancel their questions. */
export type RemoveResult =
  | { readonly kind: 'removed'; readonly registry: Registry; readonly keyIds: readonly string[] }
  | NotFound

export type CreatePairingResult =
  | { readonly kind: 'created'; readonly registry: Registry; readonly pairing: PairingRecord }
  | NotFound

export type CreateKeyResult =
  | {
      readonly kind: 'created'
      readonly registry: Registry
      readonly key: KeyRecord
      readonly pairing: PairingRecord
    }
  | NotFound

/** `merged` means the person was already paired on the bot, so `pairing` is that older one. */
export type ClaimPairingResult =
  | { readonly kind: 'claimed'; readonly registry: Registry; readonly pairing: PairingRecord }
  | { readonly kind: 'merged'; readonly registry: Registry; readonly pairing: PairingRecord }
  | NotFound

export type ResetPairingResult =
  | { readonly kind: 'reset'; readonly registry: Registry; readonly pairing: PairingRecord }
  | NotFound

export type RevokeKeyResult = { readonly kind: 'revoked'; readonly registry: Registry } | NotFound

export type UpdateKeyResult =
  | { readonly kind: 'updated'; readonly registry: Registry; readonly key: KeyRecord }
  | NotFound

/**
 * `isNew` means this call created the seed record (the registry had none); it doesn't mean the
 * registry was empty, and it is false on an update that changed the registry.
 */
export type SeedResult = {
  readonly registry: Registry
  readonly isNew: boolean
}
