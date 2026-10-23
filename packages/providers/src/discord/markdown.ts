import type { FormattedText, Span } from '@jaypost/core'
import {
  DOUBLE_BACKTICK_PATTERN,
  MARKUP_CHARACTERS,
  NUMBER_PREFIX_PATTERN,
  SPACES_PATTERN,
  URL_PATTERN,
  WHITESPACE_PATTERN,
  ZERO_WIDTH_SPACE,
} from './constants.ts'
import type { RenderedContent } from './types.ts'

/**
 * Escapes every markup character with a backslash, plus `-`, `+` and `1.` list markers at the
 * start of a line (after optional spaces) when followed by whitespace. Discord drops a backslash
 * before any ASCII punctuation, so the text shows unchanged. Never throws.
 */
export function escapeDiscordMarkdown(text: string): string {
  return escapeRange(text, 0, text.length)
}

/**
 * Renders spans as Discord markdown with the text between them escaped. When the result is longer
 * than `maxLength`, falls back to the escaped text without spans, then to `message.text` as is.
 * Code and pre are never escaped, a blockquote holding code is dropped, and a blockquote not at a
 * line start keeps its text without `> `. Assumes parser-shaped input (spans sorted and nested,
 * italic not touching whitespace). Never throws.
 */
export function renderContent(message: FormattedText, maxLength: number): RenderedContent {
  const rendered = renderRange(message.text, 0, message.text.length, message.spans)
  if (rendered.length <= maxLength) {
    return { content: rendered, fallback: 'none' }
  }
  if (message.spans.length > 0) {
    const unformatted = escapeDiscordMarkdown(message.text)
    if (unformatted.length <= maxLength) {
      return { content: unformatted, fallback: 'unformatted' }
    }
  }
  return { content: message.text, fallback: 'raw' }
}

function renderRange(text: string, start: number, end: number, spans: readonly Span[]): string {
  let output = ''
  let position = start
  let index = 0
  while (index < spans.length) {
    const span = spans[index]
    if (span === undefined) {
      break
    }
    const spanEnd = span.offset + span.length
    const children: Span[] = []
    index += 1
    while (index < spans.length) {
      const next = spans[index]
      if (next === undefined || next.offset >= spanEnd) {
        break
      }
      children.push(next)
      index += 1
    }
    output += escapeRange(text, position, span.offset)
    output += renderSpan(text, span, children)
    position = spanEnd
  }
  return output + escapeRange(text, position, end)
}

function renderSpan(text: string, span: Span, children: readonly Span[]): string {
  const end = span.offset + span.length
  switch (span.kind) {
    case 'code':
      return renderCode(text.slice(span.offset, end))
    case 'pre':
      return `\`\`\`${span.language ?? ''}\n${breakBackticks(text.slice(span.offset, end))}\n\`\`\``
    case 'bold':
      return `**${renderRange(text, span.offset, end, children)}**`
    case 'italic':
      return `*${renderRange(text, span.offset, end, children)}*`
    case 'strikethrough':
      return `~~${renderRange(text, span.offset, end, children)}~~`
    case 'blockquote': {
      const inner = renderRange(text, span.offset, end, children)
      const hasCode = children.some((child) => child.kind === 'code' || child.kind === 'pre')
      if (hasCode || !(span.offset === 0 || text[span.offset - 1] === '\n')) {
        return inner
      }
      return `> ${inner.replaceAll('\n', '\n> ')}`
    }
  }
}

function renderCode(content: string): string {
  const broken = breakBackticks(content)
  return content.includes('`') ? `\`\` ${broken} \`\`` : `\`${broken}\``
}

function breakBackticks(content: string): string {
  return content.replaceAll(DOUBLE_BACKTICK_PATTERN, `\`${ZERO_WIDTH_SPACE}`)
}

function escapeRange(text: string, start: number, end: number): string {
  const links = [...text.matchAll(URL_PATTERN)]
  let output = ''
  for (let index = start; index < end; index += 1) {
    const character = text.charAt(index)
    const isInLink = links.some(
      (link) => index >= link.index && index < link.index + link[0].length,
    )
    if (isInLink) {
      output += character
      continue
    }
    output += MARKUP_CHARACTERS.includes(character) || isListMarker(text, index) ? '\\' : ''
    output += character
  }
  return output
}

function isListMarker(text: string, index: number): boolean {
  const character = text.charAt(index)
  if (character !== '-' && character !== '+' && character !== '.') {
    return false
  }
  if (!WHITESPACE_PATTERN.test(text.charAt(index + 1))) {
    return false
  }
  const lineStart = index === 0 ? 0 : text.lastIndexOf('\n', index - 1) + 1
  const before = text.slice(lineStart, index)
  return character === '.' ? NUMBER_PREFIX_PATTERN.test(before) : SPACES_PATTERN.test(before)
}
