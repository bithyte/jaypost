import type { FormattedText } from '../format/index.ts'
import {
  CANCELLED_RESULT,
  CANCELLED_STATE,
  EXPIRED_ENDING,
  HISTORY_LIMIT,
  REASKED_ENDING,
  RESULT_TTL_MS,
} from './constants.ts'
import { formatFinalText } from './formatter.ts'
import { PendingRequests } from './pending.ts'
import type { RequestRecord } from '../state/index.ts'
import type {
  ApprovalRequest,
  ApprovalServiceOptions,
  AuditSink,
  BackgroundEntry,
  HistoryEntry,
  MessageButtons,
  MessageEnding,
  MessageReference,
  Messenger,
  OpenedRequest,
  PendingSummary,
  RequestResult,
  RequestState,
  RequestStore,
  SentQuestion,
  SentRequest,
  Settlement,
  StartedRequest,
} from './types.ts'

/** The messenger failed to send the request; the original error is in `cause`. */
export class SendError extends Error {}

/**
 * Sends each request to the owner and waits for an answer (tap or typed reply), the timeout or an
 * abort. Background questions from `start` stay readable by id until `RESULT_TTL_MS` after they
 * settle. Also keeps the last `HISTORY_LIMIT` settled requests in memory.
 */
export class ApprovalService {
  #messenger: Messenger
  #now: () => Date
  #newId: () => string
  #store: RequestStore | undefined
  #audit: AuditSink | undefined
  #pending = new PendingRequests()
  #history: HistoryEntry[] = []
  #background = new Map<string, BackgroundEntry>()
  // The last queued update per message; the final edit waits for it, so it never gets overwritten.
  #updates = new Map<string, Promise<void>>()

  constructor(
    messenger: Messenger,
    now: () => Date = () => new Date(),
    newId: () => string = () => crypto.randomUUID(),
    options: ApprovalServiceOptions = {},
  ) {
    this.#messenger = messenger
    this.#now = now
    this.#newId = newId
    this.#store = options.store
    this.#audit = options.audit
  }

  /**
   * Resolves once settled. Throws `SendError` if the message can't be sent; a failed final edit is
   * only logged. An aborted `signal` settles as cancelled.
   */
  request(request: ApprovalRequest, signal?: AbortSignal): Promise<RequestResult> {
    // Not async on purpose: V8 keeps an async function's params alive across every await, which
    // would pin the attachment bytes for the whole wait. #wait only sees the SentRequest.
    return this.send(request, signal).then((sent) => sent.result)
  }

  /**
   * Resolves once the message is sent, with its id and a `result` that settles like `request`.
   * Throws `SendError` like `request`.
   */
  send(request: ApprovalRequest, signal?: AbortSignal): Promise<SentQuestion> {
    // Not async on purpose: V8 keeps an async function's params alive across every await, which
    // would pin the attachment bytes for the whole wait. #wait only sees the SentRequest.
    return this.#open(request).then((opened) => {
      let finalText: FormattedText | undefined
      const result = this.#wait(opened, signal, (text) => {
        finalText = text
      })
      return {
        id: opened.id,
        reference: opened.reference,
        message: opened.request.message,
        result,
        finalText: () => finalText,
      }
    })
  }

  /**
   * Replaces the text of a sent question's message, keeping its buttons when `buttons` is given.
   * Updates of one message go out in order, and those queued while it's open land before its final
   * edit; one with `buttons` is dropped once the question settled. Skipped without
   * `messenger.update`. Never rejects: a failed update is only logged.
   */
  update(
    question: SentQuestion,
    message: FormattedText,
    buttons: MessageButtons | undefined,
  ): Promise<void> {
    if (this.#messenger.update === undefined) {
      return Promise.resolve()
    }
    const { id, reference } = question
    const previous = this.#updates.get(id) ?? Promise.resolve()
    const queued = previous
      .then(async () => {
        if (buttons !== undefined && !this.#pending.has(id)) {
          return
        }
        await this.#messenger.update?.(reference, message, buttons)
      })
      .catch((error: unknown) => console.error('failed to update approval message', error))
    this.#updates.set(id, queued)
    void queued.then(() => {
      if (this.#updates.get(id) === queued) {
        this.#updates.delete(id)
      }
    })
    return queued
  }

  /**
   * Settles an open request as closed by a vote decided with `answer`; 'expired' when the id is
   * unknown or already settled.
   */
  close(id: string, answer: string): 'closed' | 'expired' {
    return this.#pending.close(id, answer) ? 'closed' : 'expired'
  }

  /**
   * Sends a background question and resolves once the message is sent, without waiting for an
   * answer. Throws `SendError` like `request`. Its id is readable with `get` from here until
   * `RESULT_TTL_MS` after it settles.
   */
  async start(request: ApprovalRequest): Promise<StartedRequest> {
    const opened = await this.#open(request)
    const expiresAt = new Date(opened.openedAt.getTime() + opened.request.timeoutSeconds * 1000)
    const settled = opened.settlement.then((settlement) => {
      const state = ApprovalService.#toRequestState(settlement)
      // Recorded before the final edit, so a read right after a settle never sees an unknown id.
      this.#background.set(opened.id, { state, settled })
      this.#finishBackground(opened, settlement).catch((error) =>
        console.error('failed to finish background request', error),
      )
      return state
    })
    this.#background.set(opened.id, { state: { kind: 'pending', expiresAt }, settled })
    return { id: opened.id, expiresAt }
  }

  /** A background question's state; undefined for unknown, blocking or expired ids. */
  get(id: string): RequestState | undefined {
    return this.#background.get(id)?.state
  }

  /**
   * Resolves with the current state once the question settles, `waitMs` passes or `signal` aborts,
   * whichever comes first. Aborting never cancels the question. Undefined for unknown ids.
   */
  async waitFor(
    id: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<RequestState | undefined> {
    const entry = this.#background.get(id)
    if (entry === undefined || entry.state.kind !== 'pending' || signal?.aborted) {
      return entry?.state
    }
    const { promise, resolve } = Promise.withResolvers<void>()
    const timer = setTimeout(resolve, waitMs)
    const stopWaiting = () => resolve()
    signal?.addEventListener('abort', stopWaiting, { once: true })
    void entry.settled.then(stopWaiting)
    await promise
    clearTimeout(timer)
    signal?.removeEventListener('abort', stopWaiting)
    return this.get(id)
  }

  /**
   * Cancels a pending background question and resolves with `cancelled` once that's recorded, not
   * waiting for the final edit. A settled one keeps its state; undefined for unknown ids.
   */
  async cancel(id: string): Promise<RequestState | undefined> {
    const entry = this.#background.get(id)
    if (entry === undefined) {
      return undefined
    }
    this.#pending.cancel(id)
    return entry.settled
  }

  /**
   * Records a button tap; 'expired' when the request is unknown, already settled or the index is
   * invalid.
   */
  tap(id: string, optionIndex: number): 'accepted' | 'expired' {
    return this.#pending.answer(id, optionIndex) ? 'accepted' : 'expired'
  }

  /** Records a typed reply; 'expired' when the request is unknown, settled or buttons-only. */
  reply(id: string, text: string): 'accepted' | 'expired' {
    return this.#pending.reply(id, text) ? 'accepted' : 'expired'
  }

  /** Open requests, oldest first. */
  listPending(): readonly PendingSummary[] {
    return this.#pending.list()
  }

  /**
   * Settles every open request as rejected with its timeout option; callers get `timedOut: false`.
   * Returns what it rejected, oldest first.
   */
  rejectAll(): readonly PendingSummary[] {
    return this.#pending.rejectAll()
  }

  /** The last `count` settled requests, newest first; empty for `count <= 0`. Never throws. */
  history(count: number): readonly HistoryEntry[] {
    if (!(count > 0)) {
      return []
    }
    return this.#history.slice(-count).toReversed()
  }

  /**
   * Marks requests left over from a previous run as expired and removes their records. Never
   * rejects; without `messenger.finalize` the records are only removed.
   */
  async expireOrphans(records: readonly RequestRecord[]): Promise<void> {
    for (const record of records) {
      const message = { text: record.text, spans: record.spans ?? [] }
      const endedAt = this.#now()
      this.#audit?.settled(record.id, EXPIRED_ENDING, endedAt)
      await this.#finalize(
        record.reference,
        formatFinalText(message, EXPIRED_ENDING, endedAt),
        EXPIRED_ENDING,
      )
      this.#store?.removeRequest(record.id)
    }
  }

  async #open(request: ApprovalRequest): Promise<OpenedRequest> {
    const id = this.#newId()
    // Everything kept past the send uses `sent`, so a long wait doesn't hold the attachment bytes.
    const { attachment: _attachment, ...sent } = request
    let reference
    try {
      reference = await this.#messenger.sendRequest(
        id,
        request.message,
        request.options,
        request.allowText,
        request.attachment,
        request.recipient,
      )
    } catch (cause) {
      throw new SendError('failed to send approval request', { cause })
    }
    if (this.#messenger.finalize !== undefined) {
      this.#store?.addRequest({
        id,
        reference,
        text: sent.message.text,
        ...(sent.message.spans.length > 0 && { spans: sent.message.spans }),
      })
    }
    const openedAt = this.#now()
    this.#audit?.asked(id, sent, openedAt)
    const settlement = this.#pending.open(id, sent, openedAt)
    return { id, request: sent, reference, openedAt, settlement }
  }

  async #wait(
    opened: OpenedRequest,
    signal?: AbortSignal,
    onFinalText?: (text: FormattedText) => void,
  ): Promise<RequestResult> {
    const { id, reference, settlement: settled } = opened
    const onAbort = () => {
      this.#pending.cancel(id)
    }
    // Checked after open() so an abort during sendRequest is not missed.
    if (signal?.aborted) {
      onAbort()
    } else {
      signal?.addEventListener('abort', onAbort, { once: true })
    }
    const settlement = await settled
    signal?.removeEventListener('abort', onAbort)
    const finalText = await this.#finish(id, opened.request, reference, settlement)
    onFinalText?.(finalText)
    if (settlement.kind === 'cancelled') {
      return CANCELLED_RESULT
    }
    return {
      kind: 'completed',
      outcome: { answer: settlement.answer, timedOut: settlement.kind === 'timedOut' },
    }
  }

  async #finish(
    id: string,
    request: SentRequest,
    reference: MessageReference,
    settlement: Settlement,
  ): Promise<FormattedText> {
    const settledAt = this.#now()
    this.#audit?.settled(id, settlement, settledAt)
    this.#history.push({ text: request.message.text, settlement, settledAt })
    if (this.#history.length > HISTORY_LIMIT) {
      this.#history.shift()
    }
    const ending =
      settlement.kind === 'timedOut' && request.reaskOnTimeout === true
        ? REASKED_ENDING
        : settlement
    const finalText = formatFinalText(request.message, ending, settledAt)
    await this.#updates.get(id)
    await this.#finalize(reference, finalText, ending)
    this.#store?.removeRequest(id)
    return finalText
  }

  async #finishBackground(opened: OpenedRequest, settlement: Settlement): Promise<void> {
    try {
      await this.#finish(opened.id, opened.request, opened.reference, settlement)
    } finally {
      setTimeout(() => this.#background.delete(opened.id), RESULT_TTL_MS).unref()
    }
  }

  async #finalize(
    reference: MessageReference,
    finalText: FormattedText,
    ending: MessageEnding,
  ): Promise<void> {
    if (this.#messenger.finalize === undefined) {
      return
    }
    try {
      await this.#messenger.finalize(reference, finalText, ending)
    } catch (error) {
      console.error('failed to finalize approval message', error)
    }
  }

  static #toRequestState(settlement: Settlement): RequestState {
    if (settlement.kind === 'cancelled') {
      return CANCELLED_STATE
    }
    return {
      kind: 'done',
      outcome: { answer: settlement.answer, timedOut: settlement.kind === 'timedOut' },
    }
  }
}
