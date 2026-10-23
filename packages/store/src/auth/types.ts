/** Service-side auth: no token means the API is open, as before. */
export type ApiAuth = { readonly kind: 'none' } | { readonly kind: 'token'; readonly token: string }

/** What a client found: a usable token and where it came from, nothing, or a bad source. */
export type ClientToken =
  | { readonly kind: 'none' }
  | { readonly kind: 'token'; readonly token: string; readonly source: 'env' | 'file' }
  | { readonly kind: 'unusable'; readonly message: string }
