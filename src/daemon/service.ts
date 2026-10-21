import type { FastifyInstance } from 'fastify'
import { ApprovalService, OWNER_COMMANDS, runOwnerCommand } from '../approval/index.ts'
import { AuditLog, resolveAuditPath } from '../audit/index.ts'
import { loadConfig, resolveConfigPath, updateConfigFile } from '../config/index.ts'
import type { Config } from '../config/index.ts'
import { NotificationService } from '../notify/index.ts'
import { formatCode, generateCode as generateDefaultCode, Pairing } from '../pairing/index.ts'
import type { PairResult } from '../pairing/index.ts'
import { findOwnerSetting, resolveMaxAttachmentBytes } from '../provider/index.ts'
import type { RuntimeHandlers } from '../provider/index.ts'
import { QUIET_COMMANDS, QuietService } from '../quiet/index.ts'
import { createApiServer } from '../server/index.ts'
import type { StatusInfo } from '../server/index.ts'
import { resolveStatePath, StateStore } from '../state/index.ts'

export type ServiceOptions = {
  readonly config: Config
  readonly configPath: string
  /** The provider can't continue; the caller decides how to exit. */
  readonly fatal: (message: string) => void
  readonly log?: (line: string) => void
  readonly generateCode?: () => string
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

/** Throws an Error with the provider's reason when credentials are rejected. Doesn't listen. */
export async function startService(options: ServiceOptions): Promise<RunningService> {
  const { config, configPath } = options
  const log = options.log ?? console.error
  const provider = config.provider
  const runtime = provider.createRuntime(config.settings, log)
  const check = await runtime.checkCredentials()
  if (!check.ok) {
    throw new Error(check.reason)
  }
  const displayName = check.displayName
  const store = new StateStore(resolveStatePath(configPath), provider.name, log)
  const saved = store.load()
  const audit = new AuditLog(resolveAuditPath(configPath), { log })
  const service = new ApprovalService(runtime, undefined, undefined, { store, audit })
  const quiet = new QuietService((patch) => updateConfigFile(configPath, patch), {
    ...(config.quietHours === undefined ? {} : { quietHours: config.quietHours }),
    ...(config.mutedUntil === undefined ? {} : { mutedUntil: config.mutedUntil }),
    log,
  })
  const sendNotification = runtime.sendNotification
  const notifications =
    sendNotification === undefined
      ? undefined
      : new NotificationService(
          { sendNotification, deleteMessage: runtime.deleteMessage },
          undefined,
          log,
          { store, quiet },
        )
  let recovery: Promise<void> | undefined
  // Deferred to the caller so a second instance that fails to bind its port has no side effects.
  const recover = (): Promise<void> => {
    recovery ??= (async () => {
      notifications?.restore(saved.notifications)
      await service.expireOrphans(saved.requests)
      await notifications?.deleteOverdue()
    })().catch(() => undefined)
    return recovery
  }
  const ownerSetting = findOwnerSetting(provider)
  let pairing: Pairing | undefined
  let instructions: string | undefined
  if (ownerSetting !== undefined && !Object.hasOwn(config.settings, ownerSetting.configKey)) {
    if (runtime.pairingInstructions === undefined) {
      throw new Error(
        `provider ${JSON.stringify(provider.name)} has an owner setting but no pairing support`,
      )
    }
    const code = (options.generateCode ?? generateDefaultCode)()
    pairing = new Pairing(code)
    instructions = runtime.pairingInstructions(code)
    log(`Not paired. ${instructions}`)
  }
  const status = (): StatusInfo => {
    const extraFields = runtime.statusFields?.() ?? {}
    if (pairing === undefined || pairing.code === undefined || instructions === undefined) {
      return { paired: true, provider: provider.name, displayName, ...extraFields }
    }
    return {
      paired: false,
      provider: provider.name,
      displayName,
      code: formatCode(pairing.code),
      instructions,
      ...extraFields,
    }
  }
  const pair = (senderId: string, text: string): PairResult => {
    const result = pairing?.attempt(senderId, text) ?? 'notPairing'
    if (result === 'paired' && ownerSetting !== undefined) {
      try {
        const owner = ownerSetting.parse(senderId)
        if (owner === undefined) {
          throw new Error('owner not parseable')
        }
        updateConfigFile(configPath, { [ownerSetting.configKey]: owner })
      } catch {
        log(
          `paired with ${senderId} but couldn't save the owner to ${configPath}; it'll be lost on restart`,
        )
      }
    }
    return result
  }
  const server = createApiServer(service, status, {
    maxTextLength: provider.maxTextLength,
    providerName: provider.name,
    auth: config.auth,
    maxAttachmentBytes: resolveMaxAttachmentBytes(provider),
    ...(provider.maxOptionCount === undefined ? {} : { maxOptionCount: provider.maxOptionCount }),
    ...(notifications === undefined ? {} : { notifications }),
  })
  const handlers: RuntimeHandlers = {
    answer: (id, optionIndex) => service.tap(id, optionIndex),
    reply: (id, text) => service.reply(id, text),
    dismiss: (id) => notifications?.dismiss(id) ?? false,
    commands: [...OWNER_COMMANDS, ...QUIET_COMMANDS],
    command: (name, argument) =>
      runOwnerCommand(service, name, argument, {
        now: () => new Date(),
        maxTextLength: provider.maxTextLength,
      }) ?? quiet.handleCommand(name, argument),
    fatal: options.fatal,
    ...(pairing === undefined ? {} : { pair }),
  }
  runtime.start(handlers)
  return {
    server,
    recover,
    stop: async () => {
      store.freeze()
      notifications?.stop()
      await Promise.allSettled([server.close(), runtime.stop()])
    },
  }
}

/**
 * Starts the provider and API. Exits the process with 1 on bad config, rejected credentials, an
 * HTTP server error, or a fatal provider error.
 */
export async function runService(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let config: Config
  try {
    config = loadConfig(env)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  let stopping = false
  let running: RunningService
  try {
    running = await startService({
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
