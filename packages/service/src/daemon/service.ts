import type { FastifyInstance } from 'fastify'
import { loadConfig, resolveConfigPath } from '@jaypost/store'
import type { Config } from '@jaypost/store'
import { SERVICE_PROVIDERS } from '@jaypost/providers'
import { createApiServer, createSingleBotRouter } from '../server/index.ts'
import { startBot } from './bot.ts'
import type { BotOptions } from './bot.ts'

/** A bot and the version its API reports. */
export type ServiceOptions = BotOptions & {
  /** Shown in /openapi.yaml. */
  readonly version: string
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
 * Starts the config's bot behind an API guarded by `config.auth`. Throws an Error with the
 * provider's reason when credentials are rejected. Doesn't listen.
 */
export async function startService(options: ServiceOptions): Promise<RunningService> {
  const running = await startBot(options)
  const server = createApiServer(
    createSingleBotRouter({ ...running.bot, auth: options.config.auth, version: options.version }),
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
