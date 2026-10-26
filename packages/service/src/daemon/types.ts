import type { PairingCodes, Provider, QuietHours, QuietPatch } from '@jaypost/core'
import type { BotRecord } from '@jaypost/store'
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
