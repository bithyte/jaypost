import type { FormattedText, Span } from '@jaypost/core'
import { formatChoicePayload } from '@jaypost/core'
import { BUTTON_LABEL_LIMIT, ELLIPSIS, FALLBACK_TEXT_LIMIT, URL_PATTERN } from './constants.ts'
import type {
  OutgoingMessage,
  RichTextElement,
  RichTextInline,
  SlackBlock,
  SlackButton,
  TextStyle,
} from './types.ts'

/**
 * `message` as one rich text block plus, when `buttons` isn't empty, one actions block under it.
 * Rich text holds literal text, so nothing needs escaping. Never throws.
 */
export function toOutgoingMessage(
  message: FormattedText,
  buttons: readonly SlackButton[],
): OutgoingMessage {
  const blocks: SlackBlock[] = [{ type: 'rich_text', elements: toRichText(message) }]
  if (buttons.length > 0) {
    blocks.push({ type: 'actions', elements: buttons })
  }
  return { text: toFallbackText(message.text), blocks }
}

/** One button per option; each payload carries the request id and the option index. */
export function toChoiceButtons(id: string, options: readonly string[]): readonly SlackButton[] {
  return options.map((label, index) => toButton(label, formatChoicePayload(id, index)))
}

/** A button whose label is cut to Slack's 75 characters with an ellipsis. Never throws. */
export function toButton(label: string, payload: string): SlackButton {
  const characters = Array.from(label)
  const text =
    characters.length > BUTTON_LABEL_LIMIT
      ? `${characters.slice(0, BUTTON_LABEL_LIMIT - 1).join('')}${ELLIPSIS}`
      : label
  return {
    type: 'button',
    text: { type: 'plain_text', text, emoji: false },
    action_id: payload,
    value: payload,
  }
}

/**
 * Spans as rich text elements: a top-level `pre` becomes a code block, a blockquote starting a line
 * a quote, the rest styled runs in sections, with bare links made clickable outside code. One line
 * break next to a code block or quote is dropped, since Slack already separates them. Assumes
 * parser-shaped input (spans sorted and nested). Never throws.
 */
export function toRichText(message: FormattedText): readonly RichTextElement[] {
  const { text, spans } = message
  const elements: RichTextElement[] = []
  let pending: RichTextInline[] = []
  let position = 0
  let index = 0
  const flush = (): void => {
    if (pending.length > 0) {
      elements.push({ type: 'rich_text_section', elements: pending })
      pending = []
    }
  }
  while (index < spans.length) {
    const span = spans[index]
    if (span === undefined) {
      break
    }
    const end = span.offset + span.length
    const children: Span[] = []
    index += 1
    while (index < spans.length) {
      const next = spans[index]
      if (next === undefined || next.offset >= end) {
        break
      }
      children.push(next)
      index += 1
    }
    const isLineStart = span.offset === 0 || text[span.offset - 1] === '\n'
    if (span.kind !== 'pre' && !(span.kind === 'blockquote' && isLineStart)) {
      pending.push(...toInline(text, position, span.offset, [], {}))
      pending.push(...toInline(text, span.offset, end, [span, ...children], {}))
      position = end
      continue
    }
    const before = text[span.offset - 1] === '\n' ? span.offset - 1 : span.offset
    pending.push(...toInline(text, position, Math.max(position, before), [], {}))
    flush()
    elements.push(toBlockElement(text, span, children))
    position = text[end] === '\n' ? end + 1 : end
  }
  pending.push(...toInline(text, position, text.length, [], {}))
  flush()
  return elements.length > 0
    ? elements
    : [{ type: 'rich_text_section', elements: [{ type: 'text', text: ' ' }] }]
}

/** `text` with Slack's three mrkdwn control characters escaped, cut to the fallback limit. */
export function toFallbackText(text: string): string {
  return text
    .slice(0, FALLBACK_TEXT_LIMIT)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function toBlockElement(text: string, span: Span, children: readonly Span[]): RichTextElement {
  const end = span.offset + span.length
  if (span.kind === 'pre') {
    return {
      type: 'rich_text_preformatted',
      elements: [{ type: 'text', text: text.slice(span.offset, end) }],
      ...(span.language === undefined ? {} : { language: span.language }),
    }
  }
  return { type: 'rich_text_quote', elements: toInline(text, span.offset, end, children, {}) }
}

function toInline(
  text: string,
  start: number,
  end: number,
  spans: readonly Span[],
  style: TextStyle,
): readonly RichTextInline[] {
  const output: RichTextInline[] = []
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
    output.push(...toRuns(text.slice(position, span.offset), style))
    output.push(...toInline(text, span.offset, spanEnd, children, withSpan(style, span)))
    position = spanEnd
  }
  output.push(...toRuns(text.slice(position, end), style))
  return output
}

function withSpan(style: TextStyle, span: Span): TextStyle {
  switch (span.kind) {
    case 'bold':
      return { ...style, bold: true }
    case 'italic':
      return { ...style, italic: true }
    case 'strikethrough':
      return { ...style, strike: true }
    case 'code':
    case 'pre':
      return { ...style, code: true }
    case 'blockquote':
      return style
  }
}

function toRuns(content: string, style: TextStyle): readonly RichTextInline[] {
  if (content === '') {
    return []
  }
  const styled = Object.keys(style).length > 0 ? { style } : {}
  if (style.code === true) {
    return [{ type: 'text', text: content, ...styled }]
  }
  const runs: RichTextInline[] = []
  let position = 0
  for (const link of content.matchAll(URL_PATTERN)) {
    if (link.index > position) {
      runs.push({ type: 'text', text: content.slice(position, link.index), ...styled })
    }
    runs.push({ type: 'link', url: link[0], ...styled })
    position = link.index + link[0].length
  }
  if (position < content.length) {
    runs.push({ type: 'text', text: content.slice(position), ...styled })
  }
  return runs
}
