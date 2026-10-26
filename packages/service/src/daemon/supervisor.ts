import { INITIAL_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS, STABLE_RUN_MS } from './constants.ts'
import type { BotState, BotSupervisorOptions, RunningBot } from './types.ts'

function formatDelay(delayMs: number): string {
  return delayMs % 60_000 === 0 ? `${delayMs / 60_000}m` : `${delayMs / 1000}s`
}

/**
 * Keeps one bot running: starts it, and after a failed start or a fatal provider error retries
 * with doubling backoff until stopped. The delay starts over only once a bot has kept running for
 * the stable period, so one that fails right after each start keeps backing off. Never throws.
 */
export class BotSupervisor {
  readonly #start: () => Promise<RunningBot>
  readonly #log: (line: string) => void
  readonly #initialDelayMs: number
  readonly #maxDelayMs: number
  readonly #stableMs: number
  readonly #onRunning: ((running: RunningBot) => void) | undefined
  #state: BotState = { kind: 'starting' }
  #delayMs: number
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  #stableTimer: ReturnType<typeof setTimeout> | undefined
  // Bumped by fail and stop, so an attempt that finishes after either is discarded.
  #generation = 0
  #isStopped = false

  constructor(options: BotSupervisorOptions) {
    this.#start = options.start
    this.#log = options.log
    this.#initialDelayMs = options.initialDelayMs ?? INITIAL_RETRY_DELAY_MS
    this.#maxDelayMs = options.maxDelayMs ?? MAX_RETRY_DELAY_MS
    this.#stableMs = options.stableMs ?? STABLE_RUN_MS
    this.#onRunning = options.onRunning
    this.#delayMs = this.#initialDelayMs
  }

  get state(): BotState {
    return this.#state
  }

  /** Starts now; resolves once this first attempt has succeeded or failed. Never rejects. */
  run(): Promise<void> {
    return this.#attempt()
  }

  /**
   * Called from the bot's `fatal`: abandons the runtime (its open questions are rejected), marks it
   * failed and schedules a retry. Ignored once failed or stopped, so a late call from an old
   * runtime changes nothing.
   */
  fail(reason: string): void {
    if (this.#isStopped || this.#state.kind === 'failed') {
      return
    }
    this.#generation += 1
    clearTimeout(this.#stableTimer)
    if (this.#state.kind === 'running') {
      void this.#state.running.abandon()
    }
    this.#retryLater(`stopped: ${reason}`, reason)
  }

  /** Cancels any retry and stops the runtime; its state is frozen before the first await. */
  async stop(): Promise<void> {
    this.#isStopped = true
    this.#generation += 1
    clearTimeout(this.#retryTimer)
    clearTimeout(this.#stableTimer)
    const running = this.#state.kind === 'running' ? this.#state.running : undefined
    this.#state = { kind: 'failed', reason: 'stopped' }
    await running?.stop()
  }

  async #attempt(): Promise<void> {
    if (this.#isStopped) {
      return
    }
    this.#state = { kind: 'starting' }
    const generation = this.#generation
    let running: RunningBot
    try {
      running = await this.#start()
    } catch (error) {
      if (generation !== this.#generation) {
        return
      }
      const reason = error instanceof Error ? error.message : String(error)
      this.#retryLater(`couldn't start: ${reason}`, reason)
      return
    }
    if (generation !== this.#generation) {
      await running.stop()
      return
    }
    this.#state = { kind: 'running', running }
    this.#stableTimer = setTimeout(
      () => {
        this.#delayMs = this.#initialDelayMs
      },
      Math.max(this.#stableMs, this.#delayMs),
    )
    this.#onRunning?.(running)
  }

  #retryLater(what: string, reason: string): void {
    const delayMs = this.#delayMs
    this.#state = { kind: 'failed', reason }
    this.#delayMs = Math.min(delayMs * 2, this.#maxDelayMs)
    this.#log(`${what}; retrying in ${formatDelay(delayMs)}`)
    this.#retryTimer = setTimeout(() => void this.#attempt(), delayMs)
  }
}
