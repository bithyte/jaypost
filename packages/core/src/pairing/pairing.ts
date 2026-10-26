import { randomInt } from 'node:crypto'
import {
  CODE_SEPARATOR_PATTERN,
  DEFAULT_MAX_FAILURES,
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
} from './constants.ts'
import type { PairResult } from './types.ts'

/** Random pairing code from `PAIRING_ALPHABET`; `random` is injectable for tests. */
export function generateCode(random: (max: number) => number = randomInt): string {
  let code = ''
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    code += PAIRING_ALPHABET[random(PAIRING_ALPHABET.length)]
  }
  return code
}

/** Splits a code into two groups of four with a dash, for display. */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/** Uppercases and strips dashes and whitespace so typed codes compare equal. */
export function normalizeCode(text: string): string {
  return text.trim().toUpperCase().replace(CODE_SEPARATOR_PATTERN, '')
}

/**
 * One-shot pairing state: the first correct code claims the bot, and each sender gets a limited
 * number of wrong guesses.
 */
export class Pairing {
  #code: string | undefined
  #maxFailures: number
  #failures = new Map<string, number>()

  constructor(code: string, maxFailures = DEFAULT_MAX_FAILURES) {
    this.#code = code.toUpperCase()
    this.#maxFailures = maxFailures
  }

  /** The code to show, or undefined once paired. */
  get code(): string | undefined {
    return this.#code
  }

  get paired(): boolean {
    return this.#code === undefined
  }

  /**
   * Compares `text` (case and dashes ignored) to the code. Wrong guesses are
   * counted per sender and block at the limit.
   */
  attempt(senderId: string, text: string): PairResult {
    if (this.#code === undefined) {
      return 'notPairing'
    }
    const failures = this.#failures.get(senderId) ?? 0
    if (failures >= this.#maxFailures) {
      return 'blocked'
    }
    if (normalizeCode(text) === this.#code) {
      this.#code = undefined
      return 'paired'
    }
    this.#failures.set(senderId, failures + 1)
    return 'wrong'
  }
}
