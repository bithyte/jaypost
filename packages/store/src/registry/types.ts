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
export type ContactRecord = {
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
  readonly contactId: string
  readonly hash?: string
  readonly label?: string
  readonly externalId?: string
  readonly createdAt: string
}

/** What init/env seeded: bot 1, contact 1 and key 1, and whether calls without a token act as key 1. */
export type SeedRecord = {
  readonly fingerprint: string
  readonly botId: string
  readonly contactId: string
  readonly keyId: string
  readonly isOpen: boolean
}

/** Every bot, contact and API key of an install. */
export type Registry = {
  readonly version: 1
  /** Ids are never reused, so an old audit line can't be read as a new key's. */
  readonly lastIds: {
    readonly bot: number
    readonly contact: number
    readonly key: number
  }
  readonly bots: readonly BotRecord[]
  readonly contacts: readonly ContactRecord[]
  readonly keys: readonly KeyRecord[]
  readonly seed?: SeedRecord
}

/** Which contact a new key points to. */
export type KeyTarget =
  | { readonly kind: 'newContact'; readonly botId: string }
  | { readonly kind: 'contact'; readonly contactId: string }
  | { readonly kind: 'sameAsKey'; readonly keyId: string }

/** Bot 1, contact 1 and key 1 as init or the env describe them; `fingerprint` changes with them. */
export type SeedInput = {
  readonly fingerprint: string
  readonly provider: string
  readonly settings: SettingValues
  readonly owner?: string
  readonly tokenHash?: string
  readonly quietHours?: string
  readonly mutedUntil?: string
}

/** What the env and config.json say bot 1, contact 1 and key 1 should be. */
export type SeedLoad =
  | { readonly kind: 'seed'; readonly provider: Provider; readonly seed: SeedInput }
  /** A required setting is absent; `message` says which and how to set it. */
  | { readonly kind: 'missing'; readonly message: string }

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
  readonly what: 'bot' | 'contact' | 'key'
  readonly id: string
}

export type AddBotResult =
  | { readonly kind: 'added'; readonly registry: Registry; readonly bot: BotRecord }
  | { readonly kind: 'duplicate'; readonly botId: string }

/** `keyIds` are the removed keys, so the caller can cancel their questions. */
export type RemoveResult =
  | { readonly kind: 'removed'; readonly registry: Registry; readonly keyIds: readonly string[] }
  | NotFound

export type CreateContactResult =
  | { readonly kind: 'created'; readonly registry: Registry; readonly contact: ContactRecord }
  | NotFound

export type CreateKeyResult =
  | {
      readonly kind: 'created'
      readonly registry: Registry
      readonly key: KeyRecord
      readonly contact: ContactRecord
    }
  | NotFound

/**
 * `merged` means the person was already paired on the bot, so `contact` is that older one.
 * `notPending` means the contact is gone, on another bot, or already has a person.
 */
export type ClaimContactResult =
  | { readonly kind: 'claimed'; readonly registry: Registry; readonly contact: ContactRecord }
  | { readonly kind: 'merged'; readonly registry: Registry; readonly contact: ContactRecord }
  | { readonly kind: 'notPending' }

/** `wrong` means no pending contact on the bot has the code; `noCodes` that none is pending. */
export type ClaimCodeResult =
  | Exclude<ClaimContactResult, { readonly kind: 'notPending' }>
  | { readonly kind: 'wrong' }
  | { readonly kind: 'noCodes' }

/** `notPairing` means the contact's bot doesn't pair, so nobody could claim the new code. */
export type ResetContactResult =
  | { readonly kind: 'reset'; readonly registry: Registry; readonly contact: ContactRecord }
  | { readonly kind: 'notPairing'; readonly botId: string }
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

/** A pending contact: no person yet, and the code that claims it. */
export type PendingContact = ContactRecord & { readonly code: string }

/**
 * What an API key reaches. `missing` is a call without a token on a seed that isn't open; `wrong`
 * is an unknown key, or one whose contact is gone.
 */
export type KeyLookup =
  | { readonly kind: 'found'; readonly key: KeyRecord; readonly contact: ContactRecord }
  | { readonly kind: 'missing' }
  | { readonly kind: 'wrong' }

export type BotRecordCounts = {
  readonly contactCount: number
  readonly keyCount: number
}

/** A key with the bot its contact is on. */
export type KeyOnBot = {
  readonly key: KeyRecord
  readonly botId: string
}

export type KeyFilter = {
  readonly bot?: string
  readonly contact?: string
}

export type ListKeysResult =
  | { readonly kind: 'listed'; readonly keys: readonly KeyOnBot[] }
  | NotFound
