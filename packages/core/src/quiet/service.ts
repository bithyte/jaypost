import { DEFAULT_MUTE_MS } from './constants.ts'
import { formatQuietHours, parseMuteDuration, parseQuietHours } from './parser.ts'
import { findQuietEnd, formatClock, isInQuietHours } from './schedule.ts'
import type { QuietHours, QuietPatch, QuietServiceOptions } from './types.ts'

const MUTE_USAGE = 'Use /mute 30m, /mute 2h or /mute 1d (up to 7d).'
const QUIET_USAGE = 'Use /quiet 23:00-08:00 or /quiet off.'
const SAVE_WARNING = "Couldn't save this; it resets on restart."

/**
 * Owns the quiet window and mute, answers the owner's `/mute`, `/unmute` and `/quiet`, and
 * persists changes through `save`. A failed save keeps the change in memory. Never throws.
 */
export class QuietService {
  readonly #save: (patch: QuietPatch) => void
  readonly #timeZone: string
  readonly #now: () => Date
  readonly #log: (line: string) => void
  #quietHours: QuietHours | undefined
  #mutedUntil: Date | undefined

  constructor(save: (patch: QuietPatch) => void, options: QuietServiceOptions = {}) {
    this.#save = save
    this.#quietHours = options.quietHours
    this.#mutedUntil = options.mutedUntil
    this.#now = options.now ?? (() => new Date())
    this.#log = options.log ?? console.error
    this.#timeZone = this.#resolveTimeZone(options.timeZone)
  }

  #resolveTimeZone(configured: string | undefined): string {
    // Node reports a bad TZ as 'Etc/Unknown' or undefined, and Intl throws on the former.
    const zone: unknown = configured ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof zone === 'string') {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone })
        return zone
      } catch {
        // falls through to the UTC fallback below
      }
    }
    this.#log(`invalid time zone ${JSON.stringify(zone)}, using UTC`)
    return 'UTC'
  }

  /** True while the window or a mute is in effect. */
  isQuiet(): boolean {
    return this.quietUntil() !== undefined
  }

  /** When the current quiet stretch ends; undefined when not quiet. */
  quietUntil(): Date | undefined {
    return findQuietEnd(this.#state(), this.#now(), this.#timeZone)
  }

  /** Replies to `mute`, `unmute` and `quiet`; undefined for any other command. */
  handleCommand(name: string, argument: string): string | undefined {
    const now = this.#now()
    const text = argument.trim()
    switch (name) {
      case 'mute':
        return this.#mute(text, now)
      case 'unmute':
        return this.#unmute(now)
      case 'quiet':
        return this.#quiet(text, now)
      default:
        return undefined
    }
  }

  #mute(text: string, now: Date): string {
    const parsed =
      text === '' ? { ok: true as const, value: DEFAULT_MUTE_MS } : parseMuteDuration(text)
    if (!parsed.ok) {
      return MUTE_USAGE
    }
    const until = new Date(now.getTime() + parsed.value)
    this.#mutedUntil = until
    const saved = this.#persist({ mutedUntil: until.toISOString() })
    const clock = formatClock(until, now, this.#timeZone)
    return this.#reply(
      [`Muted until ${clock} (${this.#timeZone}). Approvals still ping. /unmute to undo.`],
      saved,
    )
  }

  #unmute(now: Date): string {
    this.#mutedUntil = undefined
    const saved = this.#persist({ mutedUntil: null })
    const lines = ['Unmuted.']
    if (this.#quietHours !== undefined && isInQuietHours(this.#quietHours, now, this.#timeZone)) {
      lines.push(`Quiet hours ${formatQuietHours(this.#quietHours)} are on right now.`)
    }
    return this.#reply(lines, saved)
  }

  #quiet(text: string, now: Date): string {
    if (text === '') {
      return this.#describe(now)
    }
    if (text.toLowerCase() === 'off') {
      this.#quietHours = undefined
      return this.#reply(['Quiet hours off.'], this.#persist({ quietHours: null }))
    }
    const parsed = parseQuietHours(text)
    if (!parsed.ok) {
      return QUIET_USAGE
    }
    this.#quietHours = parsed.value
    const formatted = formatQuietHours(parsed.value)
    const saved = this.#persist({ quietHours: formatted })
    const lines = [`Quiet hours set to ${formatted} (${this.#timeZone}).`]
    if (isInQuietHours(parsed.value, now, this.#timeZone)) {
      lines.push('Quiet now.')
    }
    return this.#reply(lines, saved)
  }

  #describe(now: Date): string {
    const muted = this.#mutedUntil !== undefined && this.#mutedUntil.getTime() > now.getTime()
    const silent = findQuietEnd(this.#state(), now, this.#timeZone) !== undefined
    const windowText = this.#quietHours === undefined ? 'off' : formatQuietHours(this.#quietHours)
    return [
      `Quiet hours: ${windowText}`,
      `Time zone: ${this.#timeZone}`,
      this.#mutedUntil !== undefined && muted
        ? `Muted until ${formatClock(this.#mutedUntil, now, this.#timeZone)}.`
        : 'Not muted.',
      silent ? 'Notifications are silent right now.' : 'Notifications ping right now.',
    ].join('\n')
  }

  #state(): { readonly quietHours?: QuietHours; readonly mutedUntil?: Date } {
    return {
      ...(this.#quietHours === undefined ? {} : { quietHours: this.#quietHours }),
      ...(this.#mutedUntil === undefined ? {} : { mutedUntil: this.#mutedUntil }),
    }
  }

  #persist(patch: QuietPatch): boolean {
    try {
      this.#save(patch)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#log(`couldn't save quiet settings: ${message}`)
      return false
    }
  }

  #reply(lines: readonly string[], saved: boolean): string {
    return (saved ? lines : [...lines, SAVE_WARNING]).join('\n')
  }
}
