/**
 * Outcome of one pairing attempt; `blocked` after too many wrong guesses, `notPairing` once paired.
 */
export type PairResult = 'paired' | 'wrong' | 'blocked' | 'notPairing'
