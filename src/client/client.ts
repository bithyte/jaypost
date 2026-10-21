import { parseToken, resolveClientToken, resolveTokenFile } from '../auth/index.ts'
import { DEFAULT_PORT } from '../config/constants.ts'
import { prepareAttachment } from './attachment.ts'
import { HOST } from './constants.ts'
import { postApi, requestApi, toSendTimeoutMs } from './http.ts'
import type {
  Answer,
  ApiPath,
  AskRequest,
  AttachmentBody,
  AttachmentInput,
  ClientOptions,
  Notification,
} from './types.ts'

/** Thrown by `Client` when the service is unreachable, rejects the input or can't send. */
export class JaypostError extends Error {
  override name = 'JaypostError'
}

/**
 * Asks questions and sends notifications through a running jaypost service. Calls throw
 * `JaypostError` when the token lookup finds an unusable token.
 */
export class Client {
  #host: string
  #port: number
  #project: string | undefined
  #token: string | undefined

  constructor(options: ClientOptions = {}) {
    this.#host = options.host ?? HOST
    this.#port = options.port ?? DEFAULT_PORT
    this.#project = options.project
    if (options.token !== undefined) {
      const token = parseToken(options.token)
      if (token === undefined) {
        throw new RangeError("token isn't a valid jaypost token")
      }
      this.#token = token
    }
  }

  /**
   * Resolves once the user taps a button or replies with text (`allowText`), or the timeout fires
   * (then with `timeoutOption`). Throws `JaypostError` on failure (including an unusable token
   * lookup), or the signal's reason if aborted.
   */
  async request(request: AskRequest): Promise<Answer> {
    const project = request.project ?? this.#project
    const signal = request.signal ?? new AbortController().signal
    const token = this.#resolveToken()
    const attachment = await this.#prepare(request.attachment, signal, token)
    const result = await requestApi(
      this.#port,
      {
        text: request.text,
        ...(request.options === undefined ? {} : { options: request.options }),
        ...(request.allowText === undefined ? {} : { allowText: request.allowText }),
        timeoutOption: request.timeoutOption,
        ...(request.timeout === undefined ? {} : { timeout: request.timeout }),
        ...(project === undefined ? {} : { project }),
        ...(request.format === undefined ? {} : { format: request.format }),
        ...(attachment === undefined ? {} : { attachment }),
      },
      { signal, host: this.#host, ...(token === undefined ? {} : { token }) },
    )
    if (signal.aborted) {
      throw signal.reason
    }
    if (result.kind === 'failed') {
      throw new JaypostError(result.message)
    }
    return result.outcome
  }

  /** Resolves once Telegram accepts the message. Throws like `request`. */
  async notify(notification: Notification): Promise<void> {
    const attachment = await this.#prepare(
      notification.attachment,
      notification.signal ?? new AbortController().signal,
      this.#resolveToken(),
    )
    await this.#post(
      '/notify',
      {
        text: notification.text,
        ...(notification.format === undefined ? {} : { format: notification.format }),
        ...(attachment === undefined ? {} : { attachment }),
      },
      notification,
      toSendTimeoutMs(attachment !== undefined),
    )
  }

  /** Reads and checks the attachment, if any; throws `JaypostError` when it can't be sent. */
  async #prepare(
    input: AttachmentInput | undefined,
    signal: AbortSignal,
    token: string | undefined,
  ): Promise<AttachmentBody | undefined> {
    if (input === undefined) {
      return undefined
    }
    const result = await prepareAttachment(this.#port, input, {
      signal,
      host: this.#host,
      ...(token === undefined ? {} : { token }),
    })
    if (signal.aborted) {
      throw signal.reason
    }
    if (result.kind === 'failed') {
      throw new JaypostError(result.message)
    }
    return result.attachment
  }

  async #post(
    path: ApiPath,
    body: object,
    call: { readonly project?: string; readonly signal?: AbortSignal },
    timeoutMs: number,
  ): Promise<unknown> {
    const project = call.project ?? this.#project
    const signal = call.signal ?? new AbortController().signal
    const token = this.#resolveToken()
    const result = await postApi(
      this.#port,
      path,
      { ...body, ...(project === undefined ? {} : { project }) },
      {
        signal,
        timeoutMs,
        host: this.#host,
        ...(token === undefined ? {} : { token }),
      },
    )
    if (signal.aborted) {
      throw signal.reason
    }
    if (result.kind === 'failed') {
      throw new JaypostError(result.message)
    }
    return result.body
  }

  #resolveToken(): string | undefined {
    if (this.#token !== undefined) {
      return this.#token
    }
    const found = resolveClientToken(process.env, resolveTokenFile(process.env))
    switch (found.kind) {
      case 'token':
        return found.token
      case 'none':
        return undefined
      case 'unusable':
        throw new JaypostError(found.message)
    }
  }
}
