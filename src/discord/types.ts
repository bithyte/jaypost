/**
 * Message content ready to send. `fallback` says how far rendering degraded to fit the limit:
 * 'none' keeps the formatting, 'unformatted' keeps the text with markup escaped, 'raw' is the
 * caller's text unchanged.
 */
export type RenderedContent = {
  readonly content: string
  readonly fallback: 'none' | 'unformatted' | 'raw'
}
