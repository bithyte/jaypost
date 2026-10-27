import { DEFAULT_MAX_FAILURES, PAIRING_ALPHABET, PAIRING_CODE_LENGTH } from './constants.ts'
import { normalizeCode } from './pairing.ts'

/** True when `text` normalizes to PAIRING_CODE_LENGTH characters of PAIRING_ALPHABET. */
export function isCodeShaped(text: string): boolean {
  const normalized = normalizeCode(text)
  return (
    normalized.length === PAIRING_CODE_LENGTH &&
    [...normalized].every((character) => PAIRING_ALPHABET.includes(character))
  )
}

/**
 * Wrong pairing codes counted per sender, across all of a bot's codes; a sender at the limit is
 * blocked. Kept in memory only, so a restart starts every count over. Never throws.
 */
export class GuessLimit {
  #maxFailures: number
  #failures = new Map<string, number>()

  constructor(maxFailures = DEFAULT_MAX_FAILURES) {
    this.#maxFailures = maxFailures
  }

  /** True once `senderId` has sent the maximum number of wrong codes. */
  isBlocked(senderId: string): boolean {
    return (this.#failures.get(senderId) ?? 0) >= this.#maxFailures
  }

  /** Counts one wrong code from `senderId`. */
  countWrong(senderId: string): void {
    this.#failures.set(senderId, (this.#failures.get(senderId) ?? 0) + 1)
  }
}
