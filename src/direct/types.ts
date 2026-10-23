import type {
  ApprovalRequest,
  AskProgress,
  RequestResult,
  Vote,
  VoteResult,
} from '../approval/index.ts'
import type { NotifyRequest } from '../notify/index.ts'
import type { Provider, SettingValues } from '../provider/index.ts'

/** How `send` reaches the provider, from `JAYPOST_MODE`; `invalid` keeps the raw value. */
export type SendMode =
  | { readonly kind: 'service' }
  | { readonly kind: 'direct' }
  | { readonly kind: 'invalid'; readonly value: string }

/** The provider and its parsed settings, read from env only. */
export type DirectConfig = {
  readonly provider: Provider
  readonly settings: SettingValues
}

/** A provider runtime driven in-process, without the service. */
export type DirectSession = {
  /**
   * Starts the runtime on first use and resolves once settled. Rejects with `SendError` when the
   * message can't be sent, or with the provider's message on a fatal provider error.
   */
  readonly request: (
    request: ApprovalRequest,
    signal: AbortSignal,
    retryCount?: number,
    onProgress?: (event: AskProgress) => void,
  ) => Promise<RequestResult>
  /**
   * Runs a vote with the same rejections as `request`, except a failed send rejects with
   * `VoterSendError`. `retryCount` is part of the vote.
   */
  readonly vote: (
    vote: Vote,
    signal: AbortSignal,
    onProgress?: (event: AskProgress) => void,
  ) => Promise<VoteResult>
  /** Sends without a dismiss button; rejects with `SendError` when the provider fails. */
  readonly notify: (request: NotifyRequest) => Promise<void>
  /** Stops the runtime; never rejects, safe when it never started. */
  readonly stop: () => Promise<void>
}

/** Where the approvers came from: `listed` ids, a set but `empty` env var, or `none` given. */
export type ApproverList =
  | { readonly kind: 'listed'; readonly voters: readonly string[] }
  | { readonly kind: 'empty' }
  | { readonly kind: 'none' }
