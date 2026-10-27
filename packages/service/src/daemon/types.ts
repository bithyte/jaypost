import type { Provider, QuietHours, QuietPatch } from '@jaypost/core'
import type { BotRecord, ClaimCodeResult, Registry, RegistryStore } from '@jaypost/store'
import type { ApiBot } from '../server/index.ts'

/** The registry's view of one bot's people, injected so the bot never touches storage. Calls never throw. */
export type BotPeople = {
  readonly isPaired: (person: string) => boolean
  readonly list: () => readonly string[]
  /**
   * `person` sent `text`, which may be a pending pairing's code. Checked against the registry as it
   * is now; on a claim the hub records it and saves.
   */
  readonly claim: (text: string, person: string) => ClaimCodeResult['kind']
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
  /** Starts cleanup of the previous run's messages once; resolves when done; never rejects. */
  readonly recover: () => Promise<void>
  /**
   * Freezes the saved state synchronously, before its first await (so pending requests stay saved
   * for the next start), then stops the provider runtime; never rejects.
   */
  readonly stop: () => Promise<void>
  /**
   * Drops what the bot keeps in memory for `person` (their quiet hours and mute), so it's read
   * again from `people` if they pair again. Call it once they're no longer paired on this bot.
   */
  readonly forgetPerson: (person: string) => void
  /**
   * For a runtime that failed: rejects every open question with its timeout option and drops their
   * saved records, so the next start doesn't expire them again, then stops like `stop`; never
   * rejects.
   */
  readonly abandon: () => Promise<void>
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
  /**
   * How long a bot must keep running before the delay starts over; the next delay counts too, if
   * longer. Default 1 min.
   */
  readonly stableMs?: number
  /** Called once a start is accepted, before anything can stop it. */
  readonly onRunning?: (running: RunningBot) => void
}

export type HubOptions = {
  readonly store: RegistryStore
  /** What `store` holds now; the hub keeps it in memory and saves every change through `store`. */
  readonly registry: Registry
  readonly providers: readonly Provider[]
  /** Bot directories live next to it. */
  readonly configPath: string
  readonly adminKey: string
  /** Where the admin key file is; rotating the key rewrites it. */
  readonly adminKeyPath: string
  /** Shown in /openapi.yaml. */
  readonly version: string
  readonly now?: () => Date
  readonly generateCode?: () => string
  readonly log?: (line: string) => void
}
