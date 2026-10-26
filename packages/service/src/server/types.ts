import type { ApprovalService, NotificationService, RequestCaller, VoterIds } from '@jaypost/core'
import type { ApiAuth, AuditReadResult } from '@jaypost/store'
import type { StatusInfo } from '@jaypost/protocol'

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

/** The key a call presents, with its pairing's person and bot. */
export type KeyRoute = {
  readonly kind: 'key'
  readonly caller: RequestCaller
  /** Undefined while the pairing waits for its code (the API answers 503 not paired). */
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
  /** Never throws; runs before the body is read. */
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
