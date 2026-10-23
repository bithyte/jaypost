import { expect, test } from 'vite-plus/test'
import { parseMarkdown } from '../../src/format/index.ts'
import type { FormattedText, Span } from '../../src/format/index.ts'

function expectValidSpans(result: FormattedText): void {
  const { text, spans } = result
  for (const [index, span] of spans.entries()) {
    expect(span.length).toBeGreaterThan(0)
    expect(span.offset).toBeGreaterThanOrEqual(0)
    expect(span.offset + span.length).toBeLessThanOrEqual(text.length)
    const previous = spans[index - 1]
    if (previous === undefined) {
      continue
    }
    expect(
      previous.offset < span.offset ||
        (previous.offset === span.offset && previous.length >= span.length),
    ).toBe(true)
  }
  for (const [leftIndex, left] of spans.entries()) {
    for (const right of spans.slice(leftIndex + 1)) {
      const disjoint = left.offset + left.length <= right.offset
      const nested = right.offset + right.length <= left.offset + left.length
      expect(disjoint || nested).toBe(true)
      if (nested && !disjoint) {
        expect(left.kind === 'code' || left.kind === 'pre').toBe(false)
      }
    }
  }
}

function check(source: string): FormattedText {
  const result = parseMarkdown(source)
  expectValidSpans(result)
  return result
}

function span(kind: Span['kind'], offset: number, length: number): Span {
  return { kind, offset, length } as Span
}

const UNCHANGED = (source: string): FormattedText => ({ text: source, spans: [] })

test('inline code', () => {
  expect(check('Run `rm -rf build`?')).toEqual({
    text: 'Run rm -rf build?',
    spans: [span('code', 4, 12)],
  })
})

test('bold and italic', () => {
  expect(check('**Deploy** to *prod*')).toEqual({
    text: 'Deploy to prod',
    spans: [span('bold', 0, 6), span('italic', 10, 4)],
  })
})

test('strikethrough', () => {
  expect(check('~~old~~ new')).toEqual({ text: 'old new', spans: [span('strikethrough', 0, 3)] })
})

test.each([
  'snake_case_name and 2*3*4',
  '__init__.py and _private_',
  '**/*.ts and *.js',
  'rm -rf /tmp/* and src/**/*.ts',
  'a_b_c',
  'x * y * z',
  '*args and **kwargs',
  '_x_ and __x__',
  '****',
  '* item\n* item',
])('anti-goal string stays literal: %j', (source) => {
  expect(check(source)).toEqual(UNCHANGED(source))
})

test('backslash escape', () => {
  expect(check('\\*not italic\\*')).toEqual(UNCHANGED('*not italic*'))
})

test('backslash before non-punctuation stays', () => {
  expect(check('C:\\dir a\\b')).toEqual(UNCHANGED('C:\\dir a\\b'))
})

test('code with inner backtick', () => {
  expect(check('`` a ` b ``')).toEqual({ text: 'a ` b', spans: [span('code', 0, 5)] })
})

test('code is verbatim', () => {
  expect(check('`**x** a\\*b`')).toEqual({ text: '**x** a\\*b', spans: [span('code', 0, 10)] })
})

test('unmatched backticks are literal', () => {
  expect(check('a `b')).toEqual(UNCHANGED('a `b'))
})

test('code inside bold', () => {
  expect(check('**run `ls` now**')).toEqual({
    text: 'run ls now',
    spans: [span('bold', 0, 10), span('code', 4, 2)],
  })
})

test('offsets count utf-16 code units', () => {
  expect(check('😀 `x`')).toEqual({ text: '😀 x', spans: [span('code', 3, 1)] })
})

test('markers at word edges with punctuation', () => {
  expect(check('**Deploy**.')).toEqual({ text: 'Deploy.', spans: [span('bold', 0, 6)] })
  expect(check('(*note*)')).toEqual({ text: '(note)', spans: [span('italic', 1, 4)] })
  expect(check('"**yes**"')).toEqual({ text: '"yes"', spans: [span('bold', 1, 3)] })
})

test('emphasis does not cross lines', () => {
  expect(check('**a\nb**')).toEqual(UNCHANGED('**a\nb**'))
})

test('lines and blank lines are kept', () => {
  expect(check('a\n\n  b')).toEqual(UNCHANGED('a\n\n  b'))
})

test('edges are trimmed', () => {
  expect(check('  hi  \n')).toEqual(UNCHANGED('hi'))
})

test('code at the edge keeps its spaces', () => {
  expect(check('`  x  `')).toEqual({ text: ' x ', spans: [span('code', 0, 3)] })
})

function pre(offset: number, length: number, language?: string): Span {
  return language === undefined
    ? { kind: 'pre', offset, length }
    : { kind: 'pre', offset, length, language }
}

test('fenced diff', () => {
  expect(check('```diff\n-a\n+b\n```')).toEqual({ text: '-a\n+b', spans: [pre(0, 5, 'diff')] })
})

test('unclosed fence runs to the end', () => {
  expect(check('```\nunclosed')).toEqual({ text: 'unclosed', spans: [pre(0, 8)] })
})

test('empty fence is blank', () => {
  expect(check('```\n```')).toEqual({ text: '', spans: [] })
})

test('tilde fence', () => {
  expect(check('~~~sh\nls\n~~~')).toEqual({ text: 'ls', spans: [pre(0, 2, 'sh')] })
})

test('longer fence holds a shorter one', () => {
  expect(check('````md\n```\nx\n```\n````')).toEqual({
    text: '```\nx\n```',
    spans: [pre(0, 9, 'md')],
  })
})

test.each([1, 2, 3])('fence indented by %i spaces', (count) => {
  const indent = ' '.repeat(count)
  expect(check(`${indent}\`\`\`\nx\n${indent}\`\`\``)).toEqual({ text: 'x', spans: [pre(0, 1)] })
})

test('four spaces is not a fence', () => {
  expect(check('    ```\nx')).toEqual(UNCHANGED('```\nx'))
})

test('invalid language is dropped', () => {
  expect(check('```c<>\nx\n```')).toEqual({ text: 'x', spans: [pre(0, 1)] })
})

test('fence content is verbatim', () => {
  expect(check('```\n  **x** `y` \\*\n```')).toEqual({
    text: '  **x** `y` \\*',
    spans: [pre(0, 14)],
  })
})

test('backtick in info string is not a fence', () => {
  expect(check('```foo```')).toEqual({ text: 'foo', spans: [span('code', 0, 3)] })
})

test('fence mid-text', () => {
  expect(check('Apply?\n```diff\n-a\n```\nok')).toEqual({
    text: 'Apply?\n-a\nok',
    spans: [pre(7, 2, 'diff')],
  })
})

test('heading', () => {
  expect(check('## Plan\nship it')).toEqual({ text: 'Plan\nship it', spans: [span('bold', 0, 4)] })
})

test('heading with closing hashes', () => {
  expect(check('# Title ##')).toEqual({ text: 'Title', spans: [span('bold', 0, 5)] })
})

test('heading with inline code', () => {
  expect(check('# Run `ls`')).toEqual({
    text: 'Run ls',
    spans: [span('bold', 0, 6), span('code', 4, 2)],
  })
})

test.each(['#123 is fixed', '#tag', '####### seven'])('not a heading: %j', (source) => {
  expect(check(source)).toEqual(UNCHANGED(source))
})

test('blockquote', () => {
  expect(check('> quoted\n> more')).toEqual({
    text: 'quoted\nmore',
    spans: [span('blockquote', 0, 11)],
  })
})

test('blockquote with inline code', () => {
  expect(check('> run `ls`')).toEqual({
    text: 'run ls',
    spans: [span('blockquote', 0, 6), span('code', 4, 2)],
  })
})

test('fences are not recognized in quotes', () => {
  expect(check('> ```')).toEqual({ text: '```', spans: [span('blockquote', 0, 3)] })
})

test('CRLF and lone CR', () => {
  expect(check('**a**\r\nb\rc')).toEqual({ text: 'a\nb\nc', spans: [span('bold', 0, 1)] })
})

test('windows-edited diff closes its fence and keeps lines verbatim', () => {
  expect(check('```diff\r\n-a\r\n+b \r\n```  \r\nok')).toEqual({
    text: '-a\n+b \nok',
    spans: [pre(0, 6, 'diff')],
  })
})

test('indented first code line keeps its indent', () => {
  expect(check('```\n  indented\n```')).toEqual({ text: '  indented', spans: [pre(0, 10)] })
})

test('deeply nested markers do not throw', () => {
  const source = `${'*'.repeat(11906)}a${'*'.repeat(11906)}`
  const result = check(source)
  expect(result.text).toContain('a')
})

test.each(['**a '.repeat(16250), '*a '.repeat(21666), '~~a '.repeat(16250)])(
  'a long run of unmatched openers is fast',
  (source) => {
    const started = performance.now()
    check(source)
    expect(performance.now() - started).toBeLessThan(1000)
  },
)

test.each([
  "git add '*.ts' '*'",
  "find . -name '*' -o -name '*'",
  '"*" or "*"',
  '***',
  '*****',
  '**x*',
  '***bold***',
])('markers that would eat characters stay literal: %j', (source) => {
  expect(check(source)).toEqual(UNCHANGED(source))
})

test('emphasis still works around quotes and nested runs', () => {
  expect(check('**"yes"**')).toEqual({ text: '"yes"', spans: [span('bold', 0, 5)] })
  expect(check('*a **b** c*')).toEqual({
    text: 'a b c',
    spans: [span('italic', 0, 5), span('bold', 2, 1)],
  })
})
