import type { ApprovalService, NotificationService, VoterIds } from '@jaypost/core'
import type { ApiAuth } from '@jaypost/store'
import type { StatusInfo } from '@jaypost/protocol'

/**
 * One bot behind the HTTP API: its questions, notifications and its provider's limits. Pairing
 * state belongs to the registry; `status` and `recipient` are the interim single-owner view.
 */
export type ApiBot = {
  readonly service: Pick<
    ApprovalService,
    'request' | 'start' | 'get' | 'waitFor' | 'cancel' | 'send' | 'close' | 'update'
  >
  /** Interim: paired when anyone is, else the first pending code; removed with Task 7. */
  readonly status: () => StatusInfo
  /** Who requests and notifications go to when the caller names no one; removed with Task 7. */
  readonly recipient: () => string | undefined
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

/** The bot a call reaches, or why it reaches none (the API answers 401). */
export type BotRoute =
  | { readonly kind: 'bot'; readonly bot: ApiBot }
  | { readonly kind: 'unauthorized'; readonly reason: 'missing' | 'wrong' }

/** Picks the bot for each call from its Authorization header. */
export type BotRouter = {
  /** Never throws; runs before the body is read. */
  readonly route: (authorization: string | undefined) => BotRoute
  /** What /openapi.yaml shows besides the port; it needs no token, so it can't ask a bot. */
  readonly openApi: Omit<OpenApiOptions, 'port'>
}

/** A daemon's single bot, its API auth and the version /openapi.yaml shows. */
export type SingleBotOptions = ApiBot & {
  /** With a token, every route but /openapi.yaml answers 401 unless it is presented. */
  readonly auth: ApiAuth
  readonly version: string
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
