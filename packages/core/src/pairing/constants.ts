/** Uppercase letters and digits without look-alikes (I, L, O, 0, 1). */
export const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
/** Characters in a pairing code (shown as two groups of four). */
export const PAIRING_CODE_LENGTH = 8
/** Wrong guesses allowed per sender before they are blocked. */
export const DEFAULT_MAX_FAILURES = 5
/** Dashes and whitespace ignored when comparing a typed code. */
export const CODE_SEPARATOR_PATTERN = /[-\s]/g
