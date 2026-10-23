import {
  CLOSER_SUFFIX_CHARACTERS,
  ESCAPABLE_CHARACTERS,
  MAX_EMPHASIS_DEPTH,
  OPENER_PREFIX_CHARACTERS,
  QUOTE_CHARACTERS,
} from './constants.ts'
import type { FormattedText, InlineToken, Span } from './types.ts'

const WHITESPACE_PATTERN = /\s/

type Emphasis = { readonly kind: 'bold' | 'italic' | 'strikethrough'; readonly marker: string }

const EMPHASES: readonly Emphasis[] = [
  { kind: 'bold', marker: '**' },
  { kind: 'strikethrough', marker: '~~' },
  { kind: 'italic', marker: '*' },
]

/**
 * Renders one line of the markdown subset into text and spans (offsets relative to the line).
 * Anything that isn't a recognized construct is copied through. Never throws.
 */
export function parseInline(line: string): FormattedText {
  return renderSegment(tokenize(line), 0)
}

function tokenize(line: string): readonly InlineToken[] {
  const tokens: InlineToken[] = []
  let index = 0
  while (index < line.length) {
    const character = line.charAt(index)
    const next = line.charAt(index + 1)
    if (character === '\\' && next !== '' && ESCAPABLE_CHARACTERS.includes(next)) {
      tokens.push({ kind: 'literal', character: next, escaped: true })
      index += 2
      continue
    }
    if (character !== '`') {
      tokens.push({ kind: 'literal', character, escaped: false })
      index += 1
      continue
    }
    const openLength = countRun(line, index)
    const closeStart = findCodeClose(line, index + openLength, openLength)
    if (closeStart === -1) {
      for (let count = 0; count < openLength; count += 1) {
        tokens.push({ kind: 'literal', character: '`', escaped: false })
      }
      index += openLength
      continue
    }
    tokens.push({
      kind: 'code',
      content: stripCodePadding(line.slice(index + openLength, closeStart)),
    })
    index = closeStart + openLength
  }
  return tokens
}

function countRun(line: string, start: number): number {
  let end = start
  while (line.charAt(end) === '`') {
    end += 1
  }
  return end - start
}

function findCodeClose(line: string, from: number, openLength: number): number {
  let index = from
  while (index < line.length) {
    if (line.charAt(index) !== '`') {
      index += 1
      continue
    }
    const length = countRun(line, index)
    if (length === openLength) {
      return index
    }
    index += length
  }
  return -1
}

function stripCodePadding(content: string): string {
  if (content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') {
    return content.slice(1, -1)
  }
  return content
}

function renderSegment(tokens: readonly InlineToken[], depth: number): FormattedText {
  const closers = new Map<string, readonly number[]>()
  let text = ''
  const spans: Span[] = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === undefined) {
      break
    }
    if (token.kind === 'code') {
      if (token.content !== '') {
        spans.push({ kind: 'code', offset: text.length, length: token.content.length })
      }
      text += token.content
      index += 1
      continue
    }
    const match = depth < MAX_EMPHASIS_DEPTH ? findEmphasis(tokens, index, closers) : undefined
    if (match === undefined) {
      text += token.character
      index += 1
      continue
    }
    const inner = renderSegment(
      tokens.slice(index + match.marker.length, match.closeIndex),
      depth + 1,
    )
    if (inner.text.length > 0) {
      spans.push({ kind: match.kind, offset: text.length, length: inner.text.length })
    }
    spans.push(...inner.spans.map((span) => ({ ...span, offset: span.offset + text.length })))
    text += inner.text
    index = match.closeIndex + match.marker.length
  }
  return { text, spans }
}

type EmphasisMatch = Emphasis & { readonly closeIndex: number }

function findEmphasis(
  tokens: readonly InlineToken[],
  start: number,
  closers: Map<string, readonly number[]>,
): EmphasisMatch | undefined {
  for (const emphasis of EMPHASES) {
    if (!isMarkerAt(tokens, start, emphasis.marker) || !canOpen(tokens, start, emphasis.marker)) {
      continue
    }
    const closeIndex = findClose(tokens, start, emphasis.marker, closers)
    if (closeIndex === -1) {
      continue
    }
    // empty content such as "****" is literal, and "**" has decided this position
    if (closeIndex === start + emphasis.marker.length) {
      return undefined
    }
    return { ...emphasis, closeIndex }
  }
  return undefined
}

function isMarkerAt(tokens: readonly InlineToken[], start: number, marker: string): boolean {
  for (let offset = 0; offset < marker.length; offset += 1) {
    const token = tokens[start + offset]
    if (token?.kind !== 'literal' || token.escaped || token.character !== marker.charAt(offset)) {
      return false
    }
  }
  return true
}

function isWhitespace(token: InlineToken | undefined): boolean {
  return token?.kind === 'literal' && WHITESPACE_PATTERN.test(token.character)
}

function isCharacterIn(token: InlineToken | undefined, characters: string): boolean {
  return token?.kind === 'literal' && characters.includes(token.character)
}

function isMarkerCharacter(token: InlineToken | undefined, marker: string): boolean {
  return token?.kind === 'literal' && !token.escaped && token.character === marker.charAt(0)
}

function canOpen(tokens: readonly InlineToken[], start: number, marker: string): boolean {
  const following = tokens[start + marker.length]
  if (following === undefined || isWhitespace(following) || isMarkerCharacter(following, marker)) {
    return false
  }
  if (
    isCharacterIn(tokens[start - 1], QUOTE_CHARACTERS) &&
    isCharacterIn(following, CLOSER_SUFFIX_CHARACTERS)
  ) {
    return false
  }
  let before = start - 1
  while (before >= 0 && isCharacterIn(tokens[before], OPENER_PREFIX_CHARACTERS)) {
    before -= 1
  }
  return before < 0 || isWhitespace(tokens[before])
}

function canClose(tokens: readonly InlineToken[], start: number, marker: string): boolean {
  const preceding = tokens[start - 1]
  if (preceding === undefined || isWhitespace(preceding) || isMarkerCharacter(preceding, marker)) {
    return false
  }
  if (
    isCharacterIn(preceding, OPENER_PREFIX_CHARACTERS) &&
    isCharacterIn(tokens[start + marker.length], QUOTE_CHARACTERS)
  ) {
    return false
  }
  let after = start + marker.length
  while (after < tokens.length && isCharacterIn(tokens[after], CLOSER_SUFFIX_CHARACTERS)) {
    after += 1
  }
  return after >= tokens.length || isWhitespace(tokens[after])
}

// Whether a position can close doesn't depend on the opener, so the valid ones are found once per
// segment and marker, and each opener binary-searches them.
function findClose(
  tokens: readonly InlineToken[],
  start: number,
  marker: string,
  closers: Map<string, readonly number[]>,
): number {
  let valid = closers.get(marker)
  if (valid === undefined) {
    valid = tokens.flatMap((_token, index) =>
      isMarkerAt(tokens, index, marker) && canClose(tokens, index, marker) ? [index] : [],
    )
    closers.set(marker, valid)
  }
  const from = start + marker.length
  let low = 0
  let high = valid.length
  while (low < high) {
    const middle = (low + high) >> 1
    if ((valid[middle] ?? 0) < from) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return valid[low] ?? -1
}
