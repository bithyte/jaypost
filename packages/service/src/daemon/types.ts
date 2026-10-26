import type { PairingCodes, Provider, QuietHours, QuietPatch } from '@jaypost/core'
import type { BotRecord, PairingRecord, Registry, RegistryStore } from '@jaypost/store'
import type { ApiBot } from '../server/index.ts'

/** The registry's view of one bot's people, injected so the bot never touches storage. Calls never throw. */
export type BotPeople = {
  readonly isPaired: (person: string) => boolean
  readonly list: () => readonly string[]
  /** Pending pairing codes by pairing id, read once at start. */
  readonly pendingCodes: () => ReadonlyMap<string, string>
  /** Someone redeemed `pairingId`'s code; the hub records it and saves. */
  readonly claim: (pairingId: string, person: string) => void
  readonly quietHours: (person: string) => {
    readonly quietHours?: QuietHours
    readonly mutedUntil?: Date
  }
  /** May throw; the person's `QuietService` reports it and keeps the change in memory. */
  readonly saveQuiet: (person: string, patch: QuietPatch) => void
}

/** What `startBot` needs to start one bot. */
export type BotOptions = {
  readonly record: BotRecord
  readonly provider: Provider
  /** Where the bot's state and audit files live, from `resolveBotFiles`. */
  readonly directory: string
  readonly people: BotPeople
  /** The provider can't continue; the caller decides what happens next. */
  readonly fatal: (message: string) => void
  readonly log?: (line: string) => void
}

/** A bot whose provider runtime is started, ready to put behind the HTTP API. */
export type RunningBot = {
  readonly bot: ApiBot
  /** The outstanding pairing codes; the hub adds and removes codes at runtime. */
  readonly codes: PairingCodes
  /** Starts cleanup of the previous run's messages once; resolves when done; never rejects. */
  readonly recover: () => Promise<void>
  /**
   * Freezes the saved state synchronously, before its first await (so pending requests stay saved
   * for the next start), then stops the provider runtime; never rejects.
   */
  readonly stop: () => Promise<void>
}

/** Where a supervised bot is: starting, running, or failed and waiting for its next attempt. */
export type BotState =
  | { readonly kind: 'starting' }
  | { readonly kind: 'running'; readonly running: RunningBot }
  | { readonly kind: 'failed'; readonly reason: string }

export type BotSupervisorOptions = {
  /** Starts the bot; a throw's message becomes the failed state's reason. */
  readonly start: () => Promise<RunningBot>
  readonly log: (line: string) => void
  /** Delay before the first retry; doubles after each failure. Default 5 s. */
  readonly initialDelayMs?: number
  /** Longest delay between retries. Default 5 min. */
  readonly maxDelayMs?: number
}

export type HubOptions = {
  readonly store: RegistryStore
  /** What `store` holds now; the hub keeps it in memory and saves every change through `store`. */
  readonly registry: Registry
  readonly providers: readonly Provider[]
  /** Bot directories live next to it. */
  readonly configPath: string
  readonly adminKey: string
  /** Where the admin key file is, for rotating it. */
  readonly adminKeyPath: string
  /** Shown in /openapi.yaml. */
  readonly version: string
  readonly now?: () => Date
  readonly generateCode?: () => string
  readonly log?: (line: string) => void
}

/** A new API key. `key` is the plaintext, shown only here; `code` and `instructions` while pending. */
export type CreatedKey = {
  readonly kind: 'created'
  readonly id: string
  readonly key: string
  readonly pairing: PairingRecord
  /** Formatted for display, like `/status` shows it. */
  readonly code?: string
  readonly instructions?: string
}
