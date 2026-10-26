/**
 * Outcome of one pairing attempt; `blocked` after too many wrong guesses, `notPairing` once paired.
 */
export type PairResult = 'paired' | 'wrong' | 'blocked' | 'notPairing'

/** Outcome of redeeming a code; `pairingId` names the pending pairing the code belonged to. */
export type PairingClaim =
  | { readonly kind: 'paired'; readonly pairingId: string }
  | { readonly kind: 'wrong' }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'notPairing' }
