import type { AuditEntry } from '../audit/types.ts'
import type {
  BotRecordCounts,
  KeyFilter,
  KeyLookup,
  KeyRecord,
  ListKeysResult,
  PairingRecord,
  PendingPairing,
  Registry,
} from './types.ts'

export function isPending(pairing: PairingRecord): pairing is PendingPairing {
  return pairing.person === undefined && pairing.code !== undefined
}

/**
 * The key stored with `hash` and its pairing; without a hash (a call without a token), the seed
 * key when the seed is open. A hashless seed key never matches a hash. Never throws.
 */
export function findKeyRoute(registry: Registry, hash: string | undefined): KeyLookup {
  const key =
    hash === undefined ? findOpenKey(registry) : registry.keys.find((other) => other.hash === hash)
  if (key === undefined) {
    return hash === undefined ? { kind: 'missing' } : { kind: 'wrong' }
  }
  const pairing = registry.pairings.find((other) => other.id === key.pairingId)
  return pairing === undefined ? { kind: 'wrong' } : { kind: 'found', key, pairing }
}

/** The pairing `person` has on `botId`, or undefined. Never throws. */
export function findPairingOf(
  registry: Registry,
  botId: string,
  person: string,
): PairingRecord | undefined {
  return registry.pairings.find((pairing) => pairing.botId === botId && pairing.person === person)
}

/** How many pairings `botId` has, and how many keys those pairings have. Never throws. */
export function countBotRecords(registry: Registry, botId: string): BotRecordCounts {
  const pairingIds = registry.pairings
    .filter((pairing) => pairing.botId === botId)
    .map((pairing) => pairing.id)
  return {
    pairingCount: pairingIds.length,
    keyCount: registry.keys.filter((key) => pairingIds.includes(key.pairingId)).length,
  }
}

/** Every key with its bot, narrowed by `filter`; an unknown bot or pairing is `notFound`. */
export function listKeys(registry: Registry, filter: KeyFilter): ListKeysResult {
  const { bot, pairing } = filter
  if (bot !== undefined && !registry.bots.some((record) => record.id === bot)) {
    return { kind: 'notFound', what: 'bot', id: bot }
  }
  if (pairing !== undefined && !registry.pairings.some((other) => other.id === pairing)) {
    return { kind: 'notFound', what: 'pairing', id: pairing }
  }
  return {
    kind: 'listed',
    keys: registry.keys.flatMap((key) => {
      const found = registry.pairings.find((other) => other.id === key.pairingId)
      const isMatch =
        found !== undefined &&
        (bot === undefined || found.botId === bot) &&
        (pairing === undefined || found.id === pairing)
      return isMatch ? [{ key, botId: found.botId }] : []
    }),
  }
}

/**
 * Whether a line of `botId`'s log belongs to the seed key without saying so: asked before keys
 * existed, on the seed bot. Never throws.
 */
export function isSeedLine(registry: Registry, botId: string, entry: AuditEntry): boolean {
  return entry.key === undefined && registry.seed?.botId === botId
}

function findOpenKey(registry: Registry): KeyRecord | undefined {
  const { seed } = registry
  return seed?.isOpen === true ? registry.keys.find((key) => key.id === seed.keyId) : undefined
}
