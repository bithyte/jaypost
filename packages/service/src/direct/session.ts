import { randomUUID } from 'node:crypto'
import {
  ApprovalService,
  askWithRetries,
  findOwnerSetting,
  runVote,
  SendError,
} from '@jaypost/core'
import type { ProviderRuntime } from '@jaypost/core'
import { DIRECT_NOTIFICATION_OPTIONS } from './constants.ts'
import type { DirectConfig, DirectSession } from './types.ts'

/**
 * Creates the provider runtime and checks its credentials. Throws the provider's reason when they
 * are rejected, after stopping the runtime. `log` gets the runtime's lines; `logError` gets failed
 * message edits (`console.error` when not given).
 */
export async function openDirectSession(
  config: DirectConfig,
  log: (line: string) => void,
  logError?: (message: string, error: unknown) => void,
): Promise<DirectSession> {
  const { provider, settings } = config
  const runtime = provider.createRuntime(settings, log)
  let check
  try {
    check = await runtime.checkCredentials()
  } catch (error) {
    await stopRuntime(runtime)
    throw error
  }
  if (!check.ok) {
    await stopRuntime(runtime)
    throw new Error(check.reason)
  }
  const ownerSetting = findOwnerSetting(provider)
  const savedOwner = ownerSetting === undefined ? undefined : settings[ownerSetting.configKey]
  const owner = savedOwner === undefined ? undefined : String(savedOwner)
  // No store and no audit: timeout and cancel finalize exactly as the service does.
  const service = new ApprovalService(
    runtime,
    undefined,
    undefined,
    logError === undefined ? {} : { logError },
  )
  const fatalController = new AbortController()
  let fatalMessage: string | undefined
  let started = false
  function start(): void {
    if (started) {
      return
    }
    started = true
    runtime.start({
      answer: (id, optionIndex) => service.tap(id, optionIndex),
      reply: (id, text) => service.reply(id, text),
      dismiss: () => false,
      isPaired: (senderId) => senderId === owner,
      listPaired: () => (owner === undefined ? [] : [owner]),
      commands: [],
      command: () => undefined,
      fatal: (message) => {
        fatalMessage ??= message
        fatalController.abort()
      },
    })
  }
  function rejectOnFatal<T extends { readonly kind: string }>(result: T): T {
    if (result.kind === 'cancelled' && fatalMessage !== undefined) {
      throw new Error(fatalMessage)
    }
    return result
  }
  return {
    // Not async, like ApprovalService.request: an async function would pin the attachment bytes
    // for the whole wait.
    request: (request, signal, retryCount = 0, onProgress) => {
      if (fatalMessage !== undefined) {
        return Promise.reject(new Error(fatalMessage))
      }
      start()
      return askWithRetries(
        service,
        request.recipient === undefined && owner !== undefined
          ? { ...request, recipient: owner }
          : request,
        retryCount,
        AbortSignal.any([signal, fatalController.signal]),
        onProgress,
      ).then(rejectOnFatal)
    },
    vote: (vote, signal, onProgress) => {
      if (fatalMessage !== undefined) {
        return Promise.reject(new Error(fatalMessage))
      }
      start()
      return runVote(
        service,
        vote,
        AbortSignal.any([signal, fatalController.signal]),
        onProgress,
      ).then(rejectOnFatal)
    },
    notify: async (request) => {
      if (runtime.sendNotification === undefined) {
        throw new Error(`${provider.label} can't send notifications`)
      }
      try {
        await runtime.sendNotification(
          randomUUID(),
          request.message,
          { ...DIRECT_NOTIFICATION_OPTIONS, recipient: owner },
          request.attachment,
        )
      } catch (cause) {
        throw new SendError('failed to send notification', { cause })
      }
    },
    stop: () => stopRuntime(runtime),
  }
}

async function stopRuntime(runtime: ProviderRuntime): Promise<void> {
  try {
    await runtime.stop()
  } catch {
    // Stopping is best effort, and the error could carry provider details we don't want logged.
  }
}
