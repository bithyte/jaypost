import { parseToken, resolveClientToken, resolveTokenFile } from '../auth/index.ts'
import type { ClientToken } from '../auth/index.ts'
import { DEFAULT_PORT } from '../config/constants.ts'
import { Caller } from './caller.ts'
import { HOST } from './constants.ts'
import type { Answer, AskRequest, ClientOptions, Notification } from './types.ts'

/** Thrown by `Client` when the service is unreachable, rejects the input or can't send. */
export class JaypostError extends Error {
  override name = 'JaypostError'
}

/**
 * Asks questions and sends notifications through a running jaypost service. Calls throw
 * `JaypostError` when the token lookup finds an unusable token.
 */
export class Client {
  #caller: Caller
  #project: string | undefined
  #token: string | undefined

  constructor(options: ClientOptions = {}) {
    this.#project = options.project
    if (options.token !== undefined) {
      const token = parseToken(options.token)
      if (token === undefined) {
        throw new RangeError("token isn't a valid jaypost token")
      }
      this.#token = token
    }
    this.#caller = new Caller({
      port: options.port ?? DEFAULT_PORT,
      host: options.host ?? HOST,
      readToken: () => this.#readToken(),
    })
  }

  /**
   * Resolves once the user taps a button or replies with text (`allowText`), or the timeout fires
   * (then with `timeoutOption`). Throws `JaypostError` on failure (including an unusable token
   * lookup), or the signal's reason if aborted.
   */
  async request(request: AskRequest): Promise<Answer> {
    const signal = request.signal ?? new AbortController().signal
    const { signal: _signal, ...question } = request
    const result = await this.#caller.ask(
      { ...question, ...this.#withProject(request.project) },
      { signal },
    )
    throwIfAborted(signal)
    if (result.kind === 'failed') {
      throw new JaypostError(result.message)
    }
    return { answer: result.answer, timedOut: result.timedOut }
  }

  /** Resolves once Telegram accepts the message. Throws like `request`. */
  async notify(notification: Notification): Promise<void> {
    const signal = notification.signal ?? new AbortController().signal
    const { signal: _signal, ...message } = notification
    const result = await this.#caller.notify(
      { ...message, ...this.#withProject(notification.project) },
      { signal },
    )
    throwIfAborted(signal)
    if (result.kind === 'failed') {
      throw new JaypostError(result.message)
    }
  }

  #withProject(project: string | undefined): { readonly project?: string } {
    const resolved = project ?? this.#project
    return resolved === undefined ? {} : { project: resolved }
  }

  #readToken(): ClientToken {
    if (this.#token !== undefined) {
      return { kind: 'token', token: this.#token, source: 'env' }
    }
    return resolveClientToken(process.env, resolveTokenFile(process.env))
  }
}

// An abort wins over whatever failure it caused.
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason
  }
}
