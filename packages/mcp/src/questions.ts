import type { Caller } from '@jaypost/client'
import { CANCEL_TIMEOUT_MS } from './constants.ts'
import type { OpenQuestion } from './types.ts'

/**
 * Background questions this MCP server asked and hasn't seen settle. They belong to the agent
 * session, so `cancelAll` cancels them when the session ends.
 */
export class OpenQuestions {
  #questionsById = new Map<string, OpenQuestion>()

  add(question: OpenQuestion): void {
    this.#questionsById.set(question.id, question)
  }

  settle(id: string): void {
    this.#questionsById.delete(id)
  }

  /** The open questions in the order they were asked. */
  list(): readonly OpenQuestion[] {
    return [...this.#questionsById.values()]
  }

  /**
   * DELETEs every open question in parallel and forgets them. Gives up after `timeoutMs`; an
   * unusable token fails each cancel without a request. Never rejects.
   */
  async cancelAll(caller: Caller, timeoutMs: number = CANCEL_TIMEOUT_MS): Promise<void> {
    const ids = [...this.#questionsById.keys()]
    this.#questionsById.clear()
    const signal = new AbortController().signal
    // Caller never throws and aborts each call after timeoutMs, so this is bounded too.
    await Promise.all(ids.map((id) => caller.cancel(id, { signal, timeoutMs })))
  }
}
