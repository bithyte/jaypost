import { statusInfoSchema } from '../server/schema.ts'
import type { StatusInfo } from '../server/types.ts'
import { checkAttachmentLimit, readAttachment } from './attachment.ts'
import { FETCH_GRACE_MS, HOST } from './constants.ts'
import { callApi, postApi, requestApi, toSendTimeoutMs, unreadable } from './http.ts'
import type {
  ApiOptions,
  AskBody,
  AttachmentBody,
  AttachmentSource,
  CallOptions,
  CallerOptions,
  Done,
  Failure,
  Message,
  Question,
} from './types.ts'

type Session = { readonly token?: string }

/** Every call jaypost makes to its own daemon. Never throws; aborts come back as `cancelled`. */
export class Caller {
  #port: number
  #host: string
  #readToken: CallerOptions['readToken']
  #now: () => number

  constructor(options: CallerOptions) {
    this.#port = options.port
    this.#host = options.host ?? HOST
    this.#readToken = options.readToken
    this.#now = options.now ?? (() => performance.now())
  }

  /** Resolves once the owner answers, or the timeout answer comes back. */
  async ask(question: Question, call: CallOptions): Promise<Done | Failure> {
    const session = this.#begin()
    if (session.kind === 'failed') {
      return session
    }
    const attachment = await this.#attach(question.attachment, session, call.signal)
    if (attachment.kind === 'failed') {
      return attachment
    }
    const result = await requestApi(this.#port, toAskBody(question, attachment.body), {
      ...this.#apiOptions(session, call.signal),
      now: this.#now,
    })
    if (result.kind === 'failed') {
      return result
    }
    return { kind: 'done', answer: result.outcome.answer, timedOut: result.outcome.timedOut }
  }

  /** Resolves once the service has sent the message. */
  async notify(message: Message, call: CallOptions): Promise<{ readonly kind: 'sent' } | Failure> {
    const session = this.#begin()
    if (session.kind === 'failed') {
      return session
    }
    const attachment = await this.#attach(message.attachment, session, call.signal)
    if (attachment.kind === 'failed') {
      return attachment
    }
    const result = await postApi(
      this.#port,
      '/notify',
      {
        text: message.text,
        ...(message.project === undefined ? {} : { project: message.project }),
        ...(message.format === undefined ? {} : { format: message.format }),
        ...(attachment.body === undefined ? {} : { attachment: attachment.body }),
      },
      {
        ...this.#apiOptions(session, call.signal),
        timeoutMs: toSendTimeoutMs(attachment.body !== undefined),
      },
    )
    return result.kind === 'failed' ? result : { kind: 'sent' }
  }

  /** The daemon's `/status`; `timeoutMs` defaults to the HTTP grace period. */
  async status(
    call: CallOptions & { readonly timeoutMs?: number },
  ): Promise<{ readonly kind: 'status'; readonly status: StatusInfo } | Failure> {
    const session = this.#begin()
    if (session.kind === 'failed') {
      return session
    }
    return this.#fetchStatus(session, call.signal, call.timeoutMs ?? FETCH_GRACE_MS)
  }

  #begin(): ({ readonly kind: 'session' } & Session) | Failure {
    const token = this.#readToken()
    switch (token.kind) {
      case 'unusable':
        return { kind: 'failed', reason: 'unusableToken', message: token.message }
      case 'token':
        return { kind: 'session', token: token.token }
      case 'none':
        return { kind: 'session' }
    }
  }

  #apiOptions(session: Session, signal: AbortSignal): Omit<ApiOptions, 'timeoutMs'> {
    return {
      signal,
      host: this.#host,
      ...(session.token === undefined ? {} : { token: session.token }),
    }
  }

  async #fetchStatus(
    session: Session,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<{ readonly kind: 'status'; readonly status: StatusInfo } | Failure> {
    const result = await callApi(this.#port, 'GET', '/status', undefined, {
      ...this.#apiOptions(session, signal),
      timeoutMs,
    })
    if (result.kind === 'failed') {
      return result
    }
    const parsed = statusInfoSchema.safeParse(result.body)
    if (!parsed.success) {
      return unreadable(JSON.stringify(result.body))
    }
    return { kind: 'status', status: parsed.data }
  }

  // Reads the file first, then asks the service for its limit, so a bad file or an old service
  // fails before any upload.
  async #attach(
    source: AttachmentSource | undefined,
    session: Session,
    signal: AbortSignal,
  ): Promise<{ readonly kind: 'ok'; readonly body?: AttachmentBody } | Failure> {
    if (source === undefined) {
      return { kind: 'ok' }
    }
    const read = await readAttachment(source, signal)
    if (read.kind === 'failed') {
      return read
    }
    const status = await this.#fetchStatus(session, signal, FETCH_GRACE_MS)
    if (status.kind === 'failed') {
      return status
    }
    const checked = checkAttachmentLimit(read, status.status.maxAttachmentBytes)
    return checked.kind === 'failed' ? checked : { kind: 'ok', body: checked.attachment }
  }
}

function toAskBody(question: Question, attachment: AttachmentBody | undefined): AskBody {
  return {
    text: question.text,
    ...(question.options === undefined ? {} : { options: question.options }),
    ...(question.allowText === undefined ? {} : { allowText: question.allowText }),
    timeoutOption: question.timeoutOption,
    ...(question.timeout === undefined ? {} : { timeout: question.timeout }),
    ...(question.project === undefined ? {} : { project: question.project }),
    ...(question.format === undefined ? {} : { format: question.format }),
    ...(attachment === undefined ? {} : { attachment }),
  }
}
