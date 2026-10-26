import { DEFAULT_MAX_FAILURES, PAIRING_ALPHABET, PAIRING_CODE_LENGTH } from './constants.ts'
import { normalizeCode } from './pairing.ts'
import type { PairingClaim } from './types.ts'

/** True when `text` normalizes to PAIRING_CODE_LENGTH characters of PAIRING_ALPHABET. */
export function isCodeShaped(text: string): boolean {
  const normalized = normalizeCode(text)
  return (
    normalized.length === PAIRING_CODE_LENGTH &&
    [...normalized].every((character) => PAIRING_ALPHABET.includes(character))
  )
}

/**
 * The outstanding pairing codes of one bot, one per pending pairing. A correct code claims its
 * pairing and is spent; wrong guesses are counted per sender across all codes. Never throws.
 */
export class PairingCodes {
  #codes = new Map<string, string>()
  #maxFailures: number
  #failures = new Map<string, number>()

  constructor(maxFailures = DEFAULT_MAX_FAILURES) {
    this.#maxFailures = maxFailures
  }

  /** True when no pairing has a code outstanding. */
  get isEmpty(): boolean {
    return this.#codes.size === 0
  }

  /** Sets the code for `pairingId`, replacing its previous one. */
  add(pairingId: string, code: string): void {
    this.#codes.set(pairingId, code.toUpperCase())
  }

  /** Drops the code of `pairingId`, if any. */
  remove(pairingId: string): void {
    this.#codes.delete(pairingId)
  }

  /** The raw uppercase code (no dash) of `pairingId`, or undefined. */
  codeFor(pairingId: string): string | undefined {
    return this.#codes.get(pairingId)
  }

  /**
   * Compares `text` (case and dashes ignored) to every outstanding code. Success spends the code.
   * Wrong guesses are counted per sender and block at the limit; with no codes nothing is counted.
   */
  attempt(senderId: string, text: string): PairingClaim {
    if (this.#codes.size === 0) {
      return { kind: 'notPairing' }
    }
    const failures = this.#failures.get(senderId) ?? 0
    if (failures >= this.#maxFailures) {
      return { kind: 'blocked' }
    }
    const normalized = normalizeCode(text)
    for (const [pairingId, code] of this.#codes) {
      if (code === normalized) {
        this.#codes.delete(pairingId)
        return { kind: 'paired', pairingId }
      }
    }
    this.#failures.set(senderId, failures + 1)
    return { kind: 'wrong' }
  }
}
