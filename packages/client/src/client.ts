import { DEFAULT_PORT, parseToken, resolveClientToken, resolveTokenFile } from '@jaypost/store'
import type { ClientToken } from '@jaypost/store'
import { Caller } from './caller.ts'
import { findEnvEndpoint, parseEndpointUrl, toLocalEndpoint } from './endpoint.ts'
import type { VoteReport } from '@jaypost/core'
import type {
  Answer,
  AskRequest,
  ClientOptions,
  Notification,
  ServiceEndpoint,
  VoteRequest,
} from './types.ts'

/** Thrown by `Client` when the service is unreachable, rejects the input or can't send. */
export class JaypostError extends Error {
  override name = 'JaypostError'
}

/**
 * Asks questions and sends notifications through a running jaypost service, local or remote.
 * Calls throw `JaypostError` when the token lookup finds an unusable token or `JAYPOST_URL` is
 * unusable.
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
      endpoint: toClientEndpoint(options),
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
    const { kind: _kind, ...answer } = result
    return answer
  }

  /**
   * Asks every voter the two-way question and resolves once the vote is decided, either way;
   * `approved` says which. Throws like `request`.
   */
  async vote(request: VoteRequest): Promise<VoteReport> {
    const signal = request.signal ?? new AbortController().signal
    const { signal: _signal, voters, require, ...question } = request
    const ballot = {
      ...(voters === undefined ? {} : { voters }),
      ...(require === undefined ? {} : { rule: require }),
    }
    const result = await this.#caller.vote(
      { ...question, ...this.#withProject(request.project) },
      ballot,
      { signal },
    )
    throwIfAborted(signal)
    if (result.kind === 'failed') {
      throw new JaypostError(result.message)
    }
    return result.report
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

/** `url`, else `host` and `port`, else `JAYPOST_URL`, else the local default. */
function toClientEndpoint(options: ClientOptions): ServiceEndpoint {
  if (options.url !== undefined) {
    if (options.host !== undefined || options.port !== undefined) {
      throw new RangeError("url can't be combined with host or port")
    }
    const url = parseEndpointUrl(options.url)
    if (url === undefined) {
      throw new RangeError("url isn't an http or https URL without credentials, query or fragment")
    }
    return { kind: 'url', url }
  }
  if (options.host !== undefined || options.port !== undefined) {
    return toLocalEndpoint(options.port ?? DEFAULT_PORT, options.host)
  }
  return findEnvEndpoint(process.env) ?? toLocalEndpoint(DEFAULT_PORT)
}

// An abort wins over whatever failure it caused.
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason
  }
}
