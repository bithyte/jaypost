import { CANCELLED_SETTLEMENT } from './constants.ts'
import type { PendingEntry, PendingSummary, SentRequest, Settlement } from './types.ts'

/**
 * Open requests by id, each settling exactly once (answer, typed reply, timeout, reject or cancel);
 * settling clears its timer.
 */
export class PendingRequests {
  #entries = new Map<string, PendingEntry>()

  get size(): number {
    return this.#entries.size
  }

  /**
   * Registers `request` and resolves with how it settled. The timeout settles it with the request's
   * timeout option.
   */
  open(id: string, request: SentRequest, openedAt: Date): Promise<Settlement> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.#settle(id, { kind: 'timedOut', answer: request.timeoutOption }),
        request.timeoutSeconds * 1000,
      )
      this.#entries.set(id, { request, openedAt, timer, resolve })
    })
  }

  /**
   * Settles with the option at `optionIndex`; false when the id is unknown or already settled, or
   * the index is out of range.
   */
  answer(id: string, optionIndex: number): boolean {
    const entry = this.#entries.get(id)
    const answer = entry?.request.options[optionIndex]
    if (answer === undefined) {
      return false
    }
    return this.#settle(id, { kind: 'answered', answer })
  }

  /**
   * Settles with the typed `text`; false when the id is unknown or already settled, or the request
   * doesn't allow text. The core checks `allowText` itself so a provider bug can't answer a
   * buttons-only question.
   */
  reply(id: string, text: string): boolean {
    if (!this.#entries.get(id)?.request.allowText) {
      return false
    }
    return this.#settle(id, { kind: 'replied', answer: text })
  }

  /** Settles as cancelled; false when the id is unknown or already settled. */
  cancel(id: string): boolean {
    return this.#settle(id, CANCELLED_SETTLEMENT)
  }

  /** Settles as closed by a vote decided without it; false when the id is unknown or settled. */
  close(id: string, answer: string): boolean {
    return this.#settle(id, { kind: 'closed', answer })
  }

  /** Open requests, oldest first. */
  list(): readonly PendingSummary[] {
    return [...this.#entries].map(([id, { request, openedAt }]) => ({ id, request, openedAt }))
  }

  /**
   * Settles every open request as rejected with its timeout option, and returns what it rejected,
   * oldest first.
   */
  rejectAll(): readonly PendingSummary[] {
    const rejected = this.list()
    for (const { id, request } of rejected) {
      this.#settle(id, { kind: 'rejected', answer: request.timeoutOption })
    }
    return rejected
  }

  #settle(id: string, settlement: Settlement): boolean {
    const entry = this.#entries.get(id)
    if (!entry) {
      return false
    }
    clearTimeout(entry.timer)
    this.#entries.delete(id)
    entry.resolve(settlement)
    return true
  }
}
