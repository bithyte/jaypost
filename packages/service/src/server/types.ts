import type { ApprovalService, NotificationService, RequestCaller, VoterIds } from '@jaypost/core'
import type { ApiAuth, AuditReadResult } from '@jaypost/store'
import type {
  AddBotBody,
  AdminBot,
  AdminKey,
  AdminContact,
  CreatedKey,
  CreateKeyBody,
  CreateContactBody,
  ContactInvite,
  RemovedKeys,
  RotatedAdminKey,
  StatusInfo,
  UpdateKeyBody,
} from '@jaypost/protocol'

/** One running bot behind the HTTP API: its questions, notifications and its provider's limits. */
export type ApiBot = {
  /** Named in the log when a send fails. */
  readonly botId: string
  readonly service: Pick<
    ApprovalService,
    'request' | 'start' | 'get' | 'waitFor' | 'cancel' | 'send' | 'close' | 'update'
  >
  /** Provider, display name and provider status fields (Telegram's `bot`), without pairing state. */
  readonly describe: () => { readonly provider: string; readonly displayName: string } & Readonly<
    Record<string, string>
  >
  /** How to redeem `code` on this bot; absent for providers that don't pair. */
  readonly pairingInstructions?: (code: string) => string
  /** Voter ids for /vote; without `voters`, `person` (the key's person), or noOwner when undefined. */
  readonly resolveVoters: (
    voters: readonly string[] | undefined,
    person: string | undefined,
  ) => VoterIds
  /** Settles the open questions of each key, for revocation. */
  readonly rejectForKeys: (keyIds: readonly string[]) => void
  readonly maxTextLength: number
  /** Named in the log when a send fails. */
  readonly providerName: string
  /** Absent means POST /notify answers 501. */
  readonly notifications?: Pick<NotificationService, 'notify'>
  /** Effective attachment size limit; absent or 0 means attachments are unsupported (501). */
  readonly maxAttachmentBytes?: number
  /** Most options a request may have; absent means no limit of the provider's own. */
  readonly maxOptionCount?: number
}

/** What GET /log may narrow the caller's question log to. */
export type LogQuery = {
  readonly since?: Date
  readonly project?: string
  readonly limit?: number
}

/** The key a call presents, with its contact's person and bot. */
export type KeyRoute = {
  readonly kind: 'key'
  readonly caller: RequestCaller
  /** Undefined while the contact waits for its code (the API answers 503 not paired). */
  readonly person: string | undefined
  /** Undefined while the bot isn't running (the API answers 503 bot unavailable). */
  readonly bot: ApiBot | undefined
  /** The /status body, limits included; answers from the registry when the bot isn't running. */
  readonly status: () => StatusInfo
  /** The caller key's questions in its bot's log. Throws when the log can't be read. */
  readonly readLog: (query: LogQuery) => AuditReadResult
}

/** What a call reaches, or why it reaches nothing (the API answers 401). */
export type BotRoute =
  | KeyRoute
  | { readonly kind: 'unauthorized'; readonly reason: 'missing' | 'wrong' }

/** Picks the key, and so the bot and person, for each call from its Authorization header. */
export type BotRouter = {
  /** Never throws; runs before the body is read, and again once a question or notification is. */
  readonly route: (authorization: string | undefined) => BotRoute
  /** What /openapi.yaml shows besides the port; it needs no token, so it can't ask a bot. */
  readonly openApi: () => Omit<OpenApiOptions, 'port'>
}

/**
 * One fixed bot and key behind an API guarded by `auth`, for embedding and tests. `status` gives
 * the pairing state and `recipient` who questions go to; without one the provider doesn't pair.
 */
export type SingleBotOptions = Omit<ApiBot, 'botId'> & {
  readonly botId?: string
  readonly auth: ApiAuth
  readonly version: string
  readonly status: () => StatusInfo
  readonly recipient: () => string | undefined
}

/** What varies between installs in the OpenAPI document. */
export type OpenApiOptions = {
  /** The API's version, which is the version of the jaypost release serving it. */
  readonly version: string
  readonly port: number
  readonly maxTextLength: number
  /** Attachment size limit in bytes; 0 means the provider doesn't support attachments. */
  readonly maxAttachmentBytes: number
  /** Most options a request may have; absent means no provider limit. */
  readonly maxOptionCount?: number
}

/** Why an admin call changed nothing: 400, 404 or 409, with an `error` that never quotes a body. */
export type AdminFailure = {
  readonly kind: 'invalid' | 'notFound' | 'duplicate'
  readonly error: string
}

/** What GET /admin/log may narrow every bot's log to. */
export type AdminLogQuery = LogQuery & {
  readonly bot?: string
  readonly contact?: string
  readonly key?: string
}

/**
 * The admin routes' view of the service, one method per route. Each returns the response body, or
 * an `AdminFailure` (bodies never have `kind`). A change is saved before it takes effect: a failed
 * save throws (500) and changes nothing.
 */
export type AdminApi = {
  /** Whether `authorization` carries the admin key; API keys never do. Never throws. */
  readonly isAdmin: (authorization: string | undefined) => boolean
  readonly listBots: () => { readonly bots: readonly AdminBot[] }
  /** Checks the credentials with the provider first; the new bot starts at once. */
  readonly addBot: (body: AddBotBody) => Promise<{ readonly bot: AdminBot } | AdminFailure>
  /** Stops the bot, rejecting its open questions with their timeout option. */
  readonly removeBot: (botId: string) => Promise<RemovedKeys | AdminFailure>
  readonly listContacts: (query: {
    readonly bot?: string
  }) => { readonly contacts: readonly AdminContact[] } | AdminFailure
  readonly createContact: (body: CreateContactBody) => ContactInvite | AdminFailure
  /** Drops the person, keeps the keys and rejects their open questions with the timeout option. */
  readonly resetContact: (contactId: string) => ContactInvite | AdminFailure
  readonly removeContact: (contactId: string) => RemovedKeys | AdminFailure
  readonly listKeys: (query: {
    readonly bot?: string
    readonly contact?: string
  }) => { readonly keys: readonly AdminKey[] } | AdminFailure
  readonly createKey: (body: CreateKeyBody) => CreatedKey | AdminFailure
  readonly updateKey: (
    keyId: string,
    body: UpdateKeyBody,
  ) => { readonly key: AdminKey } | AdminFailure
  /** Rejects the key's open questions with their timeout option. */
  readonly revokeKey: (keyId: string) => Readonly<Record<string, never>> | AdminFailure
  /** Throws when a log can't be read. */
  readonly readLog: (query: AdminLogQuery) => AuditReadResult | AdminFailure
  /** Writes the new key to the admin key file first; the old key stops working at once. */
  readonly rotateAdminKey: () => RotatedAdminKey
}

/** A parsed body or query, or the first problem found; `error` never quotes the input. */
export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }
