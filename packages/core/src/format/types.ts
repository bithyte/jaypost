/** How the caller's text is read: shown as is, or as the markdown subset. */
export type MessageFormat = 'plain' | 'markdown'

/**
 * One formatted range of `FormattedText.text`. Offsets and lengths are UTF-16 code units, the same
 * as JS string indices and Telegram entity offsets.
 */
export type Span =
  | {
      readonly kind: 'bold' | 'italic' | 'strikethrough' | 'code' | 'blockquote'
      readonly offset: number
      readonly length: number
    }
  | {
      readonly kind: 'pre'
      readonly offset: number
      readonly length: number
      readonly language?: string
    }

/**
 * Text as the owner sees it plus its formatting; plain text has no spans. Spans are sorted by
 * offset (outer before inner at the same offset), have length > 0, lie inside `text`, never
 * partially overlap, and nothing is inside `code` or `pre`.
 */
export type FormattedText = { readonly text: string; readonly spans: readonly Span[] }

type CodeToken = { readonly kind: 'code'; readonly content: string }

type LiteralToken = {
  readonly kind: 'literal'
  readonly character: string
  readonly escaped: boolean
}

export type InlineToken = CodeToken | LiteralToken
