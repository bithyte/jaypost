import type { AuditEntry } from '../audit/types.ts'
import type {
  BotRecordCounts,
  KeyFilter,
  KeyLookup,
  KeyRecord,
  ListKeysResult,
  ContactRecord,
  PendingContact,
  Registry,
} from './types.ts'

export function isPending(contact: ContactRecord): contact is PendingContact {
  return contact.person === undefined && contact.code !== undefined
}

/**
 * The key stored with `hash` and its contact; without a hash (a call without a token), the seed
 * key when the seed is open. A hashless seed key never matches a hash. Never throws.
 */
export function findKeyRoute(registry: Registry, hash: string | undefined): KeyLookup {
  const key =
    hash === undefined ? findOpenKey(registry) : registry.keys.find((other) => other.hash === hash)
  if (key === undefined) {
    return hash === undefined ? { kind: 'missing' } : { kind: 'wrong' }
  }
  const contact = registry.contacts.find((other) => other.id === key.contactId)
  return contact === undefined ? { kind: 'wrong' } : { kind: 'found', key, contact }
}

/** The contact `person` has on `botId`, or undefined. Never throws. */
export function findContactOf(
  registry: Registry,
  botId: string,
  person: string,
): ContactRecord | undefined {
  return registry.contacts.find((contact) => contact.botId === botId && contact.person === person)
}

/** How many contacts `botId` has, and how many keys those contacts have. Never throws. */
export function countBotRecords(registry: Registry, botId: string): BotRecordCounts {
  const contactIds = registry.contacts
    .filter((contact) => contact.botId === botId)
    .map((contact) => contact.id)
  return {
    contactCount: contactIds.length,
    keyCount: registry.keys.filter((key) => contactIds.includes(key.contactId)).length,
  }
}

/** Every key with its bot, narrowed by `filter`; an unknown bot or contact is `notFound`. */
export function listKeys(registry: Registry, filter: KeyFilter): ListKeysResult {
  const { bot, contact } = filter
  if (bot !== undefined && !registry.bots.some((record) => record.id === bot)) {
    return { kind: 'notFound', what: 'bot', id: bot }
  }
  if (contact !== undefined && !registry.contacts.some((other) => other.id === contact)) {
    return { kind: 'notFound', what: 'contact', id: contact }
  }
  return {
    kind: 'listed',
    keys: registry.keys.flatMap((key) => {
      const found = registry.contacts.find((other) => other.id === key.contactId)
      const isMatch =
        found !== undefined &&
        (bot === undefined || found.botId === bot) &&
        (contact === undefined || found.id === contact)
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
