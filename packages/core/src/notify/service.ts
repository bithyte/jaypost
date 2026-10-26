import { SendError } from '../approval/index.ts'
import type { MessageReference } from '../approval/index.ts'
import { MAX_NOTIFICATION_TTL_MS, MAX_TIMER_DELAY_MS, NOTIFICATION_TTL_MS } from './constants.ts'
import type {
  NotificationRecord,
  NotificationServiceOptions,
  NotificationStore,
  Notifier,
  NotifyRequest,
  QuietSource,
} from './types.ts'

/**
 * Sends notifications and deletes each one after `NOTIFICATION_TTL_MS` unless dismissed first.
 * While quiet they're sent silently and the expiry starts when the quiet period ends; if that would
 * pass `MAX_NOTIFICATION_TTL_MS` after the send, they're left until dismissed.
 */
export class NotificationService {
  #notifier: Notifier
  #newId: () => string
  #log: (line: string) => void
  #store: NotificationStore | undefined
  #now: () => number
  #quiet: QuietSource | undefined
  #timers = new Map<string, ReturnType<typeof setTimeout>>()
  #overdue = new Map<string, MessageReference>()

  constructor(
    notifier: Notifier,
    newId: () => string = () => crypto.randomUUID(),
    log: (line: string) => void = console.error,
    options: NotificationServiceOptions = {},
  ) {
    this.#notifier = notifier
    this.#newId = newId
    this.#log = log
    this.#store = options.store
    this.#now = options.now ?? Date.now
    this.#quiet = options.quiet
  }

  /** Live notifications with a pending expiry, plus restored ones waiting for `deleteOverdue`. */
  get size(): number {
    return this.#timers.size + this.#overdue.size
  }

  /**
   * Resolves once sent and the expiry timer is started. Throws `SendError` if sending fails. A failed
   * expiry delete is only logged.
   */
  async notify(request: NotifyRequest, recipient: string | undefined): Promise<void> {
    const id = this.#newId()
    const quietEnd = this.#quiet?.quietUntil(recipient)
    let reference
    try {
      reference = await this.#notifier.sendNotification(
        id,
        request.message,
        { silent: quietEnd !== undefined, dismissible: true, recipient },
        request.attachment,
      )
    } catch (cause) {
      throw new SendError('failed to send notification', { cause })
    }
    if (this.#notifier.deleteMessage === undefined) {
      return
    }
    const now = this.#now()
    const ttlMs =
      quietEnd === undefined ? NOTIFICATION_TTL_MS : quietEnd.getTime() - now + NOTIFICATION_TTL_MS
    if (ttlMs > MAX_NOTIFICATION_TTL_MS) {
      return
    }
    this.#store?.addNotification({ id, reference, expiresAtMs: now + ttlMs })
    this.#schedule(id, reference, ttlMs)
  }

  /**
   * Re-arms notifications saved by a previous run: future ones get a timer for the remaining time,
   * overdue ones (expiring now or earlier) are queued for `deleteOverdue`. Without
   * `deleteMessage` the records are only removed from the store.
   */
  restore(records: readonly NotificationRecord[]): void {
    if (this.#notifier.deleteMessage === undefined) {
      for (const record of records) {
        this.#store?.removeNotification(record.id)
      }
      return
    }
    const now = this.#now()
    for (const record of records) {
      // The reference was written by this provider's own `sendNotification`.
      const reference = record.reference as MessageReference
      if (record.expiresAtMs > now) {
        this.#schedule(record.id, reference, record.expiresAtMs - now)
      } else {
        this.#overdue.set(record.id, reference)
      }
    }
  }

  /**
   * Deletes the restored notifications that were already overdue, one at a time, and removes their
   * records whatever the outcome. Never rejects.
   */
  async deleteOverdue(): Promise<void> {
    // Map iteration skips entries dismissed while an await is pending.
    for (const [id, reference] of this.#overdue) {
      this.#overdue.delete(id)
      await this.#expire(reference)
      this.#store?.removeNotification(id)
    }
  }

  /** Clears all timers and the overdue queue; the store is left as is. */
  stop(): void {
    for (const timer of this.#timers.values()) {
      clearTimeout(timer)
    }
    this.#timers.clear()
    this.#overdue.clear()
  }

  /** Clears the expiry; false when the id is unknown or already expired. */
  dismiss(id: string): boolean {
    const timer = this.#timers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.#timers.delete(id)
    } else if (!this.#overdue.delete(id)) {
      return false
    }
    this.#store?.removeNotification(id)
    return true
  }

  #schedule(id: string, reference: MessageReference, delayMs: number): void {
    // setTimeout overflows above 2**31-1 ms and fires at once.
    const timer = setTimeout(
      () => {
        this.#timers.delete(id)
        void this.#expire(reference).then(() => this.#store?.removeNotification(id))
      },
      Math.min(delayMs, MAX_TIMER_DELAY_MS),
    )
    this.#timers.set(id, timer)
  }

  async #expire(reference: MessageReference): Promise<void> {
    try {
      await this.#notifier.deleteMessage?.(reference)
    } catch (error) {
      this.#log(
        `failed to delete notification: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
