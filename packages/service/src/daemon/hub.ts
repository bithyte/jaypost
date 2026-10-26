import {
  findOwnerSetting,
  formatCode,
  generateCode as generateDefaultCode,
  parseQuietHours,
  resolveMaxAttachmentBytes,
} from '@jaypost/core'
import type { Provider, QuietHours, QuietPatch } from '@jaypost/core'
import {
  AUTHORIZATION_PATTERN,
  claimPairing,
  createKey,
  findKeyByHash,
  generateApiKey,
  hashKey,
  parseAuditLog,
  readAuditFiles,
  resolveBotFiles,
  revokeKey,
  selectAuditEntries,
  updatePairingQuiet,
} from '@jaypost/store'
import type {
  AuditReadResult,
  BotRecord,
  KeyDetails,
  KeyRecord,
  KeyTarget,
  NotFound,
  PairingRecord,
  Registry,
  RegistryStore,
} from '@jaypost/store'
import type { StatusInfo } from '@jaypost/protocol'
import { NO_BOT_LIMITS } from '../server/index.ts'
import type { BotRoute, BotRouter, KeyRoute, LogQuery, OpenApiOptions } from '../server/index.ts'
import { startBot } from './bot.ts'
import { BotSupervisor } from './supervisor.ts'
import type { BotPeople, BotState, CreatedKey, HubOptions, RunningBot } from './types.ts'

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

/**
 * Owns the registry: keeps it in memory, runs one `BotSupervisor` per stored bot, and routes each
 * API call by its key to that key's bot and person. Every change applies a registry operation,
 * saves it, and only then swaps the registry in memory and updates the running bots, so a failed
 * save throws and changes nothing. The one exception is a pairing claim from the chat: it stays in
 * memory when the save fails, and that's logged.
 */
export class Hub {
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
  readonly #adminKeyHash: string
  #isRecovering = false
  #started: Promise<void> = Promise.resolve()

  constructor(options: HubOptions) {
    this.#store = options.store
    this.#registry = options.registry
    this.#providersByName = new Map(options.providers.map((provider) => [provider.name, provider]))
    this.#configPath = options.configPath
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
    await Promise.all([...this.#supervisors.values()].map((supervisor) => supervisor.stop()))
  }

  /**
   * A new key on `target`'s pairing (Task 4's `createKey`), saved before it takes effect. A new
   * pending pairing's code goes to its running bot at once. Throws when the save fails.
   */
  createKey(target: KeyTarget, details: KeyDetails): CreatedKey | NotFound {
    const key = generateApiKey()
    const at = this.#now()
    const result = createKey(
      this.#registry,
      target,
      hashKey(key),
      details,
      this.#generateCode(),
      this.#isPairingTarget(target),
      at,
    )
    if (result.kind === 'notFound') {
      return result
    }
    this.#commit(result.registry)
    const { pairing } = result
    const running = this.#findRunning(pairing.botId)
    if (!isPending(pairing)) {
      return { kind: 'created', id: result.key.id, key, pairing }
    }
    running?.codes.add(pairing.id, pairing.code)
    const instructions = running?.bot.pairingInstructions?.(pairing.code)
    return {
      kind: 'created',
      id: result.key.id,
      key,
      pairing,
      code: formatCode(pairing.code),
      ...(instructions === undefined ? {} : { instructions }),
    }
  }

  /** Removes the key, then rejects its open questions with their timeout option. Throws when the save fails. */
  revokeKey(keyId: string): { readonly kind: 'revoked' } | NotFound {
    const pairing = this.#findPairingOfKey(keyId)
    const result = revokeKey(this.#registry, keyId)
    if (result.kind === 'notFound') {
      return result
    }
    this.#commit(result.registry)
    if (pairing !== undefined) {
      this.#findRunning(pairing.botId)?.bot.rejectForKeys([keyId])
    }
    return { kind: 'revoked' }
  }

  #commit(registry: Registry): void {
    this.#store.save(registry)
    this.#registry = registry
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
    const state: BotState = this.#supervisors.get(pairing.botId)?.state ?? {
      kind: 'failed',
      reason: 'not started',
    }
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
    if (target.kind !== 'newPairing') {
      return true
    }
    const record = this.#findBot(target.botId)
    const provider = record === undefined ? undefined : this.#providersByName.get(record.provider)
    // A bot whose provider is gone can't run; a code costs nothing.
    return provider === undefined || findOwnerSetting(provider) !== undefined
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
