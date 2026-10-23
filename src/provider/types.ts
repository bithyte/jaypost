import type {
  Attachment,
  MessageButtons,
  MessageEnding,
  MessageReference,
  OwnerCommand,
} from '../approval/index.ts'
import type { FormattedText } from '../format/index.ts'
import type { PairResult } from '../pairing/index.ts'
import type { SendNotificationOptions } from '../notify/index.ts'

export type SettingValue = string | number

/** Provider settings by config key; only valid values, absent when unknown. */
export type SettingValues = Readonly<Record<string, SettingValue>>

export type ProviderSetting = {
  readonly configKey: string
  readonly envVar: string
  /** Lowercase noun for errors: `missing bot token`. */
  readonly description: string
  readonly secret: boolean
  /** Set by pairing, cleared by reset-owner. At most one per provider. */
  readonly owner: boolean
  readonly required: boolean
  /** Prompt label at init; settings without one are never asked for. */
  readonly prompt?: string
  /** Converts an env string or config value; undefined when invalid. Never throws. */
  readonly parse: (raw: unknown) => SettingValue | undefined
}

export type CredentialCheck =
  | { readonly ok: true; readonly displayName: string }
  | { readonly ok: false; readonly reason: string }

export type SetupText = {
  readonly leftoverFound: string
  readonly reusing: (displayName: string) => string
  readonly rejected: string
  /** Present iff the provider has an owner setting. */
  readonly resetOwnerWarning?: string
}

export type ProviderSetup = {
  /** Never puts secret values in `reason`. */
  readonly checkCredentials: (settings: SettingValues) => Promise<CredentialCheck>
  readonly text: SetupText
}

export type RuntimeHandlers = {
  readonly answer: (id: string, optionIndex: number) => 'accepted' | 'expired'
  /**
   * A typed answer for request `id`; 'expired' when it is unknown, settled, or doesn't allow text.
   */
  readonly reply: (id: string, text: string) => 'accepted' | 'expired'
  readonly dismiss: (id: string) => boolean
  /** Present only while pairing. */
  readonly pair?: (senderId: string, text: string) => PairResult
  /** Commands the owner can send; the provider shows them in its menu if it has one. */
  readonly commands: readonly OwnerCommand[]
  /** Reply text for an owner command, or undefined to stay silent. Never throws. */
  readonly command: (name: string, argument: string) => string | undefined
  /** The provider can't continue; the daemon logs `message` and exits 1. */
  readonly fatal: (message: string) => void
}

export type ProviderRuntime = {
  readonly checkCredentials: () => Promise<CredentialCheck>
  /** The returned reference must be JSON-serializable (it's saved to the state file). */
  readonly sendRequest: (
    id: string,
    message: FormattedText,
    options: readonly string[],
    allowText: boolean,
    attachment: Attachment | undefined,
    recipient: string | undefined,
  ) => Promise<MessageReference>
  /** Request ended; called once per ended request, `expired` included. Absent means skipped. */
  readonly finalize?: (
    reference: MessageReference,
    message: FormattedText,
    ending: MessageEnding,
  ) => Promise<void>
  /** Replaces a sent message's text, keeping its buttons when `buttons` is given. Optional. */
  readonly update?: (
    reference: MessageReference,
    message: FormattedText,
    buttons: MessageButtons | undefined,
  ) => Promise<void>
  /** The returned reference must be JSON-serializable (it's saved to the state file). */
  readonly sendNotification?: (
    id: string,
    message: FormattedText,
    options: SendNotificationOptions,
    attachment: Attachment | undefined,
  ) => Promise<MessageReference>
  readonly deleteMessage?: (reference: MessageReference) => Promise<void>
  /** Present iff the provider pairs; `code` is raw (no dash). */
  readonly pairingInstructions?: (code: string) => string
  /**
   * How an approver (not the owner) pairs, when that differs; `setup-ci` falls back to
   * `pairingInstructions`.
   */
  readonly approverPairingInstructions?: (code: string) => string
  /** Extra /status fields kept for old CLIs (Telegram: `bot`). */
  readonly statusFields?: () => Readonly<Record<string, string>>
  readonly start: (handlers: RuntimeHandlers) => void
  readonly stop: () => Promise<void>
}

export type Provider = {
  readonly name: string
  readonly label: string
  readonly maxTextLength: number
  /** Largest attachment this provider sends, in bytes; absent means no attachment support. */
  readonly maxAttachmentBytes?: number
  /** Most options a request may have; absent means no limit of the provider's own. */
  readonly maxOptionCount?: number
  readonly settings: readonly ProviderSetting[]
  readonly setup: ProviderSetup
  readonly createRuntime: (settings: SettingValues, log: (line: string) => void) => ProviderRuntime
}

/**
 * Voter ids in the form a tap's sender id takes, or the first id the owner setting can't parse, or
 * `noOwner` when the owner was asked for and there is none.
 */
export type VoterIds =
  | { readonly kind: 'voters'; readonly voters: readonly string[] }
  | { readonly kind: 'invalid'; readonly voter: string }
  | { readonly kind: 'noOwner' }
