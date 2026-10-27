import { findOwnerSetting, listSecretValues } from '@jaypost/core'
import type { QuietPatch, SettingValues } from '@jaypost/core'
import {
  BOT_ID_PREFIX,
  KEY_ID_PREFIX,
  LOCAL_PERSON,
  NOT_PENDING,
  PAIRING_ID_PREFIX,
  REGISTRY_VERSION,
} from './constants.ts'
import { isPending } from './queries.ts'
import type {
  AddBotResult,
  BotInput,
  BotRecord,
  ClaimPairingResult,
  CreateKeyResult,
  CreatePairingResult,
  KeyDetails,
  KeyPatch,
  KeyRecord,
  KeyTarget,
  NotFound,
  PairingRecord,
  Registry,
  RemoveResult,
  ResetPairingResult,
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

function replacePairing(registry: Registry, pairing: PairingRecord): Registry {
  return {
    ...registry,
    pairings: registry.pairings.map((other) => (other.id === pairing.id ? pairing : other)),
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

function insertPairing(
  registry: Registry,
  fields: Omit<PairingRecord, 'id'>,
): Added<PairingRecord> {
  const number = registry.lastIds.pairing + 1
  const record = { id: `${PAIRING_ID_PREFIX}${number}`, ...fields }
  return {
    registry: {
      ...registry,
      lastIds: { ...registry.lastIds, pairing: number },
      pairings: [...registry.pairings, record],
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

/** A pending pairing with `code`, or without `pairs` the bot's one local pairing. */
function addPairing(
  registry: Registry,
  botId: string,
  code: string,
  pairs: boolean,
  at: Date,
): Added<PairingRecord> {
  if (!pairs) {
    const local = registry.pairings.find(
      (pairing) => pairing.botId === botId && pairing.person === LOCAL_PERSON,
    )
    if (local !== undefined) {
      return { registry, record: local }
    }
  }
  return insertPairing(registry, {
    botId,
    ...(pairs ? { code } : { person: LOCAL_PERSON }),
    createdAt: at.toISOString(),
  })
}

/** Moves every key of the `fromIds` pairings to `into` and deletes those pairings. */
function mergePairings(
  registry: Registry,
  fromIds: readonly string[],
  into: PairingRecord,
): Registry {
  const seed = registry.seed
  return {
    ...registry,
    pairings: registry.pairings.filter((pairing) => !fromIds.includes(pairing.id)),
    keys: registry.keys.map((key) =>
      fromIds.includes(key.pairingId) ? { ...key, pairingId: into.id } : key,
    ),
    ...(seed === undefined
      ? {}
      : { seed: fromIds.includes(seed.pairingId) ? { ...seed, pairingId: into.id } : seed }),
  }
}

function claim(
  registry: Registry,
  pairing: PairingRecord,
  person: string,
): Exclude<ClaimPairingResult, typeof NOT_PENDING> {
  const existing = registry.pairings.find(
    (other) => other.id !== pairing.id && other.botId === pairing.botId && other.person === person,
  )
  if (existing !== undefined) {
    return {
      kind: 'merged',
      registry: mergePairings(registry, [pairing.id], existing),
      pairing: existing,
    }
  }
  const { code: _code, ...rest } = pairing
  const claimed = { ...rest, person }
  return { kind: 'claimed', registry: replacePairing(registry, claimed), pairing: claimed }
}

function toPending(pairing: PairingRecord, code: string): PairingRecord {
  const { person: _person, code: _code, ...rest } = pairing
  return { ...rest, code }
}

function insertSeedPairing(
  registry: Registry,
  botId: string,
  seed: SeedInput,
  pairs: boolean,
  generateCode: () => string,
  at: Date,
): Added<PairingRecord> {
  const person = pairs ? seed.owner : LOCAL_PERSON
  return insertPairing(registry, {
    botId,
    ...(person === undefined ? { code: generateCode() } : { person }),
    ...(seed.quietHours === undefined ? {} : { quietHours: seed.quietHours }),
    ...(seed.mutedUntil === undefined ? {} : { mutedUntil: seed.mutedUntil }),
    createdAt: at.toISOString(),
  })
}

function insertSeedKey(
  registry: Registry,
  pairingId: string,
  seed: SeedInput,
  at: Date,
): Added<KeyRecord> {
  return insertKey(registry, {
    pairingId,
    ...(seed.tokenHash === undefined ? {} : { hash: seed.tokenHash }),
    createdAt: at.toISOString(),
  })
}

function toSeedRecord(
  seed: SeedInput,
  botId: string,
  pairingId: string,
  keyId: string,
): SeedRecord {
  return {
    fingerprint: seed.fingerprint,
    botId,
    pairingId,
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
  const pairing = insertSeedPairing(bot.registry, bot.record.id, seed, pairs, generateCode, at)
  const key = insertSeedKey(pairing.registry, pairing.record.id, seed, at)
  return {
    ...key.registry,
    seed: toSeedRecord(seed, bot.record.id, pairing.record.id, key.record.id),
  }
}

/** Updates the seed bot in place, or re-creates it; a new provider resets its pairings. */
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
      pairings: updated.pairings.map((pairing) =>
        pairing.botId === botId ? toPending(pairing, generateCode()) : pairing,
      ),
    },
    record: bot,
  }
}

/**
 * The seed pairing on `botId`; when it is gone, the bot's pairing for the seed person (the owner,
 * or `LOCAL_PERSON` without `pairs`), so there is still one pairing per bot and person.
 */
function findSeedPairing(
  registry: Registry,
  pairingId: string,
  botId: string,
  person: string | undefined,
): PairingRecord | undefined {
  const seedPairing = registry.pairings.find(
    (pairing) => pairing.id === pairingId && pairing.botId === botId,
  )
  if (seedPairing !== undefined || person === undefined) {
    return seedPairing
  }
  return registry.pairings.find((pairing) => pairing.botId === botId && pairing.person === person)
}

/** A bot that doesn't pair has one local pairing, so every other one folds into `pairing`. */
function foldIntoLocal(registry: Registry, pairing: PairingRecord): Added<PairingRecord> {
  const { code: _code, ...rest } = pairing
  const local = { ...rest, person: LOCAL_PERSON }
  const otherIds = registry.pairings
    .filter((other) => other.botId === pairing.botId && other.id !== pairing.id)
    .map((other) => other.id)
  return {
    registry: mergePairings(replacePairing(registry, local), otherIds, local),
    record: local,
  }
}

/** The seed pairing on `botId`, re-created if gone, claimed by the owner when it has no person. */
function updateSeedPairing(
  registry: Registry,
  pairingId: string,
  botId: string,
  seed: SeedInput,
  pairs: boolean,
  generateCode: () => string,
  at: Date,
): Added<PairingRecord> {
  const found = findSeedPairing(registry, pairingId, botId, pairs ? seed.owner : LOCAL_PERSON)
  const resolved =
    found === undefined
      ? insertSeedPairing(registry, botId, seed, pairs, generateCode, at)
      : { registry, record: found }
  if (!pairs) {
    return foldIntoLocal(resolved.registry, resolved.record)
  }
  if (resolved.record.person !== undefined || seed.owner === undefined) {
    return resolved
  }
  const claimed = claim(resolved.registry, resolved.record, seed.owner)
  return { registry: claimed.registry, record: claimed.pairing }
}

function updateSeedKey(
  registry: Registry,
  keyId: string,
  pairingId: string,
  seed: SeedInput,
  at: Date,
): Added<KeyRecord> {
  const existing = registry.keys.find((key) => key.id === keyId)
  if (existing === undefined) {
    return insertSeedKey(registry, pairingId, seed, at)
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
  const pairing = updateSeedPairing(
    bot.registry,
    record.pairingId,
    bot.record.id,
    seed,
    pairs,
    generateCode,
    at,
  )
  const key = updateSeedKey(pairing.registry, record.keyId, pairing.record.id, seed, at)
  return {
    ...key.registry,
    seed: toSeedRecord(seed, bot.record.id, pairing.record.id, key.record.id),
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
    lastIds: { bot: 0, pairing: 0, key: 0 },
    bots: [],
    pairings: [],
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

/** Removes a bot with its pairings and their keys. Never throws. */
export function removeBot(registry: Registry, botId: string): RemoveResult {
  if (!registry.bots.some((bot) => bot.id === botId)) {
    return notFound('bot', botId)
  }
  const pairingIds = registry.pairings
    .filter((pairing) => pairing.botId === botId)
    .map((pairing) => pairing.id)
  const keyIds = registry.keys
    .filter((key) => pairingIds.includes(key.pairingId))
    .map((key) => key.id)
  return {
    kind: 'removed',
    registry: {
      ...registry,
      bots: registry.bots.filter((bot) => bot.id !== botId),
      pairings: registry.pairings.filter((pairing) => pairing.botId !== botId),
      keys: registry.keys.filter((key) => !keyIds.includes(key.id)),
    },
    keyIds,
  }
}

/**
 * A pending pairing waiting for `code`. Without `pairs` (the provider has no owner setting) it is
 * the bot's one local pairing instead, created claimed if missing. Never throws.
 */
export function createPairing(
  registry: Registry,
  botId: string,
  code: string,
  pairs: boolean,
  at: Date,
): CreatePairingResult {
  if (!registry.bots.some((bot) => bot.id === botId)) {
    return notFound('bot', botId)
  }
  const added = addPairing(registry, botId, code, pairs, at)
  return { kind: 'created', registry: added.registry, pairing: added.record }
}

/**
 * A key on `target`'s pairing; a `newPairing` target creates one as `createPairing` does. `code`
 * is used only for a new pending pairing. Never throws.
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
    pairingId: resolved.record.id,
    hash,
    ...(details.label === undefined ? {} : { label: details.label }),
    ...(details.externalId === undefined ? {} : { externalId: details.externalId }),
    createdAt: at.toISOString(),
  })
  return { kind: 'created', registry: added.registry, key: added.record, pairing: resolved.record }
}

function resolveKeyTarget(
  registry: Registry,
  target: KeyTarget,
  code: string,
  pairs: boolean,
  at: Date,
): Added<PairingRecord> | NotFound {
  switch (target.kind) {
    case 'newPairing': {
      if (!registry.bots.some((bot) => bot.id === target.botId)) {
        return notFound('bot', target.botId)
      }
      return addPairing(registry, target.botId, code, pairs, at)
    }
    case 'pairing': {
      const pairing = registry.pairings.find((other) => other.id === target.pairingId)
      return pairing === undefined
        ? notFound('pairing', target.pairingId)
        : { registry, record: pairing }
    }
    case 'sameAsKey': {
      const key = registry.keys.find((other) => other.id === target.keyId)
      if (key === undefined) {
        return notFound('key', target.keyId)
      }
      const pairing = registry.pairings.find((other) => other.id === key.pairingId)
      return pairing === undefined
        ? notFound('pairing', key.pairingId)
        : { registry, record: pairing }
    }
  }
}

/**
 * `person` redeemed the code of a pending pairing on `botId`. One pairing per bot and person: when
 * another pairing on the bot has them, this one's keys move there and it is deleted (`merged`). A
 * pairing that isn't pending on `botId` (a late code from a replaced runtime) is `notPending`, so
 * a person already set is never replaced. Never throws.
 */
export function claimPairing(
  registry: Registry,
  botId: string,
  pairingId: string,
  person: string,
): ClaimPairingResult {
  const pairing = registry.pairings.find((other) => other.id === pairingId)
  if (pairing === undefined || pairing.botId !== botId || !isPending(pairing)) {
    return NOT_PENDING
  }
  return claim(registry, pairing, person)
}

/**
 * Drops the pairing's person and makes it wait for `code`; keys and quiet settings stay. `pairs`
 * says whether the pairing's bot pairs; without it the reset is `notPairing`. Never throws.
 */
export function resetPairing(
  registry: Registry,
  pairingId: string,
  code: string,
  pairs: boolean,
): ResetPairingResult {
  const pairing = registry.pairings.find((other) => other.id === pairingId)
  if (pairing === undefined) {
    return notFound('pairing', pairingId)
  }
  if (!pairs) {
    return { kind: 'notPairing', botId: pairing.botId }
  }
  const pending = toPending(pairing, code)
  return { kind: 'reset', registry: replacePairing(registry, pending), pairing: pending }
}

/** Removes one key; its pairing stays. Never throws. */
export function revokeKey(registry: Registry, keyId: string): RevokeKeyResult {
  if (!registry.keys.some((key) => key.id === keyId)) {
    return notFound('key', keyId)
  }
  return {
    kind: 'revoked',
    registry: { ...registry, keys: registry.keys.filter((key) => key.id !== keyId) },
  }
}

/** Removes a pairing and its keys. Never throws. */
export function removePairing(registry: Registry, pairingId: string): RemoveResult {
  if (!registry.pairings.some((pairing) => pairing.id === pairingId)) {
    return notFound('pairing', pairingId)
  }
  const keyIds = registry.keys.filter((key) => key.pairingId === pairingId).map((key) => key.id)
  return {
    kind: 'removed',
    registry: {
      ...registry,
      pairings: registry.pairings.filter((pairing) => pairing.id !== pairingId),
      keys: registry.keys.filter((key) => key.pairingId !== pairingId),
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

/** Applies a quiet patch to one pairing; an unknown pairing returns `registry` as is. */
export function updatePairingQuiet(
  registry: Registry,
  pairingId: string,
  patch: QuietPatch,
): Registry {
  const existing = registry.pairings.find((pairing) => pairing.id === pairingId)
  if (existing === undefined) {
    return registry
  }
  const { quietHours: currentQuietHours, mutedUntil: currentMutedUntil, ...rest } = existing
  const quietHours = resolvePatchedValue(currentQuietHours, patch.quietHours)
  const mutedUntil = resolvePatchedValue(currentMutedUntil, patch.mutedUntil)
  return replacePairing(registry, {
    ...rest,
    ...(quietHours === undefined ? {} : { quietHours }),
    ...(mutedUntil === undefined ? {} : { mutedUntil }),
  })
}

/**
 * Seeds bot 1, pairing 1 and key 1 from init or the env. A registry without a seed record gets
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
