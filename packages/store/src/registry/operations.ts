import { findOwnerSetting, listSecretValues, normalizeCode } from '@jaypost/core'
import type { QuietPatch, SettingValues } from '@jaypost/core'
import {
  BOT_ID_PREFIX,
  KEY_ID_PREFIX,
  LOCAL_PERSON,
  NO_CODES,
  NOT_PENDING,
  CONTACT_ID_PREFIX,
  REGISTRY_VERSION,
  WRONG_CODE,
} from './constants.ts'
import { isPending } from './queries.ts'
import type {
  AddBotResult,
  BotInput,
  BotRecord,
  ClaimCodeResult,
  ClaimContactResult,
  CreateKeyResult,
  CreateContactResult,
  KeyDetails,
  KeyPatch,
  KeyRecord,
  KeyTarget,
  NotFound,
  ContactRecord,
  Registry,
  RemoveResult,
  ResetContactResult,
  RevokeKeyResult,
  SeedInput,
  SeedRecord,
  SeedResult,
  UpdateKeyResult,
} from './types.ts'

type Added<T> = { readonly registry: Registry; readonly record: T }

function notFound(what: NotFound['what'], id: string): NotFound {
  return { kind: 'notFound', what, id }
}

function isSameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** `patch` undefined keeps `current`, null deletes it. */
function resolvePatchedValue(
  current: string | undefined,
  patch: string | null | undefined,
): string | undefined {
  if (patch === undefined) {
    return current
  }
  return patch === null ? undefined : patch
}

function replaceContact(registry: Registry, contact: ContactRecord): Registry {
  return {
    ...registry,
    contacts: registry.contacts.map((other) => (other.id === contact.id ? contact : other)),
  }
}

function insertBot(registry: Registry, fields: Omit<BotRecord, 'id'>): Added<BotRecord> {
  const number = registry.lastIds.bot + 1
  const record = { id: `${BOT_ID_PREFIX}${number}`, ...fields }
  return {
    registry: {
      ...registry,
      lastIds: { ...registry.lastIds, bot: number },
      bots: [...registry.bots, record],
    },
    record,
  }
}

function insertContact(
  registry: Registry,
  fields: Omit<ContactRecord, 'id'>,
): Added<ContactRecord> {
  const number = registry.lastIds.contact + 1
  const record = { id: `${CONTACT_ID_PREFIX}${number}`, ...fields }
  return {
    registry: {
      ...registry,
      lastIds: { ...registry.lastIds, contact: number },
      contacts: [...registry.contacts, record],
    },
    record,
  }
}

function insertKey(registry: Registry, fields: Omit<KeyRecord, 'id'>): Added<KeyRecord> {
  const number = registry.lastIds.key + 1
  const record = { id: `${KEY_ID_PREFIX}${number}`, ...fields }
  return {
    registry: {
      ...registry,
      lastIds: { ...registry.lastIds, key: number },
      keys: [...registry.keys, record],
    },
    record,
  }
}

/** A pending contact with `code`, or without `pairs` the bot's one local contact. */
function addContact(
  registry: Registry,
  botId: string,
  code: string,
  pairs: boolean,
  at: Date,
): Added<ContactRecord> {
  if (!pairs) {
    const local = registry.contacts.find(
      (contact) => contact.botId === botId && contact.person === LOCAL_PERSON,
    )
    if (local !== undefined) {
      return { registry, record: local }
    }
  }
  return insertContact(registry, {
    botId,
    ...(pairs ? { code } : { person: LOCAL_PERSON }),
    createdAt: at.toISOString(),
  })
}

/** Moves every key of the `fromIds` contacts to `into` and deletes those contacts. */
function mergeContacts(
  registry: Registry,
  fromIds: readonly string[],
  into: ContactRecord,
): Registry {
  const seed = registry.seed
  return {
    ...registry,
    contacts: registry.contacts.filter((contact) => !fromIds.includes(contact.id)),
    keys: registry.keys.map((key) =>
      fromIds.includes(key.contactId) ? { ...key, contactId: into.id } : key,
    ),
    ...(seed === undefined
      ? {}
      : { seed: fromIds.includes(seed.contactId) ? { ...seed, contactId: into.id } : seed }),
  }
}

function claim(
  registry: Registry,
  contact: ContactRecord,
  person: string,
): Exclude<ClaimContactResult, typeof NOT_PENDING> {
  const existing = registry.contacts.find(
    (other) => other.id !== contact.id && other.botId === contact.botId && other.person === person,
  )
  if (existing !== undefined) {
    return {
      kind: 'merged',
      registry: mergeContacts(registry, [contact.id], existing),
      contact: existing,
    }
  }
  const { code: _code, ...rest } = contact
  const claimed = { ...rest, person }
  return { kind: 'claimed', registry: replaceContact(registry, claimed), contact: claimed }
}

function toPending(contact: ContactRecord, code: string): ContactRecord {
  const { person: _person, code: _code, ...rest } = contact
  return { ...rest, code }
}

function insertSeedContact(
  registry: Registry,
  botId: string,
  seed: SeedInput,
  pairs: boolean,
  generateCode: () => string,
  at: Date,
): Added<ContactRecord> {
  const person = pairs ? seed.owner : LOCAL_PERSON
  return insertContact(registry, {
    botId,
    ...(person === undefined ? { code: generateCode() } : { person }),
    ...(seed.quietHours === undefined ? {} : { quietHours: seed.quietHours }),
    ...(seed.mutedUntil === undefined ? {} : { mutedUntil: seed.mutedUntil }),
    createdAt: at.toISOString(),
  })
}

function insertSeedKey(
  registry: Registry,
  contactId: string,
  seed: SeedInput,
  at: Date,
): Added<KeyRecord> {
  return insertKey(registry, {
    contactId,
    ...(seed.tokenHash === undefined ? {} : { hash: seed.tokenHash }),
    createdAt: at.toISOString(),
  })
}

function toSeedRecord(
  seed: SeedInput,
  botId: string,
  contactId: string,
  keyId: string,
): SeedRecord {
  return {
    fingerprint: seed.fingerprint,
    botId,
    contactId,
    keyId,
    isOpen: seed.tokenHash === undefined,
  }
}

function createSeed(
  registry: Registry,
  seed: SeedInput,
  pairs: boolean,
  generateCode: () => string,
  at: Date,
): Registry {
  const bot = insertBot(registry, {
    provider: seed.provider,
    settings: seed.settings,
    createdAt: at.toISOString(),
  })
  const contact = insertSeedContact(bot.registry, bot.record.id, seed, pairs, generateCode, at)
  const key = insertSeedKey(contact.registry, contact.record.id, seed, at)
  return {
    ...key.registry,
    seed: toSeedRecord(seed, bot.record.id, contact.record.id, key.record.id),
  }
}

/** Updates the seed bot in place, or re-creates it; a new provider resets its contacts. */
function updateSeedBot(
  registry: Registry,
  botId: string,
  seed: SeedInput,
  pairs: boolean,
  generateCode: () => string,
  at: Date,
): Added<BotRecord> {
  const existing = registry.bots.find((bot) => bot.id === botId)
  if (existing === undefined) {
    return insertBot(registry, {
      provider: seed.provider,
      settings: seed.settings,
      createdAt: at.toISOString(),
    })
  }
  const bot = { ...existing, provider: seed.provider, settings: seed.settings }
  const updated = {
    ...registry,
    bots: registry.bots.map((other) => (other.id === botId ? bot : other)),
  }
  if (existing.provider === seed.provider || !pairs) {
    return { registry: updated, record: bot }
  }
  return {
    registry: {
      ...updated,
      contacts: updated.contacts.map((contact) =>
        contact.botId === botId ? toPending(contact, generateCode()) : contact,
      ),
    },
    record: bot,
  }
}

/**
 * The seed contact on `botId`; when it is gone, the bot's contact for the seed person (the owner,
 * or `LOCAL_PERSON` without `pairs`), so there is still one contact per bot and person.
 */
function findSeedContact(
  registry: Registry,
  contactId: string,
  botId: string,
  person: string | undefined,
): ContactRecord | undefined {
  const seedContact = registry.contacts.find(
    (contact) => contact.id === contactId && contact.botId === botId,
  )
  if (seedContact !== undefined || person === undefined) {
    return seedContact
  }
  return registry.contacts.find((contact) => contact.botId === botId && contact.person === person)
}

/** A bot that doesn't pair has one local contact, so every other one folds into `contact`. */
function foldIntoLocal(registry: Registry, contact: ContactRecord): Added<ContactRecord> {
  const { code: _code, ...rest } = contact
  const local = { ...rest, person: LOCAL_PERSON }
  const otherIds = registry.contacts
    .filter((other) => other.botId === contact.botId && other.id !== contact.id)
    .map((other) => other.id)
  return {
    registry: mergeContacts(replaceContact(registry, local), otherIds, local),
    record: local,
  }
}

/** The seed contact on `botId`, re-created if gone, claimed by the owner when it has no person. */
function updateSeedContact(
  registry: Registry,
  contactId: string,
  botId: string,
  seed: SeedInput,
  pairs: boolean,
  generateCode: () => string,
  at: Date,
): Added<ContactRecord> {
  const found = findSeedContact(registry, contactId, botId, pairs ? seed.owner : LOCAL_PERSON)
  const resolved =
    found === undefined
      ? insertSeedContact(registry, botId, seed, pairs, generateCode, at)
      : { registry, record: found }
  if (!pairs) {
    return foldIntoLocal(resolved.registry, resolved.record)
  }
  if (resolved.record.person !== undefined || seed.owner === undefined) {
    return resolved
  }
  const claimed = claim(resolved.registry, resolved.record, seed.owner)
  return { registry: claimed.registry, record: claimed.contact }
}

function updateSeedKey(
  registry: Registry,
  keyId: string,
  contactId: string,
  seed: SeedInput,
  at: Date,
): Added<KeyRecord> {
  const existing = registry.keys.find((key) => key.id === keyId)
  if (existing === undefined) {
    return insertSeedKey(registry, contactId, seed, at)
  }
  const { hash: _hash, ...rest } = existing
  const key = { ...rest, ...(seed.tokenHash === undefined ? {} : { hash: seed.tokenHash }) }
  return {
    registry: {
      ...registry,
      keys: registry.keys.map((other) => (other.id === keyId ? key : other)),
    },
    record: key,
  }
}

function updateSeed(
  registry: Registry,
  record: SeedRecord,
  seed: SeedInput,
  pairs: boolean,
  generateCode: () => string,
  at: Date,
): Registry {
  const bot = updateSeedBot(registry, record.botId, seed, pairs, generateCode, at)
  const contact = updateSeedContact(
    bot.registry,
    record.contactId,
    bot.record.id,
    seed,
    pairs,
    generateCode,
    at,
  )
  const key = updateSeedKey(contact.registry, record.keyId, contact.record.id, seed, at)
  return {
    ...key.registry,
    seed: toSeedRecord(seed, bot.record.id, contact.record.id, key.record.id),
  }
}

/** The settings without the provider's owner setting, which a bot record never stores. */
export function withoutOwner(input: BotInput): SettingValues {
  const ownerSetting = findOwnerSetting(input.provider)
  if (ownerSetting === undefined) {
    return input.settings
  }
  return Object.fromEntries(
    Object.entries(input.settings).filter(([key]) => key !== ownerSetting.configKey),
  )
}

/** A registry with no records and every id counter at 0. */
export function createEmptyRegistry(): Registry {
  return {
    version: REGISTRY_VERSION,
    lastIds: { bot: 0, contact: 0, key: 0 },
    bots: [],
    contacts: [],
    keys: [],
  }
}

/**
 * Adds a bot without its owner setting. Refuses one whose provider and secret settings equal a
 * stored bot's, since two runtimes on one token fight over updates. Never throws.
 */
export function addBot(registry: Registry, input: BotInput, at: Date): AddBotResult {
  const secrets = listSecretValues(input.provider, input.settings)
  const duplicate = registry.bots.find(
    (bot) =>
      bot.provider === input.provider.name &&
      isSameValues(listSecretValues(input.provider, bot.settings), secrets),
  )
  if (duplicate !== undefined) {
    return { kind: 'duplicate', botId: duplicate.id }
  }
  const added = insertBot(registry, {
    provider: input.provider.name,
    settings: withoutOwner(input),
    ...(input.label === undefined ? {} : { label: input.label }),
    createdAt: at.toISOString(),
  })
  return { kind: 'added', registry: added.registry, bot: added.record }
}

/** Removes a bot with its contacts and their keys. Never throws. */
export function removeBot(registry: Registry, botId: string): RemoveResult {
  if (!registry.bots.some((bot) => bot.id === botId)) {
    return notFound('bot', botId)
  }
  const contactIds = registry.contacts
    .filter((contact) => contact.botId === botId)
    .map((contact) => contact.id)
  const keyIds = registry.keys
    .filter((key) => contactIds.includes(key.contactId))
    .map((key) => key.id)
  return {
    kind: 'removed',
    registry: {
      ...registry,
      bots: registry.bots.filter((bot) => bot.id !== botId),
      contacts: registry.contacts.filter((contact) => contact.botId !== botId),
      keys: registry.keys.filter((key) => !keyIds.includes(key.id)),
    },
    keyIds,
  }
}

/**
 * A pending contact waiting for `code`. Without `pairs` (the provider has no owner setting) it is
 * the bot's one local contact instead, created claimed if missing. Never throws.
 */
export function createContact(
  registry: Registry,
  botId: string,
  code: string,
  pairs: boolean,
  at: Date,
): CreateContactResult {
  if (!registry.bots.some((bot) => bot.id === botId)) {
    return notFound('bot', botId)
  }
  const added = addContact(registry, botId, code, pairs, at)
  return { kind: 'created', registry: added.registry, contact: added.record }
}

/**
 * A key on `target`'s contact; a `newContact` target creates one as `createContact` does. `code`
 * is used only for a new pending contact. Never throws.
 */
export function createKey(
  registry: Registry,
  target: KeyTarget,
  hash: string,
  details: KeyDetails,
  code: string,
  pairs: boolean,
  at: Date,
): CreateKeyResult {
  const resolved = resolveKeyTarget(registry, target, code, pairs, at)
  if ('kind' in resolved) {
    return resolved
  }
  const added = insertKey(resolved.registry, {
    contactId: resolved.record.id,
    hash,
    ...(details.label === undefined ? {} : { label: details.label }),
    ...(details.externalId === undefined ? {} : { externalId: details.externalId }),
    createdAt: at.toISOString(),
  })
  return { kind: 'created', registry: added.registry, key: added.record, contact: resolved.record }
}

function resolveKeyTarget(
  registry: Registry,
  target: KeyTarget,
  code: string,
  pairs: boolean,
  at: Date,
): Added<ContactRecord> | NotFound {
  switch (target.kind) {
    case 'newContact': {
      if (!registry.bots.some((bot) => bot.id === target.botId)) {
        return notFound('bot', target.botId)
      }
      return addContact(registry, target.botId, code, pairs, at)
    }
    case 'contact': {
      const contact = registry.contacts.find((other) => other.id === target.contactId)
      return contact === undefined
        ? notFound('contact', target.contactId)
        : { registry, record: contact }
    }
    case 'sameAsKey': {
      const key = registry.keys.find((other) => other.id === target.keyId)
      if (key === undefined) {
        return notFound('key', target.keyId)
      }
      const contact = registry.contacts.find((other) => other.id === key.contactId)
      return contact === undefined
        ? notFound('contact', key.contactId)
        : { registry, record: contact }
    }
  }
}

/**
 * `person` redeemed the code of a pending contact on `botId`. One contact per bot and person: when
 * another contact on the bot has them, this one's keys move there and it is deleted (`merged`). A
 * contact that isn't pending on `botId` (a late code from a replaced runtime) is `notPending`, so
 * a person already set is never replaced. Never throws.
 */
export function claimContact(
  registry: Registry,
  botId: string,
  contactId: string,
  person: string,
): ClaimContactResult {
  const contact = registry.contacts.find((other) => other.id === contactId)
  if (contact === undefined || contact.botId !== botId || !isPending(contact)) {
    return NOT_PENDING
  }
  return claim(registry, contact, person)
}

/**
 * `person` sent `text` to `botId`: claims the bot's pending contact whose code it is (case, dashes
 * and whitespace ignored), merging like `claimContact`. A code already claimed, reset or removed is
 * `wrong`. Never throws.
 */
export function claimCode(
  registry: Registry,
  botId: string,
  text: string,
  person: string,
): ClaimCodeResult {
  const pending = registry.contacts.filter((contact) => contact.botId === botId).filter(isPending)
  if (pending.length === 0) {
    return NO_CODES
  }
  const typed = normalizeCode(text)
  const contact = pending.find((other) => normalizeCode(other.code) === typed)
  return contact === undefined ? WRONG_CODE : claim(registry, contact, person)
}

/**
 * Drops the contact's person and makes it wait for `code`; keys and quiet settings stay. `pairs`
 * says whether the contact's bot pairs; without it the reset is `notPairing`. Never throws.
 */
export function resetContact(
  registry: Registry,
  contactId: string,
  code: string,
  pairs: boolean,
): ResetContactResult {
  const contact = registry.contacts.find((other) => other.id === contactId)
  if (contact === undefined) {
    return notFound('contact', contactId)
  }
  if (!pairs) {
    return { kind: 'notPairing', botId: contact.botId }
  }
  const pending = toPending(contact, code)
  return { kind: 'reset', registry: replaceContact(registry, pending), contact: pending }
}

/** Removes one key; its contact stays. Never throws. */
export function revokeKey(registry: Registry, keyId: string): RevokeKeyResult {
  if (!registry.keys.some((key) => key.id === keyId)) {
    return notFound('key', keyId)
  }
  return {
    kind: 'revoked',
    registry: { ...registry, keys: registry.keys.filter((key) => key.id !== keyId) },
  }
}

/** Removes a contact and its keys. Never throws. */
export function removeContact(registry: Registry, contactId: string): RemoveResult {
  if (!registry.contacts.some((contact) => contact.id === contactId)) {
    return notFound('contact', contactId)
  }
  const keyIds = registry.keys.filter((key) => key.contactId === contactId).map((key) => key.id)
  return {
    kind: 'removed',
    registry: {
      ...registry,
      contacts: registry.contacts.filter((contact) => contact.id !== contactId),
      keys: registry.keys.filter((key) => key.contactId !== contactId),
    },
    keyIds,
  }
}

/** Sets the patch's string fields and deletes its null ones. Never throws. */
export function updateKey(registry: Registry, keyId: string, patch: KeyPatch): UpdateKeyResult {
  const existing = registry.keys.find((key) => key.id === keyId)
  if (existing === undefined) {
    return notFound('key', keyId)
  }
  const { label: currentLabel, externalId: currentExternalId, ...rest } = existing
  const label = resolvePatchedValue(currentLabel, patch.label)
  const externalId = resolvePatchedValue(currentExternalId, patch.externalId)
  const key = {
    ...rest,
    ...(label === undefined ? {} : { label }),
    ...(externalId === undefined ? {} : { externalId }),
  }
  return {
    kind: 'updated',
    registry: {
      ...registry,
      keys: registry.keys.map((other) => (other.id === keyId ? key : other)),
    },
    key,
  }
}

/** Applies a quiet patch to one contact; an unknown contact returns `registry` as is. */
export function updateContactQuiet(
  registry: Registry,
  contactId: string,
  patch: QuietPatch,
): Registry {
  const existing = registry.contacts.find((contact) => contact.id === contactId)
  if (existing === undefined) {
    return registry
  }
  const { quietHours: currentQuietHours, mutedUntil: currentMutedUntil, ...rest } = existing
  const quietHours = resolvePatchedValue(currentQuietHours, patch.quietHours)
  const mutedUntil = resolvePatchedValue(currentMutedUntil, patch.mutedUntil)
  return replaceContact(registry, {
    ...rest,
    ...(quietHours === undefined ? {} : { quietHours }),
    ...(mutedUntil === undefined ? {} : { mutedUntil }),
  })
}

/**
 * Seeds bot 1, contact 1 and key 1 from init or the env. A registry without a seed record gets
 * them created (`isNew`, which means the seed record was created, not that the registry was empty
 * or that anything changed); an unchanged fingerprint returns `registry` as is, so admin changes survive a
 * restart; a new fingerprint updates the seed records in place, re-creating any that were
 * removed under new ids. Never throws.
 */
export function applySeed(
  registry: Registry,
  seed: SeedInput,
  pairs: boolean,
  generateCode: () => string,
  at: Date,
): SeedResult {
  if (registry.seed === undefined) {
    return { registry: createSeed(registry, seed, pairs, generateCode, at), isNew: true }
  }
  if (registry.seed.fingerprint === seed.fingerprint) {
    return { registry, isNew: false }
  }
  return {
    registry: updateSeed(registry, registry.seed, seed, pairs, generateCode, at),
    isNew: false,
  }
}
