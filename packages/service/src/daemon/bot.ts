import { join } from 'node:path'
import {
  ApprovalService,
  findOwnerSetting,
  isCodeShaped,
  NotificationService,
  OWNER_COMMANDS,
  PairingCodes,
  QUIET_COMMANDS,
  QuietService,
  resolveMaxAttachmentBytes,
  resolveVoters,
  runOwnerCommand,
} from '@jaypost/core'
import {
  AUDIT_FILE_NAME,
  AuditLog,
  LOCAL_PERSON,
  STATE_FILE_NAME,
  StateStore,
} from '@jaypost/store'
import type { PairResult, RuntimeHandlers } from '@jaypost/core'
import type { BotOptions, RunningBot } from './types.ts'

/** Who questions to `person` are sent to: nobody in particular for the local person. */
function recipientFor(person: string): string | undefined {
  return person === LOCAL_PERSON ? undefined : person
}

/**
 * Starts one bot for everyone paired on it: its provider runtime, questions, notifications, each
 * person's quiet hours, and pairing with the codes `people` has pending. State and audit files go
 * to `options.directory`; every log line starts with `[<bot id>]`. Throws an Error with the
 * provider's reason when credentials are rejected.
 */
export async function startBot(options: BotOptions): Promise<RunningBot> {
  const { record, provider, people } = options
  const baseLog = options.log ?? console.error
  const log = (line: string): void => baseLog(`[${record.id}] ${line}`)
  const runtime = provider.createRuntime(record.settings, log)
  const check = await runtime.checkCredentials()
  if (!check.ok) {
    throw new Error(check.reason)
  }
  const displayName = check.displayName
  const pairs = findOwnerSetting(provider) !== undefined
  const pairingInstructions = runtime.pairingInstructions?.bind(runtime)
  if (pairs && pairingInstructions === undefined) {
    throw new Error(
      `provider ${JSON.stringify(provider.name)} has an owner setting but no pairing support`,
    )
  }
  const store = new StateStore(join(options.directory, STATE_FILE_NAME), provider.name, log)
  const saved = store.load()
  const audit = new AuditLog(join(options.directory, AUDIT_FILE_NAME), { log })
  const service = new ApprovalService(runtime, undefined, undefined, { store, audit })
  const quietByPerson = new Map<string, QuietService>()
  const quietFor = (person: string): QuietService => {
    const existing = quietByPerson.get(person)
    if (existing !== undefined) {
      return existing
    }
    const created = new QuietService((patch) => people.saveQuiet(person, patch), {
      ...people.quietHours(person),
      log,
    })
    quietByPerson.set(person, created)
    return created
  }
  const sendNotification = runtime.sendNotification
  const notifications =
    sendNotification === undefined
      ? undefined
      : new NotificationService(
          { sendNotification, deleteMessage: runtime.deleteMessage },
          undefined,
          log,
          {
            store,
            quiet: { quietUntil: (recipient) => quietFor(recipient ?? LOCAL_PERSON).quietUntil() },
          },
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
  const codes = new PairingCodes()
  for (const [pairingId, code] of people.pendingCodes()) {
    codes.add(pairingId, code)
  }
  const describe = () => ({
    provider: provider.name,
    displayName,
    ...runtime.statusFields?.(),
  })
  const pair = (senderId: string, text: string): PairResult => {
    // A paired person's chat isn't a guess, so it never counts toward their block.
    if (people.isPaired(senderId) && !isCodeShaped(text)) {
      return 'notPairing'
    }
    const claim = codes.attempt(senderId, text)
    if (claim.kind !== 'paired') {
      return claim.kind
    }
    people.claim(claim.pairingId, senderId)
    log(`paired ${senderId} on ${record.id}`)
    return 'paired'
  }
  const handlers: RuntimeHandlers = {
    answer: (id, optionIndex, senderId) => {
      // Callback data can be forged, so on a bot that pairs a tap only counts from its recipient.
      const isOthers =
        pairs &&
        senderId !== undefined &&
        !service.listPending(recipientFor(senderId)).some((open) => open.id === id)
      return isOthers ? 'expired' : service.tap(id, optionIndex)
    },
    reply: (id, text) => service.reply(id, text),
    dismiss: (id) => notifications?.dismiss(id) ?? false,
    isPaired: (id) => people.isPaired(id),
    listPaired: () => people.list(),
    commands: [...OWNER_COMMANDS, ...QUIET_COMMANDS],
    command: (name, argument, senderId) => {
      const person = !pairs || senderId === undefined ? LOCAL_PERSON : senderId
      return (
        runOwnerCommand(service, name, argument, recipientFor(person), {
          now: () => new Date(),
          maxTextLength: provider.maxTextLength,
        }) ?? quietFor(person).handleCommand(name, argument)
      )
    },
    fatal: options.fatal,
    ...(pairs ? { pair } : {}),
  }
  runtime.start(handlers)
  return {
    bot: {
      botId: record.id,
      service,
      describe,
      ...(pairingInstructions === undefined ? {} : { pairingInstructions }),
      resolveVoters: (voters, person) => resolveVoters(provider, person, voters),
      rejectForKeys: (keyIds) => {
        for (const keyId of keyIds) {
          service.rejectForKey(keyId)
        }
      },
      maxTextLength: provider.maxTextLength,
      providerName: provider.name,
      maxAttachmentBytes: resolveMaxAttachmentBytes(provider),
      ...(provider.maxOptionCount === undefined ? {} : { maxOptionCount: provider.maxOptionCount }),
      ...(notifications === undefined ? {} : { notifications }),
    },
    codes,
    recover,
    stop: async () => {
      store.freeze()
      notifications?.stop()
      await runtime.stop().catch(() => undefined)
    },
  }
}
