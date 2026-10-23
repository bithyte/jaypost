import {
  BLOCKQUOTE_PATTERN,
  FENCE_CLOSE_PATTERN,
  FENCE_OPEN_PATTERN,
  HEADING_CLOSING_PATTERN,
  HEADING_PATTERN,
  LANGUAGE_PATTERN,
} from './constants.ts'
import { parseInline } from './inline.ts'
import type { FormattedText, Span } from './types.ts'

/**
 * Renders the markdown subset into the text the owner sees plus formatting spans. Anything that
 * isn't a recognized construct is kept as typed. Never throws.
 */
export function parseMarkdown(source: string): FormattedText {
  const lines = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  let text = ''
  let hasLine = false
  const spans: Span[] = []
  const append = (piece: FormattedText, wrapper?: Span['kind']): void => {
    if (hasLine) {
      text += '\n'
    }
    hasLine = true
    if (wrapper !== undefined && piece.text.length > 0) {
      spans.push({ kind: wrapper, offset: text.length, length: piece.text.length } as Span)
    }
    spans.push(...piece.spans.map((span) => ({ ...span, offset: span.offset + text.length })))
    text += piece.text
  }
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const fence = FENCE_OPEN_PATTERN.exec(line)
    const info = fence?.[2]?.trim() ?? ''
    if (fence?.[1] !== undefined && !(fence[1].startsWith('`') && info.includes('`'))) {
      const marker = fence[1]
      const contentLines: string[] = []
      index += 1
      while (index < lines.length && !isFenceClose(lines[index] ?? '', marker)) {
        contentLines.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      if (contentLines.length > 0) {
        const content = contentLines.join('\n')
        const language = info.split(/\s+/)[0] ?? ''
        const block: Span = LANGUAGE_PATTERN.test(language)
          ? { kind: 'pre', offset: 0, length: content.length, language }
          : { kind: 'pre', offset: 0, length: content.length }
        append({ text: content, spans: content.length > 0 ? [block] : [] })
      }
      continue
    }
    const heading = HEADING_PATTERN.exec(line)
    if (heading?.[1] !== undefined) {
      append(parseInline(heading[1].replace(HEADING_CLOSING_PATTERN, '').trimEnd()), 'bold')
      index += 1
      continue
    }
    if (BLOCKQUOTE_PATTERN.test(line)) {
      const quoted: string[] = []
      while (index < lines.length) {
        const quote = BLOCKQUOTE_PATTERN.exec(lines[index] ?? '')
        if (quote?.[1] === undefined) {
          break
        }
        quoted.push(quote[1])
        index += 1
      }
      append(joinInline(quoted), 'blockquote')
      continue
    }
    append(parseInline(line))
    index += 1
  }
  return trimEdges({ text, spans })
}

function isFenceClose(line: string, opener: string): boolean {
  const marker = FENCE_CLOSE_PATTERN.exec(line)?.[1]
  return (
    marker !== undefined && marker.startsWith(opener.charAt(0)) && marker.length >= opener.length
  )
}

function joinInline(lines: readonly string[]): FormattedText {
  let text = ''
  const spans: Span[] = []
  for (const [lineIndex, line] of lines.entries()) {
    const rendered = parseInline(line)
    if (lineIndex > 0) {
      text += '\n'
    }
    spans.push(...rendered.spans.map((span) => ({ ...span, offset: span.offset + text.length })))
    text += rendered.text
  }
  return { text, spans }
}

function trimEdges(formatted: FormattedText): FormattedText {
  const { text, spans } = formatted
  const firstOffset = spans[0]?.offset ?? text.length
  const lastEnd = spans.reduce((end, span) => Math.max(end, span.offset + span.length), 0)
  const leading = Math.min(text.length - text.trimStart().length, firstOffset)
  const trailing = Math.max(text.trimEnd().length, lastEnd)
  return {
    text: text.slice(leading, Math.max(trailing, leading)),
    spans: spans.map((span) => ({ ...span, offset: span.offset - leading })),
  }
}
