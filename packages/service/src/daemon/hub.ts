import { timingSafeEqual } from 'node:crypto'
import {
  findOwnerSetting,
  formatCode,
  generateCode as generateDefaultCode,
  parseQuietHours,
  resolveMaxAttachmentBytes,
} from '@jaypost/core'
import type { CredentialCheck, Provider, QuietHours, QuietPatch } from '@jaypost/core'
import {
  addBot,
  AUTHORIZATION_PATTERN,
  claimPairing,
  createKey,
  createPairing,
  findKeyByHash,
  generateAdminKey,
  generateApiKey,
  hashKey,
  parseAuditLog,
  readAuditFiles,
  removeBot,
  removePairing,
  resetPairing,
  resolveBotFiles,
  revokeKey,
  selectAuditEntries,
  updateKey,
  updatePairingQuiet,
  writeAdminKeyFile,
} from '@jaypost/store'
import type {
  AuditEntry,
  AuditReadResult,
  BotRecord,
  KeyRecord,
  KeyTarget,
  PairingRecord,
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

/** A pairing's stored quiet settings as a `QuietService` takes them; bad values are left out. */
function toQuiet(pairing: PairingRecord | undefined): {
  readonly quietHours?: QuietHours
  readonly mutedUntil?: Date
} {
  const parsed = pairing?.quietHours === undefined ? undefined : parseQuietHours(pairing.quietHours)
  const mutedUntil = pairing?.mutedUntil === undefined ? undefined : new Date(pairing.mutedUntil)
  return {
    ...(parsed?.ok === true ? { quietHours: parsed.value } : {}),
    ...(mutedUntil === undefined || Number.isNaN(mutedUntil.getTime()) ? {} : { mutedUntil }),
  }
}

function isPending(pairing: PairingRecord): pairing is PairingRecord & { readonly code: string } {
  return pairing.person === undefined && pairing.code !== undefined
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
  readonly #configPath: string
  readonly #version: string
  readonly #now: () => Date
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
    this.#store = options.store
    this.#registry = options.registry
    this.#providersByName = new Map(options.providers.map((provider) => [provider.name, provider]))
    this.#configPath = options.configPath
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
   * Removes the bot with its pairings and keys, then stops its runtime, rejecting every open
   * question with its timeout option. Its files stay. Throws when the save fails.
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
    const { pairings, keys } = this.#registry
    return {
      pairings: pairings
        .filter((pairing) => bot === undefined || pairing.botId === bot)
        .map((pairing) => toAdminPairing(pairing, keys)),
    }
  }

  /**
   * An approver invite: a pending pairing whose code goes to its running bot at once. A bot that
   * doesn't pair answers with its one local pairing. Throws when the save fails.
   */
  createPairing(body: CreatePairingBody): PairingInvite | AdminFailure {
    const result = createPairing(
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
    return this.#invite(result.pairing)
  }

  /**
   * Drops the pairing's person and gives it a new code; its keys and quiet settings stay. Their
   * open questions are rejected with their timeout option, since nobody can answer them now.
   * Throws when the save fails.
   */
  resetPairing(pairingId: string): PairingInvite | AdminFailure {
    const pairing = this.#findPairing(pairingId)
    if (pairing === undefined) {
      return toNotFound({ kind: 'notFound', what: 'pairing', id: pairingId })
    }
    if (!this.#isPairingBot(pairing.botId)) {
      return toInvalid(`pairing ${pairingId} is on bot ${pairing.botId}, which doesn't pair`)
    }
    const result = resetPairing(this.#registry, pairingId, this.#generateCode())
    if (result.kind === 'notFound') {
      return toNotFound(result)
    }
    this.#commit(result.registry)
    this.#release(pairing, this.#listKeyIds(pairingId))
    return this.#invite(result.pairing)
  }

  /**
   * Removes the pairing and its keys; their open questions are rejected with their timeout option
   * and a pending code stops working. Throws when the save fails.
   */
  removePairing(pairingId: string): RemovedKeys | AdminFailure {
    const pairing = this.#findPairing(pairingId)
    const result = removePairing(this.#registry, pairingId)
    if (result.kind === 'notFound' || pairing === undefined) {
      return toNotFound({ kind: 'notFound', what: 'pairing', id: pairingId })
    }
    this.#commit(result.registry)
    this.#findRunning(pairing.botId)?.codes.remove(pairingId)
    this.#release(pairing, result.keyIds)
    return { removedKeys: [...result.keyIds] }
  }

  listKeys(query: {
    readonly bot?: string
    readonly pairing?: string
  }): { readonly keys: readonly AdminKey[] } | AdminFailure {
    if (query.bot !== undefined && this.#findBot(query.bot) === undefined) {
      return toNotFound({ kind: 'notFound', what: 'bot', id: query.bot })
    }
    if (query.pairing !== undefined && this.#findPairing(query.pairing) === undefined) {
      return toNotFound({ kind: 'notFound', what: 'pairing', id: query.pairing })
    }
    return {
      keys: this.#registry.keys.flatMap((key) => {
        const pairing = this.#findPairing(key.pairingId)
        const isMatch =
          pairing !== undefined &&
          (query.bot === undefined || pairing.botId === query.bot) &&
          (query.pairing === undefined || pairing.id === query.pairing)
        return isMatch ? [toAdminKey(key, pairing.botId)] : []
      }),
    }
  }

  /**
   * A new key on the body's pairing, saved before it takes effect; the plaintext key is returned
   * only here. A new pending pairing's code goes to its running bot at once. Throws when the save
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
      // Only a new pairing uses the code.
      target.kind === 'newPairing' ? this.#generateCode() : '',
      this.#isPairingTarget(target),
      this.#now(),
    )
    if (result.kind === 'notFound') {
      return toNotFound(result)
    }
    this.#commit(result.registry)
    const { code, instructions } = this.#invite(result.pairing)
    return {
      id: result.key.id,
      key,
      pairing: result.pairing.id,
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
    const pairing = this.#findPairing(result.key.pairingId)
    return { key: toAdminKey(result.key, pairing?.botId ?? '') }
  }

  /** Removes the key, then rejects its open questions with their timeout option. Throws when the save fails. */
  revokeKey(keyId: string): Readonly<Record<string, never>> | AdminFailure {
    const pairing = this.#findPairingOfKey(keyId)
    const result = revokeKey(this.#registry, keyId)
    if (result.kind === 'notFound') {
      return toNotFound(result)
    }
    this.#commit(result.registry)
    if (pairing !== undefined) {
      this.#findRunning(pairing.botId)?.bot.rejectForKeys([keyId])
    }
    return {}
  }

  /**
   * Every stored bot's questions (or one bot's), each with its bot, merged oldest first and then
   * filtered. Lines from before keys existed are the seed key's. `pairing` and `key` may name
   * removed ones, so their history stays readable. Throws when a log can't be read.
   */
  readLog(query: AdminLogQuery): AuditReadResult | AdminFailure {
    const { bot } = query
    const record = bot === undefined ? undefined : this.#findBot(bot)
    if (bot !== undefined && record === undefined) {
      return toNotFound({ kind: 'notFound', what: 'bot', id: bot })
    }
    const now = this.#now()
    const entries: AuditEntry[] = []
    let skippedCount = 0
    for (const { id } of record === undefined ? this.#registry.bots : [record]) {
      const raw = readAuditFiles(resolveBotFiles(this.#configPath, id).auditPath)
      const read = parseAuditLog(raw, now)
      skippedCount += read.skippedCount
      entries.push(...read.entries.map((entry) => this.#toAdminEntry(id, entry)))
    }
    const merged = entries.toSorted((left, right) => left.askedAt.localeCompare(right.askedAt))
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

  /** A pairing as an invite: its code and instructions while pending, sent to its running bot. */
  #invite(pairing: PairingRecord): PairingInvite {
    const shown = toAdminPairing(pairing, this.#registry.keys)
    if (!isPending(pairing)) {
      return { pairing: shown }
    }
    const running = this.#findRunning(pairing.botId)
    running?.codes.add(pairing.id, pairing.code)
    const instructions = running?.bot.pairingInstructions?.(pairing.code)
    return {
      pairing: shown,
      code: formatCode(pairing.code),
      ...(instructions === undefined ? {} : { instructions }),
    }
  }

  /** The pairing's person is gone: their bot forgets them and their keys' questions are rejected. */
  #release(pairing: PairingRecord, keyIds: readonly string[]): void {
    const running = this.#findRunning(pairing.botId)
    if (pairing.person !== undefined) {
      running?.forgetPerson(pairing.person)
    }
    running?.bot.rejectForKeys(keyIds)
  }

  #describeBot(record: BotRecord): AdminBot {
    const state = this.#findState(record.id)
    const displayName =
      state.kind === 'running' ? state.running.bot.describe().displayName : undefined
    const pairingIds = this.#registry.pairings
      .filter((pairing) => pairing.botId === record.id)
      .map((pairing) => pairing.id)
    return {
      id: record.id,
      provider: record.provider,
      ...(record.label === undefined ? {} : { label: record.label }),
      ...(displayName === undefined ? {} : { displayName }),
      state: state.kind,
      ...(state.kind === 'failed' ? { error: state.reason } : {}),
      pairingCount: pairingIds.length,
      keyCount: this.#registry.keys.filter((key) => pairingIds.includes(key.pairingId)).length,
    }
  }

  /** An entry of `botId`'s log with its bot; a seed bot line without a key is the seed key's. */
  #toAdminEntry(botId: string, entry: AuditEntry): AuditEntry {
    const seed = this.#registry.seed
    const isSeedLine = entry.key === undefined && seed?.botId === botId
    return {
      ...entry,
      ...(isSeedLine ? { key: seed.keyId, pairing: seed.pairingId } : {}),
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
      directory: resolveBotFiles(this.#configPath, botId).directory,
      people: this.#createPeople(botId),
      fatal,
      log: this.#log,
    })
  }

  /** Runs once the supervisor has accepted a started bot. */
  #prepareRunning(botId: string, running: RunningBot): void {
    // Codes created while the bot was starting.
    for (const pairing of this.#registry.pairings) {
      if (pairing.botId === botId && isPending(pairing)) {
        running.codes.add(pairing.id, pairing.code)
      }
    }
    this.#logSeedCode(botId, running)
    if (this.#isRecovering) {
      void running.recover()
    }
  }

  /** The pairing instruction for the install's own pending pairing, as the daemon always logged it. */
  #logSeedCode(botId: string, running: RunningBot): void {
    const seed = this.#registry.seed
    if (seed?.botId !== botId) {
      return
    }
    const pairing = this.#registry.pairings.find((other) => other.id === seed.pairingId)
    const instructions = running.bot.pairingInstructions
    if (pairing === undefined || !isPending(pairing) || instructions === undefined) {
      return
    }
    this.#log(`[${botId}] Not paired. ${instructions(pairing.code)}`)
  }

  #createPeople(botId: string): BotPeople {
    const pairingsOnBot = (): readonly PairingRecord[] =>
      this.#registry.pairings.filter((pairing) => pairing.botId === botId)
    return {
      isPaired: (person) => this.#findPairingOf(botId, person) !== undefined,
      list: () => [...new Set(pairingsOnBot().flatMap((pairing) => pairing.person ?? []))],
      pendingCodes: () =>
        new Map(
          pairingsOnBot()
            .filter(isPending)
            .map((pairing) => [pairing.id, pairing.code]),
        ),
      claim: (pairingId, person) => this.#claim(botId, pairingId, person),
      quietHours: (person) => toQuiet(this.#findPairingOf(botId, person)),
      saveQuiet: (person, patch) => this.#saveQuiet(botId, person, patch),
    }
  }

  #claim(botId: string, pairingId: string, person: string): void {
    const pairing = this.#registry.pairings.find((other) => other.id === pairingId)
    // claimPairing would replace a person already there.
    if (pairing === undefined || pairing.botId !== botId || !isPending(pairing)) {
      this.#log(`[${botId}] ignored a claim of pairing ${pairingId}, which isn't pending`)
      return
    }
    const result = claimPairing(this.#registry, pairingId, person)
    if (result.kind === 'notFound') {
      return
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
  }

  #saveQuiet(botId: string, person: string, patch: QuietPatch): void {
    const pairing = this.#findPairingOf(botId, person)
    if (pairing === undefined) {
      throw new Error(`${person} isn't paired on ${botId}`)
    }
    this.#commit(updatePairingQuiet(this.#registry, pairing.id, patch))
  }

  #route(authorization: string | undefined): BotRoute {
    const found = this.#findKey(authorization)
    if (found.kind !== 'found') {
      return { kind: 'unauthorized', reason: found.kind }
    }
    const { key } = found
    const pairing = this.#registry.pairings.find((other) => other.id === key.pairingId)
    if (pairing === undefined) {
      return { kind: 'unauthorized', reason: 'wrong' }
    }
    const running = this.#findRunning(pairing.botId)
    const route: KeyRoute = {
      kind: 'key',
      caller: { key: key.id, pairing: pairing.id },
      person: pairing.person,
      bot: running?.bot,
      status: () => this.#describeStatus(key.id, pairing),
      readLog: (query) => this.#readLog(key.id, pairing.botId, query),
    }
    return route
  }

  #findKey(
    authorization: string | undefined,
  ):
    | { readonly kind: 'found'; readonly key: KeyRecord }
    | { readonly kind: 'missing' }
    | { readonly kind: 'wrong' } {
    if (authorization === undefined) {
      const seed = this.#registry.seed
      const open =
        seed?.isOpen === true ? this.#registry.keys.find((key) => key.id === seed.keyId) : undefined
      return open === undefined ? { kind: 'missing' } : { kind: 'found', key: open }
    }
    const presented = AUTHORIZATION_PATTERN.exec(authorization)?.[1]
    if (presented === undefined) {
      return { kind: 'wrong' }
    }
    // Hashes of random keys: comparing them leaks nothing about the keys themselves.
    const hash = hashKey(presented)
    const key = hash === this.#adminKeyHash ? undefined : findKeyByHash(this.#registry, hash)
    return key === undefined ? { kind: 'wrong' } : { kind: 'found', key }
  }

  /** /status for a key, from the registry as it is now; `routed` stands in once it's gone. */
  #describeStatus(keyId: string, routed: PairingRecord): StatusInfo {
    const pairing = this.#registry.pairings.find((other) => other.id === routed.id) ?? routed
    const record = this.#findBot(pairing.botId)
    const provider = record === undefined ? undefined : this.#providersByName.get(record.provider)
    const state = this.#findState(pairing.botId)
    const running = state.kind === 'running' ? state.running : undefined
    const described =
      running?.bot.describe() ?? (record === undefined ? {} : { provider: record.provider })
    const common = {
      key: keyId,
      pairing: pairing.id,
      state: state.kind,
      ...(state.kind === 'failed' ? { error: state.reason } : {}),
      ...described,
    }
    const limits = provider === undefined ? {} : toProviderLimits(provider)
    if (!isPending(pairing)) {
      return { paired: true, ...common, ...limits }
    }
    const instructions = running?.bot.pairingInstructions?.(pairing.code)
    return {
      paired: false,
      ...common,
      code: formatCode(pairing.code),
      ...(instructions === undefined ? {} : { instructions }),
      ...limits,
    }
  }

  /** The key's questions in its bot's log; lines from before keys existed are the seed key's. */
  #readLog(keyId: string, botId: string, query: LogQuery): AuditReadResult {
    const raw = readAuditFiles(resolveBotFiles(this.#configPath, botId).auditPath)
    const { entries, skippedCount } = parseAuditLog(raw, this.#now())
    const seed = this.#registry.seed
    const isSeedKey = seed?.keyId === keyId && seed.botId === botId
    return {
      entries: selectAuditEntries(entries, {
        ...query,
        key: keyId,
        ...(isSeedKey ? { unkeyedAs: keyId } : {}),
      }),
      skippedCount,
    }
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

  /** Whether a new pairing on the target's bot waits for a code; only `newPairing` makes one. */
  #isPairingTarget(target: KeyTarget): boolean {
    return target.kind !== 'newPairing' || this.#isPairingBot(target.botId)
  }

  /** Whether the bot's provider pairs; a bot whose provider is gone can't run, and a code costs nothing. */
  #isPairingBot(botId: string): boolean {
    const record = this.#findBot(botId)
    const provider = record === undefined ? undefined : this.#providersByName.get(record.provider)
    return provider === undefined || findOwnerSetting(provider) !== undefined
  }

  #findState(botId: string): BotState {
    return this.#supervisors.get(botId)?.state ?? { kind: 'failed', reason: 'not started' }
  }

  #findPairing(pairingId: string): PairingRecord | undefined {
    return this.#registry.pairings.find((pairing) => pairing.id === pairingId)
  }

  #listKeyIds(pairingId: string): readonly string[] {
    return this.#registry.keys.filter((key) => key.pairingId === pairingId).map((key) => key.id)
  }

  #findBot(botId: string): BotRecord | undefined {
    return this.#registry.bots.find((record) => record.id === botId)
  }

  #findPairingOf(botId: string, person: string): PairingRecord | undefined {
    return this.#registry.pairings.find(
      (pairing) => pairing.botId === botId && pairing.person === person,
    )
  }

  #findPairingOfKey(keyId: string): PairingRecord | undefined {
    const key = this.#registry.keys.find((other) => other.id === keyId)
    return key === undefined
      ? undefined
      : this.#registry.pairings.find((pairing) => pairing.id === key.pairingId)
  }

  #findRunning(botId: string): RunningBot | undefined {
    const state = this.#supervisors.get(botId)?.state
    return state?.kind === 'running' ? state.running : undefined
  }
}
