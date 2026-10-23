import { parseMarkdown } from './parser.ts'
import type { FormattedText, MessageFormat } from './types.ts'

/**
 * Reads `text` in the given format. Plain text is returned untouched (no trim, no line ending
 * changes) with no spans. Never throws.
 */
export function toFormattedText(text: string, format: MessageFormat): FormattedText {
  switch (format) {
    case 'plain':
      return { text, spans: [] }
    case 'markdown':
      return parseMarkdown(text)
  }
}

/** Puts plain `prefix` in front of `formatted`, shifting every span past it. Never throws. */
export function prependText(prefix: string, formatted: FormattedText): FormattedText {
  return {
    text: `${prefix}${formatted.text}`,
    spans: formatted.spans.map((span) => ({ ...span, offset: span.offset + prefix.length })),
  }
}

/** Puts plain `suffix` after `formatted`; its spans stay where they are. Never throws. */
export function appendText(formatted: FormattedText, suffix: string): FormattedText {
  return { text: `${formatted.text}${suffix}`, spans: formatted.spans }
}
