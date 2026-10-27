import type { FastifyInstance } from 'fastify'
import { generateCode as generateDefaultCode, isPairingProvider } from '@jaypost/core'
import type { Provider } from '@jaypost/core'
import {
  applySeed,
  ensureAdminKey,
  loadSeed,
  loadServiceConfig,
  openDatabase,
  RegistryStore,
  resolveAdminKeyPath,
  resolveConfigPath,
  resolveDatabasePath,
} from '@jaypost/store'
import type { Registry, SeedLoad, ServiceConfig } from '@jaypost/store'
import { SERVICE_PROVIDERS } from '@jaypost/providers'
import { createApiServer } from '../server/index.ts'
import { Hub } from './hub.ts'

/** What the service needs to start every stored bot, and the version its API reports. */
export type ServiceOptions = {
  /** Shown in /openapi.yaml. */
  readonly version: string
  /** jaypost.db, the admin key file and the bot directories live next to it. */
  readonly configPath: string
  readonly providers: readonly Provider[]
  /** Bot 1, pairing 1 and key 1 as the env and config.json describe them, from `loadSeed`. */
  readonly seed: SeedLoad
  readonly log?: (line: string) => void
  readonly generateCode?: () => string
  readonly now?: () => Date
}

export type RunningService = {
  readonly server: FastifyInstance
  readonly hub: Hub
  /**
   * Resolves once every bot has made its first start attempt; never rejects. Nothing waits for it:
   * the API answers at once, with 503 for a bot still starting.
   */
  readonly started: Promise<void>
  /** Starts cleanup of the previous run's messages once; resolves when done; never rejects. */
  readonly recover: () => Promise<void>
  /**
   * Freezes the saved state first (so pending requests stay saved for the next start), then closes
   * the server and the provider runtimes, then the db; never rejects.
   */
  readonly stop: () => Promise<void>
}

/**
 * The stored registry with the seed applied. Saves only when something changed. Throws on a
 * corrupt registry, a missing setting with no bots stored, or a failed save.
 */
function loadSeededRegistry(
  store: RegistryStore,
  options: ServiceOptions,
  generateCode: () => string,
): Registry {
  const stored = store.load()
  const { seed } = options
  if (seed.kind === 'missing') {
    if (stored.bots.length === 0) {
      throw new Error(seed.message)
    }
    return stored
  }
  const pairs = isPairingProvider(seed.provider)
  const now = options.now ?? (() => new Date())
  const { registry } = applySeed(stored, seed.seed, pairs, generateCode, now())
  if (registry !== stored) {
    store.save(registry)
  }
  return registry
}

/**
 * Opens jaypost.db next to `configPath`, loads the registry, applies the seed, makes sure there is
 * an admin key, and starts every stored bot behind an API that routes each call by its key,
 * without waiting for the bots. A bot that can't start is retried in the background and shows as
 * failed in /status. Throws on an unusable db, a corrupt registry, a missing setting with no bots
 * stored, or an I/O error, and closes the db first. Doesn't listen.
 */
export async function startService(options: ServiceOptions): Promise<RunningService> {
  const { configPath } = options
  const log = options.log ?? console.error
  const generateCode = options.generateCode ?? generateDefaultCode
  const database = openDatabase(resolveDatabasePath(configPath))
  let hub: Hub
  try {
    const store = new RegistryStore(database)
    const registry = loadSeededRegistry(store, options, generateCode)
    const adminKeyPath = resolveAdminKeyPath(configPath)
    const adminKey = ensureAdminKey(adminKeyPath, log)
    hub = new Hub({
      store,
      registry,
      providers: options.providers,
      configPath,
      adminKey,
      adminKeyPath,
      version: options.version,
      generateCode,
      log,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
  } catch (error) {
    database.close()
    throw error
  }
  hub.start()
  const server = createApiServer(hub.router, hub)
  return {
    server,
    hub,
    started: hub.started,
    recover: () => hub.recover(),
    // hub.stop() freezes every bot's state before the server starts closing.
    stop: async () => {
      await Promise.allSettled([hub.stop(), server.close()])
      // A second stop finds the db closed already.
      if (database.isOpen) {
        database.close()
      }
    },
  }
}

/**
 * Starts every stored bot and the API, reporting `version` in /openapi.yaml. Exits the process
 * with 1 on bad config, a corrupt registry, a missing setting with no bots stored, or an HTTP
 * server error. A bot that fails is retried; it never stops the process.
 */
export async function runService(
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let serviceConfig: ServiceConfig
  let seed: SeedLoad
  try {
    serviceConfig = loadServiceConfig(env)
    seed = loadSeed(env, SERVICE_PROVIDERS)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  let stopping = false
  let running: RunningService
  try {
    running = await startService({
      version,
      configPath: resolveConfigPath(env),
      providers: SERVICE_PROVIDERS,
      seed,
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  const { host, port } = serviceConfig
  running.server.listen({ port, host }).then(
    () => {
      const { bots, keys } = running.hub.registry
      console.log(`listening on ${host}:${port} (${bots.length} bots, ${keys.length} keys)`)
      void running.recover()
    },
    (error: unknown) => {
      console.error('http server error:', error instanceof Error ? error.message : String(error))
      process.exit(1)
    },
  )
  function shutdown(): void {
    if (stopping) {
      return
    }
    stopping = true
    setTimeout(() => process.exit(0), 5000).unref()
    void running.stop().finally(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
