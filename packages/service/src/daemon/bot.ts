import {
  ApprovalService,
  GuessLimit,
  isCodeShaped,
  isPairingProvider,
  NotificationService,
  OWNER_COMMANDS,
  QUIET_COMMANDS,
  QuietService,
  resolveMaxAttachmentBytes,
  resolveVoters,
  runOwnerCommand,
} from '@jaypost/core'
import { AuditLog, LOCAL_PERSON, StateStore } from '@jaypost/store'
import type { PairResult, RuntimeHandlers } from '@jaypost/core'
import type { BotOptions, RunningBot } from './types.ts'

/** Who questions to `person` are sent to: nobody in particular for the local person. */
function recipientFor(person: string): string | undefined {
  return person === LOCAL_PERSON ? undefined : person
}

/**
 * Starts one bot for everyone paired on it: its provider runtime, questions, notifications, each
 * person's quiet hours, and pairing with the codes `people` has pending at each attempt. State is
 * kept in `options.database` and so is its question log; every log line starts with `[<bot id>]`. Throws an Error
 * with the provider's reason when credentials are rejected.
 */
export async function startBot(options: BotOptions): Promise<RunningBot> {
  const { record, provider, people } = options
  const baseLog = options.log ?? console.error
  const log = (line: string): void => baseLog(`[${record.id}] ${line}`)
  const runtime = provider.createRuntime(record.settings, log)
  const check = await runtime.checkCredentials()
  if (!check.ok) {
    // The supervisor retries, so don't leave a client behind on each attempt.
    await runtime.stop().catch(() => undefined)
    throw new Error(check.reason)
  }
  const displayName = check.displayName
  const pairs = isPairingProvider(provider)
  const pairingInstructions = runtime.pairingInstructions?.bind(runtime)
  if (pairs && pairingInstructions === undefined) {
    await runtime.stop().catch(() => undefined)
    throw new Error(
      `provider ${JSON.stringify(provider.name)} has an owner setting but no pairing support`,
    )
  }
  const store = new StateStore(options.database, record.id, provider.name, log)
  const saved = store.load()
  const audit = new AuditLog(options.database, record.id, { log })
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
  const guesses = new GuessLimit()
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
    if (guesses.isBlocked(senderId)) {
      return 'blocked'
    }
    const claim = people.claim(text, senderId)
    switch (claim) {
      case 'noCodes':
        return 'notPairing'
      case 'wrong':
        guesses.countWrong(senderId)
        return 'wrong'
      case 'claimed':
      case 'merged':
        log(`paired ${senderId} on ${record.id}`)
        return 'paired'
    }
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
    recover,
    forgetPerson: (person) => {
      quietByPerson.delete(person)
    },
    stop: async () => {
      store.freeze()
      notifications?.stop()
      await runtime.stop().catch(() => undefined)
    },
    abandon: async () => {
      // Their final edits and audit lines still happen; only the saved records go now.
      for (const { id } of service.rejectEveryOpen()) {
        store.removeRequest(id)
      }
      store.freeze()
      notifications?.stop()
      await runtime.stop().catch(() => undefined)
    },
  }
}
