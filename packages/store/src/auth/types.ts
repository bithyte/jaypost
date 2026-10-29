/** Service-side auth: no token means the API is open, as before. */
export type ApiAuth = { readonly kind: 'none' } | { readonly kind: 'token'; readonly token: string }

/** What a client found: a usable token and where it came from, nothing, or a bad source. */
export type ClientToken =
  | { readonly kind: 'none' }
  | { readonly kind: 'token'; readonly token: string; readonly source: 'env' | 'file' | 'book' }
  | { readonly kind: 'unusable'; readonly message: string }

/** How a client secret's messages name its env var, its file and the value. */
export type ClientSecretNames = {
  readonly envVar: string
  readonly fileName: string
  readonly valueName: string
}
