import { expect, test } from 'vite-plus/test'
import { escapeMarkdown, formatCodeBlock, parseMarkdown } from '../../src/format/index.ts'

const ALPHABET = [...'ab \t\n\\`*~#>_[]()!.😀']

function createRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

test('escaped text round-trips with no spans', () => {
  const random = createRandom(1234)
  for (let run = 0; run < 2000; run += 1) {
    const length = Math.floor(random() * 41)
    let source = ''
    for (let index = 0; index < length; index += 1) {
      source += ALPHABET[Math.floor(random() * ALPHABET.length)] ?? ''
    }
    expect(parseMarkdown(escapeMarkdown(source)), JSON.stringify(source)).toEqual({
      text: source.trim(),
      spans: [],
    })
  }
})

test('escapes every marker', () => {
  expect(escapeMarkdown('\\`*~#>_')).toBe('\\\\\\`\\*\\~\\#\\>_')
})

test.each(['-a\n+b', '```\nx\n```', '  ````inner', 'a\n'])('code block round-trips: %j', (code) => {
  expect(parseMarkdown(formatCodeBlock(code, 'diff'))).toEqual({
    text: code,
    spans: [{ kind: 'pre', offset: 0, length: code.length, language: 'diff' }],
  })
})

test('fence is longer than the longest leading run', () => {
  expect(formatCodeBlock('````x').startsWith('`````\n')).toBe(true)
})

test('bad language throws', () => {
  expect(() => formatCodeBlock('x', 'a b')).toThrow(RangeError)
})
