import type { Caller } from '../client/index.ts'
import { CANCEL_TIMEOUT_MS } from './constants.ts'

/**
 * Background questions this MCP server asked and hasn't seen settle. They belong to the agent
 * session, so `cancelAll` cancels them when the session ends.
 */
export class OpenQuestions {
  #ids = new Set<string>()

  add(id: string): void {
    this.#ids.add(id)
  }

  settle(id: string): void {
    this.#ids.delete(id)
  }

  /**
   * DELETEs every open question in parallel and forgets them. Gives up after `timeoutMs`; an
   * unusable token fails each cancel without a request. Never rejects.
   */
  async cancelAll(caller: Caller, timeoutMs: number = CANCEL_TIMEOUT_MS): Promise<void> {
    const ids = [...this.#ids]
    this.#ids.clear()
    const signal = new AbortController().signal
    // Caller never throws and aborts each call after timeoutMs, so this is bounded too.
    await Promise.all(ids.map((id) => caller.cancel(id, { signal, timeoutMs })))
  }
}
