import { timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  formatCode,
  generateCode as generateDefaultCode,
  isPairingProvider,
  parseQuietHours,
  resolveMaxAttachmentBytes,
} from '@jaypost/core'
import type { CredentialCheck, Provider, QuietHours, QuietPatch } from '@jaypost/core'
import {
  addBot,
  AUTHORIZATION_PATTERN,
  claimCode,
  countBotRecords,
  createKey,
  createContact,
  findKeyRoute,
  findContactOf,
  generateAdminKey,
  generateApiKey,
  hashKey,
  isPending,
  isSeedLine,
  listKeys,
  readAuditEntries,
  removeBot,
  removeContact,
  resetContact,
  revokeKey,
  selectAuditEntries,
  updateKey,
  updateContactQuiet,
  writeAdminKeyFile,
} from '@jaypost/store'
import type {
  AuditEntry,
  AuditReadResult,
  BotRecord,
  ClaimCodeResult,
  KeyLookup,
  KeyTarget,
  ContactRecord,
  Registry,
  RegistryStore,
} from '@jaypost/store'
import type {
  AddBotBody,
  AdminBot,
  AdminKey,
  AdminPairing,
  CreatedKey,
  CreateKeyBody,
  CreatePairingBody,
  PairingInvite,
  RemovedKeys,
  RotatedAdminKey,
  StatusInfo,
  UpdateKeyBody,
} from '@jaypost/protocol'
import { NO_BOT_LIMITS } from '../server/index.ts'
import type {
  AdminApi,
  AdminFailure,
  AdminLogQuery,
  BotRoute,
  BotRouter,
  KeyRoute,
  LogQuery,
  OpenApiOptions,
} from '../server/index.ts'
import {
  parseBotSettings,
  toAdminKey,
  toAdminPairing,
  toInvalid,
  toKeyDetails,
  toKeyTarget,
  toNotFound,
} from './admin.ts'
import { startBot } from './bot.ts'
import { BotSupervisor } from './supervisor.ts'
import type { BotPeople, BotState, HubOptions, RunningBot } from './types.ts'

type Limits = Omit<OpenApiOptions, 'port' | 'version'>

/** The limits a provider's bots answer with, as /status and /openapi.yaml show them. */
function toProviderLimits(provider: Provider): Limits {
  return {
    maxAttachmentBytes: resolveMaxAttachmentBytes(provider),
    maxTextLength: provider.maxTextLength,
    ...(provider.maxOptionCount === undefined ? {} : { maxOptionCount: provider.maxOptionCount }),
  }
}

/** The smallest of each limit, so the document holds for every bot. */
function toSmallestLimits(left: Limits, right: Limits): Limits {
  const maxOptionCount =
    left.maxOptionCount === undefined || right.maxOptionCount === undefined
      ? (left.maxOptionCount ?? right.maxOptionCount)
      : Math.min(left.maxOptionCount, right.maxOptionCount)
  return {
    maxAttachmentBytes: Math.min(left.maxAttachmentBytes, right.maxAttachmentBytes),
    maxTextLength: Math.min(left.maxTextLength, right.maxTextLength),
    ...(maxOptionCount === undefined ? {} : { maxOptionCount }),
  }
}

/** A contact's stored quiet settings as a `QuietService` takes them; bad values are left out. */
function toQuiet(contact: ContactRecord | undefined): {
  readonly quietHours?: QuietHours
  readonly mutedUntil?: Date
} {
  const parsed = contact?.quietHours === undefined ? undefined : parseQuietHours(contact.quietHours)
  const mutedUntil = contact?.mutedUntil === undefined ? undefined : new Date(contact.mutedUntil)
  return {
    ...(parsed?.ok === true ? { quietHours: parsed.value } : {}),
    ...(mutedUntil === undefined || Number.isNaN(mutedUntil.getTime()) ? {} : { mutedUntil }),
  }
}

function toDuplicate(botId: string): AdminFailure {
  return { kind: 'duplicate', error: `bot ${botId} already uses these credentials` }
}

/**
 * Owns the registry: keeps it in memory, runs one `BotSupervisor` per stored bot, routes each API
 * call by its key to that key's bot and person, and serves the admin routes. Every change applies
 * a registry operation, saves it, and only then swaps the registry in memory and updates the
 * running bots, so a failed save throws and changes nothing. The one exception is a pairing claim
 * from the chat: it stays in memory when the save fails, and that's logged.
 */
export class Hub implements AdminApi {
  readonly #store: RegistryStore
  readonly #providersByName: ReadonlyMap<string, Provider>
  readonly #version: string
  readonly #now: () => Date
  readonly #database: DatabaseSync
  readonly #generateCode: () => string
  readonly #log: (line: string) => void
  readonly #supervisors = new Map<string, BotSupervisor>()
  readonly #router: BotRouter
  #registry: Registry
  readonly #adminKeyPath: string
  #adminKeyHash: string
  #isRecovering = false
  #isStopped = false
  #started: Promise<void> = Promise.resolve()

  constructor(options: HubOptions) {
    this.#database = options.database
    this.#store = options.store
    this.#registry = options.registry
    this.#providersByName = new Map(options.providers.map((provider) => [provider.name, provider]))
    this.#adminKeyPath = options.adminKeyPath
    this.#adminKeyHash = hashKey(options.adminKey)
    this.#version = options.version
    this.#now = options.now ?? (() => new Date())
    this.#generateCode = options.generateCode ?? generateDefaultCode
    this.#log = options.log ?? console.error
    this.#router = {
      route: (authorization) => this.#route(authorization),
      openApi: () => this.#describeOpenApi(),
    }
  }

  /** The registry in memory: as last saved, plus any chat pairing claim whose save failed. */
  get registry(): Registry {
    return this.#registry
  }

  get router(): BotRouter {
    return this.#router
  }

  /**
   * Resolves once every bot `start` found has made its first attempt, whether it succeeded or
   * failed. Never rejects. The API doesn't wait for it: a bot still starting answers 503.
   */
  get started(): Promise<void> {
    return this.#started
  }

  /** Starts a supervisor per stored bot without waiting; failed bots keep retrying with backoff. */
  start(): void {
    this.#started = Promise.all(
      this.#registry.bots.map((record) => this.#supervise(record.id)),
    ).then(() => undefined)
  }

  /** Cleans up after the previous run: every running bot now, and bots that start later at once. */
  async recover(): Promise<void> {
    this.#isRecovering = true
    await Promise.all(
      [...this.#supervisors.values()].map((supervisor) => {
        const { state } = supervisor
        return state.kind === 'running' ? state.running.recover() : undefined
      }),
    )
  }

  /** Stops every bot; each freezes its saved state before the first await. Never rejects. */
  async stop(): Promise<void> {
    this.#isStopped = true
    await Promise.all([...this.#supervisors.values()].map((supervisor) => supervisor.stop()))
  }

  /** Whether `authorization` carries the admin key, compared in constant time. Never throws. */
  isAdmin(authorization: string | undefined): boolean {
    const presented =
      authorization === undefined ? undefined : AUTHORIZATION_PATTERN.exec(authorization)?.[1]
    if (presented === undefined) {
      return false
    }
    // Both are sha256 hex digests, so the lengths always match.
    return timingSafeEqual(Buffer.from(hashKey(presented)), Buffer.from(this.#adminKeyHash))
  }

  listBots(): { readonly bots: readonly AdminBot[] } {
    return { bots: this.#registry.bots.map((record) => this.#describeBot(record)) }
  }

  /**
   * Parses the settings, refuses credentials a stored bot already uses (409), asks the provider to
   * check them (400 with its reason), then saves the bot and waits for its first start attempt.
   * Never logs or returns a setting's value. Throws when the save fails.
   */
  async addBot(body: AddBotBody): Promise<{ readonly bot: AdminBot } | AdminFailure> {
    const provider = this.#providersByName.get(body.provider)
    if (provider === undefined) {
      const names = [...this.#providersByName.keys()].map((name) => JSON.stringify(name))
      return toInvalid(`provider must be one of ${names.join(', ')}`)
    }
    const settings = parseBotSettings(provider, body.settings)
    if (!settings.ok) {
      return toInvalid(settings.error)
    }
    const input = {
      provider,
      settings: settings.value,
      ...(body.label === undefined ? {} : { label: body.label }),
    }
    const early = addBot(this.#registry, input, this.#now())
    if (early.kind === 'duplicate') {
      return toDuplicate(early.botId)
    }
    let check: CredentialCheck
    try {
      check = await provider.setup.checkCredentials(settings.value)
    } catch {
      // The error may quote a request URL that holds the token.
      return toInvalid(`couldn't check the credentials with ${provider.name}`)
    }
    if (!check.ok) {
      return toInvalid(check.reason)
    }
    // The registry may have changed while the provider answered.
    const result = addBot(this.#registry, input, this.#now())
    if (result.kind === 'duplicate') {
      return toDuplicate(result.botId)
    }
    this.#commit(result.registry)
    this.#log(`added bot ${result.bot.id} (${provider.name})`)
    // A bot added while the service stops would outlive it; the next start runs it.
    if (!this.#isStopped) {
      await this.#supervise(result.bot.id)
    }
    return { bot: this.#describeBot(result.bot) }
  }

  /**
   * Removes the bot with its contacts and keys, then stops its runtime, rejecting every open
   * question with its timeout option. Its questions stay readable in the log until they're 30
   * days old; its contacts, keys and saved state are deleted. Throws when the save fails.
   */
  async removeBot(botId: string): Promise<RemovedKeys | AdminFailure> {
    const result = removeBot(this.#registry, botId)
    if (result.kind === 'notFound') {
      return toNotFound(result)
    }
    this.#commit(result.registry)
    const supervisor = this.#supervisors.get(botId)
    this.#supervisors.delete(botId)
    this.#log(`removed bot ${botId}`)
    await supervisor?.abandon()
    return { removedKeys: [...result.keyIds] }
  }

  listPairings(query: {
    readonly bot?: string
  }): { readonly pairings: readonly AdminPairing[] } | AdminFailure {
    const { bot } = query
    if (bot !== undefined && this.#findBot(bot) === undefined) {
      return toNotFound({ kind: 'notFound', what: 'bot', id: bot })
    }
    const { contacts, keys } = this.#registry
    return {
      pairings: contacts
        .filter((contact) => bot === undefined || contact.botId === bot)
        .map((contact) => toAdminPairing(contact, keys)),
    }
  }

  /**
   * An approver invite: a pending contact whose code goes to its running bot at once. A bot that
   * doesn't pair answers with its one local contact. Throws when the save fails.
   */
  createPairing(body: CreatePairingBody): PairingInvite | AdminFailure {
    const result = createContact(
      this.#registry,
      body.bot,
      this.#generateCode(),
      this.#isPairingBot(body.bot),
      this.#now(),
    )
    if (result.kind === 'notFound') {
      return toNotFound(result)
    }
    this.#commit(result.registry)
    return this.#invite(result.contact)
  }

  /**
   * Drops the contact's person and gives it a new code; its keys and quiet settings stay. Their
   * open questions are rejected with their timeout option, since nobody can answer them now.
   * Throws when the save fails.
   */
  resetPairing(contactId: string): PairingInvite | AdminFailure {
    const contact = this.#findContact(contactId)
    if (contact === undefined) {
      return toNotFound({ kind: 'notFound', what: 'contact', id: contactId })
    }
    const result = resetContact(
      this.#registry,
      contactId,
      this.#generateCode(),
      this.#isPairingBot(contact.botId),
    )
    if (result.kind === 'notFound') {
      return toNotFound(result)
    }
    if (result.kind === 'notPairing') {
      return toInvalid(`pairing ${contactId} is on bot ${result.botId}, which doesn't pair`)
    }
    this.#commit(result.registry)
    this.#release(contact, this.#listKeyIds(contactId))
    return this.#invite(result.contact)
  }

  /**
   * Removes the contact and its keys; their open questions are rejected with their timeout option
   * and a pending code stops working. Throws when the save fails.
   */
  removePairing(contactId: string): RemovedKeys | AdminFailure {
    const contact = this.#findContact(contactId)
    const result = removeContact(this.#registry, contactId)
    if (result.kind === 'notFound' || contact === undefined) {
      return toNotFound({ kind: 'notFound', what: 'contact', id: contactId })
    }
    this.#commit(result.registry)
    this.#release(contact, result.keyIds)
    return { removedKeys: [...result.keyIds] }
  }

  listKeys(query: {
    readonly bot?: string
    readonly pairing?: string
  }): { readonly keys: readonly AdminKey[] } | AdminFailure {
    const result = listKeys(this.#registry, {
      ...(query.bot === undefined ? {} : { bot: query.bot }),
      ...(query.pairing === undefined ? {} : { contact: query.pairing }),
    })
    if (result.kind === 'notFound') {
      return toNotFound(result)
    }
    return { keys: result.keys.map(({ key, botId }) => toAdminKey(key, botId)) }
  }

  /**
   * A new key on the body's contact, saved before it takes effect; the plaintext key is returned
   * only here. A new pending contact's code goes to its running bot at once. Throws when the save
   * fails.
   */
  createKey(body: CreateKeyBody): CreatedKey | AdminFailure {
    const target = toKeyTarget(body)
    if (target === undefined) {
      return toInvalid('exactly one of bot, pairing and sameAsKey is required')
    }
    const key = generateApiKey()
    const result = createKey(
      this.#registry,
      target,
      hashKey(key),
      toKeyDetails(body),
      // Only a new contact uses the code.
      target.kind === 'newContact' ? this.#generateCode() : '',
      this.#isPairingTarget(target),
      this.#now(),
    )
    if (result.kind === 'notFound') {
      return toNotFound(result)
    }
    this.#commit(result.registry)
    const { code, instructions } = this.#invite(result.contact)
    return {
      id: result.key.id,
      key,
      pairing: result.contact.id,
      ...(code === undefined ? {} : { code }),
      ...(instructions === undefined ? {} : { instructions }),
    }
  }

  /** Sets or (with null) deletes a key's label and external id. Throws when the save fails. */
  updateKey(keyId: string, body: UpdateKeyBody): { readonly key: AdminKey } | AdminFailure {
    const result = updateKey(this.#registry, keyId, {
      ...(body.label === undefined ? {} : { label: body.label }),
      ...(body.externalId === undefined ? {} : { externalId: body.externalId }),
    })
    if (result.kind === 'notFound') {
      return toNotFound(result)
    }
    this.#commit(result.registry)
    const contact = this.#findContact(result.key.contactId)
    return { key: toAdminKey(result.key, contact?.botId ?? '') }
  }

  /**
   * Removes the key, then rejects its open questions with their timeout option. Throws when the
   * save fails.
   */
  revokeKey(keyId: string): Readonly<Record<string, never>> | AdminFailure {
    const contact = this.#findContactOfKey(keyId)
    const result = revokeKey(this.#registry, keyId)
    if (result.kind === 'notFound') {
      return toNotFound(result)
    }
    this.#commit(result.registry)
    if (contact !== undefined) {
      this.#findRunning(contact.botId)?.bot.rejectForKeys([keyId])
    }
    return {}
  }

  /**
   * Every bot's questions, removed bots' included (or one bot's, stored or not), each with its bot,
   * merged oldest first and then filtered. Lines from before keys existed are the seed key's.
   * `pairing` and `key` may name removed ones, so their history stays readable. Throws when a log
   * can't be read.
   */
  readLog(query: AdminLogQuery): AuditReadResult | AdminFailure {
    const { entries, skippedCount } = readAuditEntries(this.#database, this.#now(), query.bot)
    const merged = entries
      .map(({ botId, entry }) => this.#toAdminEntry(botId, entry))
      .toSorted((left, right) => left.askedAt.localeCompare(right.askedAt))
    return { entries: selectAuditEntries(merged, query), skippedCount }
  }

  /**
   * Writes a new admin key to the admin key file, then swaps it in; the old key stops working at
   * once. Throws when the write fails, and the old key keeps working.
   */
  rotateAdminKey(): RotatedAdminKey {
    const adminKey = generateAdminKey()
    writeAdminKeyFile(this.#adminKeyPath, adminKey)
    this.#adminKeyHash = hashKey(adminKey)
    this.#log('rotated the admin key')
    return { adminKey }
  }

  #commit(registry: Registry): void {
    this.#store.save(registry)
    this.#registry = registry
  }

  /** A contact as an invite: its code and instructions while pending, sent to its running bot. */
  #invite(contact: ContactRecord): PairingInvite {
    const shown = toAdminPairing(contact, this.#registry.keys)
    if (!isPending(contact)) {
      return { pairing: shown }
    }
    const instructions = this.#findRunning(contact.botId)?.bot.pairingInstructions?.(contact.code)
    return {
      pairing: shown,
      code: formatCode(contact.code),
      ...(instructions === undefined ? {} : { instructions }),
    }
  }

  /** The contact's person is gone: the bot forgets them and their keys' questions are rejected. */
  #release(contact: ContactRecord, keyIds: readonly string[]): void {
    const running = this.#findRunning(contact.botId)
    if (contact.person !== undefined) {
      running?.forgetPerson(contact.person)
    }
    running?.bot.rejectForKeys(keyIds)
  }

  #describeBot(record: BotRecord): AdminBot {
    const state = this.#findState(record.id)
    const displayName =
      state.kind === 'running' ? state.running.bot.describe().displayName : undefined
    const { contactCount, keyCount } = countBotRecords(this.#registry, record.id)
    return {
      id: record.id,
      provider: record.provider,
      ...(record.label === undefined ? {} : { label: record.label }),
      ...(displayName === undefined ? {} : { displayName }),
      state: state.kind,
      ...(state.kind === 'failed' ? { error: state.reason } : {}),
      pairingCount: contactCount,
      keyCount,
    }
  }

  /** An entry of `botId`'s log with its bot; a seed bot line without a key is the seed key's. */
  #toAdminEntry(botId: string, entry: AuditEntry): AuditEntry {
    const { seed } = this.#registry
    return {
      ...entry,
      ...(seed !== undefined && isSeedLine(this.#registry, botId, entry)
        ? { key: seed.keyId, pairing: seed.contactId }
        : {}),
      bot: botId,
    }
  }

  #supervise(botId: string): Promise<void> {
    let attemptCount = 0
    const supervisor: BotSupervisor = new BotSupervisor({
      start: () => {
        attemptCount += 1
        const attempt = attemptCount
        // A late fatal from a runtime already replaced must not stop the new one.
        return this.#startBot(botId, (message) => {
          if (attempt === attemptCount) {
            supervisor.fail(message)
          }
        })
      },
      log: (line) => this.#log(`[${botId}] ${line}`),
      onRunning: (running) => this.#prepareRunning(botId, running),
    })
    this.#supervisors.set(botId, supervisor)
    return supervisor.run()
  }

  async #startBot(botId: string, fatal: (message: string) => void): Promise<RunningBot> {
    const record = this.#findBot(botId)
    if (record === undefined) {
      throw new Error(`bot ${JSON.stringify(botId)} is no longer stored`)
    }
    const provider = this.#providersByName.get(record.provider)
    if (provider === undefined) {
      throw new Error(`unknown provider ${JSON.stringify(record.provider)}`)
    }
    return startBot({
      record,
      provider,
      database: this.#database,
      people: this.#createPeople(botId),
      fatal,
      log: this.#log,
    })
  }

  /** Runs once the supervisor has accepted a started bot. */
  #prepareRunning(botId: string, running: RunningBot): void {
    this.#logSeedCode(botId, running)
    if (this.#isRecovering) {
      void running.recover()
    }
  }

  /**
   * The pairing instruction for the install's own pending contact, as the daemon always logged it.
   */
  #logSeedCode(botId: string, running: RunningBot): void {
    const seed = this.#registry.seed
    if (seed?.botId !== botId) {
      return
    }
    const contact = this.#registry.contacts.find((other) => other.id === seed.contactId)
    const instructions = running.bot.pairingInstructions
    if (contact === undefined || !isPending(contact) || instructions === undefined) {
      return
    }
    this.#log(`[${botId}] Not paired. ${instructions(contact.code)}`)
  }

  #createPeople(botId: string): BotPeople {
    return {
      isPaired: (person) => findContactOf(this.#registry, botId, person) !== undefined,
      list: () => [
        ...new Set(
          this.#registry.contacts.flatMap((contact) =>
            contact.botId === botId && contact.person !== undefined ? [contact.person] : [],
          ),
        ),
      ],
      claim: (text, person) => this.#claim(botId, text, person),
      quietHours: (person) => toQuiet(findContactOf(this.#registry, botId, person)),
      saveQuiet: (person, patch) => this.#saveQuiet(botId, person, patch),
    }
  }

  #claim(botId: string, text: string, person: string): ClaimCodeResult['kind'] {
    const result = claimCode(this.#registry, botId, text, person)
    if (result.kind === 'wrong' || result.kind === 'noCodes') {
      return result.kind
    }
    this.#registry = result.registry
    try {
      this.#store.save(result.registry)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#log(
        `[${botId}] paired ${person} but couldn't save the registry: ${message}; it'll be lost on restart`,
      )
    }
    return result.kind
  }

  #saveQuiet(botId: string, person: string, patch: QuietPatch): void {
    const contact = findContactOf(this.#registry, botId, person)
    if (contact === undefined) {
      throw new Error(`${person} isn't paired on ${botId}`)
    }
    this.#commit(updateContactQuiet(this.#registry, contact.id, patch))
  }

  #route(authorization: string | undefined): BotRoute {
    const found = this.#findKeyRoute(authorization)
    if (found.kind !== 'found') {
      return { kind: 'unauthorized', reason: found.kind }
    }
    const { key, contact } = found
    const running = this.#findRunning(contact.botId)
    const route: KeyRoute = {
      kind: 'key',
      caller: { key: key.id, pairing: contact.id },
      person: contact.person,
      bot: running?.bot,
      status: () => this.#describeStatus(key.id, contact),
      readLog: (query) => this.#readLog(key.id, contact.botId, query),
    }
    return route
  }

  #findKeyRoute(authorization: string | undefined): KeyLookup {
    if (authorization === undefined) {
      return findKeyRoute(this.#registry, undefined)
    }
    const presented = AUTHORIZATION_PATTERN.exec(authorization)?.[1]
    if (presented === undefined) {
      return { kind: 'wrong' }
    }
    // Hashes of random keys: comparing them leaks nothing about the keys themselves.
    const hash = hashKey(presented)
    return hash === this.#adminKeyHash ? { kind: 'wrong' } : findKeyRoute(this.#registry, hash)
  }

  /** /status for a key, from the registry as it is now; `routed` stands in once it's gone. */
  #describeStatus(keyId: string, routed: ContactRecord): StatusInfo {
    const contact = this.#registry.contacts.find((other) => other.id === routed.id) ?? routed
    const record = this.#findBot(contact.botId)
    const provider = record === undefined ? undefined : this.#providersByName.get(record.provider)
    const state = this.#findState(contact.botId)
    const running = state.kind === 'running' ? state.running : undefined
    const described =
      running?.bot.describe() ?? (record === undefined ? {} : { provider: record.provider })
    const common = {
      key: keyId,
      pairing: contact.id,
      state: state.kind,
      ...(state.kind === 'failed' ? { error: state.reason } : {}),
      ...described,
    }
    const limits = provider === undefined ? {} : toProviderLimits(provider)
    if (!isPending(contact)) {
      return { paired: true, ...common, ...limits }
    }
    const instructions = running?.bot.pairingInstructions?.(contact.code)
    return {
      paired: false,
      ...common,
      code: formatCode(contact.code),
      ...(instructions === undefined ? {} : { instructions }),
      ...limits,
    }
  }

  /** The key's questions in its bot's log; lines from before keys existed are the seed key's. */
  #readLog(keyId: string, botId: string, query: LogQuery): AuditReadResult {
    const read = readAuditEntries(this.#database, this.#now(), botId)
    const entries = read.entries.map(({ entry }) => entry)
    const { skippedCount } = read
    const isSeedKey = this.#registry.seed?.keyId === keyId
    const own = entries.filter(
      (entry) => entry.key === keyId || (isSeedKey && isSeedLine(this.#registry, botId, entry)),
    )
    return { entries: selectAuditEntries(own, query), skippedCount }
  }

  #describeOpenApi(): Omit<OpenApiOptions, 'port'> {
    const limits = this.#registry.bots
      .flatMap((record) => this.#providersByName.get(record.provider) ?? [])
      .map(toProviderLimits)
      .reduce<Limits | undefined>(
        (smallest, next) => (smallest === undefined ? next : toSmallestLimits(smallest, next)),
        undefined,
      )
    return { version: this.#version, ...(limits ?? NO_BOT_LIMITS) }
  }

  /** Whether a new contact on the target's bot waits for a code; only `newContact` makes one. */
  #isPairingTarget(target: KeyTarget): boolean {
    return target.kind !== 'newContact' || this.#isPairingBot(target.botId)
  }

  /**
   * Whether the bot's provider pairs; a bot whose provider is gone can't run, and a code costs
   * nothing.
   */
  #isPairingBot(botId: string): boolean {
    const record = this.#findBot(botId)
    const provider = record === undefined ? undefined : this.#providersByName.get(record.provider)
    return provider === undefined || isPairingProvider(provider)
  }

  #findState(botId: string): BotState {
    return this.#supervisors.get(botId)?.state ?? { kind: 'failed', reason: 'not started' }
  }

  #findContact(contactId: string): ContactRecord | undefined {
    return this.#registry.contacts.find((contact) => contact.id === contactId)
  }

  #listKeyIds(contactId: string): readonly string[] {
    return this.#registry.keys.filter((key) => key.contactId === contactId).map((key) => key.id)
  }

  #findBot(botId: string): BotRecord | undefined {
    return this.#registry.bots.find((record) => record.id === botId)
  }

  #findContactOfKey(keyId: string): ContactRecord | undefined {
    const key = this.#registry.keys.find((other) => other.id === keyId)
    return key === undefined
      ? undefined
      : this.#registry.contacts.find((contact) => contact.id === key.contactId)
  }

  #findRunning(botId: string): RunningBot | undefined {
    const state = this.#supervisors.get(botId)?.state
    return state?.kind === 'running' ? state.running : undefined
  }
}
