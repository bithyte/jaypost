import {
  addedBotSchema,
  botListSchema,
  createdKeySchema,
  keyListSchema,
  logPageSchema,
  contactInviteSchema,
  contactListSchema,
  removedKeysSchema,
  revokedKeySchema,
  rotatedAdminKeySchema,
  updatedKeySchema,
} from '@jaypost/protocol'
import type {
  AddBotBody,
  AddedBotBody,
  BotsBody,
  CreatedKey,
  CreateKeyBody,
  CreateContactBody,
  KeysBody,
  LogPage,
  ContactInvite,
  ContactsBody,
  RemovedKeys,
  RevokedKey,
  RotatedAdminKey,
  UpdatedKeyBody,
  UpdateKeyBody,
} from '@jaypost/protocol'
import {
  ADMIN_KEY_REJECTED_MESSAGE,
  ADMIN_TOO_OLD_MESSAGE,
  FETCH_GRACE_MS,
  ROUTE_NOT_FOUND_ERROR,
  UNEXPECTED_ANSWER_MESSAGE,
} from './constants.ts'
import { fetchApi, readStringField, toLogQueryFields, toQuery, unreadable } from './http.ts'
import type {
  AdminCallerOptions,
  AdminLogFilter,
  AdminResult,
  ApiMethod,
  Failure,
  RawResponse,
} from './types.ts'

type AdminPath = `/admin/${string}`

/** The part of a zod schema `#call` uses; the client doesn't depend on zod itself. */
type Schema<T> = {
  readonly safeParse: (
    value: unknown,
  ) => { readonly success: true; readonly data: T } | { readonly success: false }
}

// Passed for the calls whose 2xx body holds a plaintext key.
const HOLDS_SECRET = true

// Nothing cancels an admin call but its timeout.
const NEVER_ABORTED = new AbortController().signal

/**
 * The admin routes of a service, called with the admin key. Never throws: 2xx answers come back
 * `ok` with the parsed body, 401 `unauthorized`, 400 `rejected`, 404 `notFound` and 409
 * `conflict`, each with the service's own error text. The admin key never appears in a message.
 */
export class AdminCaller {
  #endpoint: AdminCallerOptions['endpoint']
  #adminKey: string
  #fetchTimeoutMs: number
  #rejectedMessage: string

  constructor(options: AdminCallerOptions) {
    this.#endpoint = options.endpoint
    this.#adminKey = options.adminKey
    this.#fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_GRACE_MS
    this.#rejectedMessage = options.rejectedMessage ?? ADMIN_KEY_REJECTED_MESSAGE
  }

  listBots(): Promise<AdminResult<BotsBody>> {
    return this.#call('GET', '/admin/bots', undefined, botListSchema)
  }

  /** The service checks the credentials and starts the bot before it answers. */
  addBot(body: AddBotBody): Promise<AdminResult<AddedBotBody>> {
    return this.#call('POST', '/admin/bots', body, addedBotSchema)
  }

  /** Removes the bot with its contacts and keys; `removedKeys` lists the keys that went. */
  removeBot(id: string): Promise<AdminResult<RemovedKeys>> {
    return this.#call(
      'DELETE',
      `/admin/bots/${encodeURIComponent(id)}`,
      undefined,
      removedKeysSchema,
    )
  }

  listContacts(filter: { readonly bot?: string }): Promise<AdminResult<ContactsBody>> {
    return this.#call('GET', `/admin/contacts${toQuery(filter)}`, undefined, contactListSchema)
  }

  /** A contact with no key (an approver invite) and its code. */
  createContact(body: CreateContactBody): Promise<AdminResult<ContactInvite>> {
    return this.#call('POST', '/admin/contacts', body, contactInviteSchema)
  }

  /** Drops the contact's person and hands out a new code; its keys stay. */
  resetContact(id: string): Promise<AdminResult<ContactInvite>> {
    return this.#call(
      'POST',
      `/admin/contacts/${encodeURIComponent(id)}/reset`,
      undefined,
      contactInviteSchema,
    )
  }

  /** Removes the contact and revokes its keys. */
  removeContact(id: string): Promise<AdminResult<RemovedKeys>> {
    return this.#call(
      'DELETE',
      `/admin/contacts/${encodeURIComponent(id)}`,
      undefined,
      removedKeysSchema,
    )
  }

  listKeys(filter: {
    readonly bot?: string
    readonly contact?: string
  }): Promise<AdminResult<KeysBody>> {
    return this.#call('GET', `/admin/keys${toQuery(filter)}`, undefined, keyListSchema)
  }

  /** The answer holds the plaintext key, which the service never shows again. */
  createKey(body: CreateKeyBody): Promise<AdminResult<CreatedKey>> {
    return this.#call('POST', '/admin/keys', body, createdKeySchema, HOLDS_SECRET)
  }

  /** A string sets the field, null deletes it, absent keeps it. */
  updateKey(id: string, body: UpdateKeyBody): Promise<AdminResult<UpdatedKeyBody>> {
    return this.#call('PATCH', `/admin/keys/${encodeURIComponent(id)}`, body, updatedKeySchema)
  }

  revokeKey(id: string): Promise<AdminResult<RevokedKey>> {
    return this.#call(
      'DELETE',
      `/admin/keys/${encodeURIComponent(id)}`,
      undefined,
      revokedKeySchema,
    )
  }

  /** Every bot's log, oldest first, narrowed by `filter`. */
  readLog(filter: AdminLogFilter): Promise<AdminResult<LogPage>> {
    const query = toQuery({
      ...toLogQueryFields(filter),
      ...(filter.bot === undefined ? {} : { bot: filter.bot }),
      ...(filter.contact === undefined ? {} : { contact: filter.contact }),
      ...(filter.key === undefined ? {} : { key: filter.key }),
    })
    return this.#call('GET', `/admin/log${query}`, undefined, logPageSchema)
  }

  /** The new admin key; the service saved it to its admin key file and the old one stopped working. */
  rotateAdminKey(): Promise<AdminResult<RotatedAdminKey>> {
    return this.#call('POST', '/admin/admin-key', undefined, rotatedAdminKeySchema, HOLDS_SECRET)
  }

  async #call<T>(
    method: ApiMethod,
    path: AdminPath,
    body: object | undefined,
    schema: Schema<T>,
    holdsSecret = false,
  ): Promise<AdminResult<T>> {
    if (this.#endpoint.kind === 'invalid') {
      return { kind: 'failed', reason: 'invalidUrl', message: this.#endpoint.message }
    }
    const response = await fetchApi(this.#endpoint.url, method, path, body, {
      signal: NEVER_ABORTED,
      timeoutMs: this.#fetchTimeoutMs,
      token: this.#adminKey,
    })
    if (response.kind === 'failed') {
      return response
    }
    if (response.status < 200 || response.status > 299) {
      return toAdminFailure(response, this.#rejectedMessage)
    }
    // A 2xx body that holds a plaintext key must never reach an error message.
    const failure: Failure = holdsSecret
      ? { kind: 'failed', reason: 'unreadable', message: UNEXPECTED_ANSWER_MESSAGE }
      : unreadable(response.text.trim())
    let json: unknown
    try {
      json = JSON.parse(response.text)
    } catch {
      return failure
    }
    const parsed = schema.safeParse(json)
    return parsed.success ? { kind: 'ok', value: parsed.data } : failure
  }
}

function toAdminFailure(response: RawResponse, rejectedMessage: string): Failure {
  const { status, text } = response
  const error = readStringField(text, 'error')
  if (status === 401) {
    return { kind: 'failed', reason: 'unauthorized', message: rejectedMessage }
  }
  // The server's own 404 for a route it doesn't have; an admin 404 names the unknown id.
  if (status === 404 && (error === undefined || error.toLowerCase() === ROUTE_NOT_FOUND_ERROR)) {
    return { kind: 'failed', reason: 'tooOld', message: ADMIN_TOO_OLD_MESSAGE }
  }
  if (status === 404 && error !== undefined) {
    return { kind: 'failed', reason: 'notFound', message: error }
  }
  if (status === 400 && error !== undefined) {
    return { kind: 'failed', reason: 'rejected', message: error }
  }
  if (status === 409 && error !== undefined) {
    return { kind: 'failed', reason: 'conflict', message: error }
  }
  return {
    kind: 'failed',
    reason: 'unexpected',
    message: `jaypost service error ${status}: ${error ?? text.trim()}`,
  }
}
