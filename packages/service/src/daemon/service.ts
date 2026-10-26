import { dirname } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { findOwnerSetting, generateCode as generateDefaultCode } from '@jaypost/core'
import { loadConfig, resolveConfigPath, updateConfigFile } from '@jaypost/store'
import type { BotRecord, Config } from '@jaypost/store'
import { SERVICE_PROVIDERS } from '@jaypost/providers'
import { createApiServer, createSingleBotRouter } from '../server/index.ts'
import { startBot } from './bot.ts'
import type { BotPeople } from './types.ts'

/** The config's bot and the version its API reports. */
export type ServiceOptions = {
  readonly config: Config
  readonly configPath: string
  /** The provider can't continue; the caller decides how to exit. */
  readonly fatal: (message: string) => void
  readonly log?: (line: string) => void
  readonly generateCode?: () => string
  /** Shown in /openapi.yaml. */
  readonly version: string
}

/** The interim single bot's id until the hub serves the registry (Task 7). */
const CONFIG_BOT_ID = 'b1'

/**
 * Interim (deleted with the hub): today's single owner as `BotPeople`. The owner comes from the
 * config's owner setting; without one there is a pending code `p1`. A claim saves the owner to
 * config.json and logs when that fails; quiet settings are read from and saved to config.json for
 * everyone.
 */
export function createConfigPeople(
  config: Config,
  configPath: string,
  generateCode: () => string,
  log: (line: string) => void,
): BotPeople {
  const ownerSetting = findOwnerSetting(config.provider)
  const savedOwner =
    ownerSetting === undefined ? undefined : config.settings[ownerSetting.configKey]
  let owner = savedOwner === undefined ? undefined : String(savedOwner)
  const pendingCodes: ReadonlyMap<string, string> =
    ownerSetting === undefined || Object.hasOwn(config.settings, ownerSetting.configKey)
      ? new Map()
      : new Map([['p1', generateCode()]])
  const quiet = {
    ...(config.quietHours === undefined ? {} : { quietHours: config.quietHours }),
    ...(config.mutedUntil === undefined ? {} : { mutedUntil: config.mutedUntil }),
  }
  return {
    isPaired: (person) => person === owner,
    list: () => (owner === undefined ? [] : [owner]),
    pendingCodes: () => pendingCodes,
    claim: (_pairingId, person) => {
      owner = person
      try {
        const parsedOwner = ownerSetting?.parse(person)
        if (ownerSetting === undefined || parsedOwner === undefined) {
          throw new Error('owner not parseable')
        }
        updateConfigFile(configPath, { [ownerSetting.configKey]: parsedOwner })
      } catch {
        log(
          `paired with ${person} but couldn't save the owner to ${configPath}; it'll be lost on restart`,
        )
      }
    },
    quietHours: () => quiet,
    saveQuiet: (_person, patch) => updateConfigFile(configPath, patch),
  }
}

export type RunningService = {
  readonly server: FastifyInstance
  /** Starts cleanup of the previous run's messages once; resolves when done; never rejects. */
  readonly recover: () => Promise<void>
  /**
   * Freezes the saved state first (so pending requests stay saved for the next start), then closes
   * the server and the provider runtime; never rejects.
   */
  readonly stop: () => Promise<void>
}

/**
 * Starts the config's bot behind an API guarded by `config.auth`, with state and audit files next
 * to `configPath`. Throws an Error with the provider's reason when credentials are rejected.
 * Doesn't listen.
 */
export async function startService(options: ServiceOptions): Promise<RunningService> {
  const { config, configPath } = options
  const log = options.log ?? console.error
  const people = createConfigPeople(
    config,
    configPath,
    options.generateCode ?? generateDefaultCode,
    log,
  )
  const record: BotRecord = {
    id: CONFIG_BOT_ID,
    provider: config.provider.name,
    settings: config.settings,
    createdAt: new Date().toISOString(),
  }
  const prefix = `[${record.id}] `
  const running = await startBot({
    record,
    provider: config.provider,
    directory: dirname(configPath),
    people,
    fatal: options.fatal,
    // Interim: the single-bot daemon's log lines have never named a bot.
    log: (line) => log(line.startsWith(prefix) ? line.slice(prefix.length) : line),
  })
  const instructions = running.bot.pairingInstructions
  for (const code of people.pendingCodes().values()) {
    log(`Not paired. ${instructions?.(code) ?? ''}`)
  }
  const server = createApiServer(
    createSingleBotRouter({ ...running.bot, auth: config.auth, version: options.version }),
  )
  return {
    server,
    recover: running.recover,
    // running.stop() freezes the state before the server starts closing.
    stop: async () => {
      await Promise.allSettled([running.stop(), server.close()])
    },
  }
}

/**
 * Starts the provider and API, reporting `version` in /openapi.yaml. Exits the process with 1 on
 * bad config, rejected credentials, an HTTP server error, or a fatal provider error.
 */
export async function runService(
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let config: Config
  try {
    config = loadConfig(env, SERVICE_PROVIDERS)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  let stopping = false
  let running: RunningService
  try {
    running = await startService({
      version,
      config,
      configPath: resolveConfigPath(env),
      fatal: (message) => {
        if (stopping) {
          return
        }
        console.error(message)
        process.exit(1)
      },
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  running.server.listen({ port: config.port, host: config.host }).then(
    () => {
      console.log(
        `listening on ${config.host}:${config.port} (${config.auth.kind === 'token' ? 'token required' : 'no token'})`,
      )
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
