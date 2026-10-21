import { expect, test } from 'vite-plus/test'
import type { Span } from '../../src/format/index.ts'
import { escapeDiscordMarkdown, renderContent } from '../../src/discord/index.ts'

const plain = (text: string) => ({ text, spans: [] })
const render = (text: string, spans: readonly Span[]) => renderContent({ text, spans }, 2000)

test('escapes markup characters anywhere', () => {
  expect(renderContent(plain('a*b_c~d`e|f<g[h#i>j\\k'), 2000).content).toBe(
    'a\\*b\\_c\\~d\\`e\\|f\\<g\\[h\\#i\\>j\\\\k',
  )
})

test('escapeDiscordMarkdown escapes like renderContent', () => {
  expect(escapeDiscordMarkdown('*a*')).toBe('\\*a\\*')
})

test('escapes list markers only at line starts', () => {
  expect(renderContent(plain('- a\n  + b\n12. c\nx - y 3. z'), 2000).content).toBe(
    '\\- a\n  \\+ b\n12\\. c\nx - y 3. z',
  )
})

test('does not escape markers without trailing whitespace', () => {
  expect(escapeDiscordMarkdown('-a\n+b\n1.5')).toBe('-a\n+b\n1.5')
})

test('renders bold, italic and strikethrough', () => {
  expect(
    render('bold italic struck', [
      { kind: 'bold', offset: 0, length: 4 },
      { kind: 'italic', offset: 5, length: 6 },
      { kind: 'strikethrough', offset: 12, length: 6 },
    ]),
  ).toEqual({ content: '**bold** *italic* ~~struck~~', fallback: 'none' })
})

test('renders nested spans', () => {
  expect(
    render('a b', [
      { kind: 'bold', offset: 0, length: 3 },
      { kind: 'italic', offset: 2, length: 1 },
    ]).content,
  ).toBe('**a *b***')
})

test('escapes text inside spans', () => {
  expect(render('a*b', [{ kind: 'bold', offset: 0, length: 3 }]).content).toBe('**a\\*b**')
})

test('inline code is not escaped', () => {
  expect(render('run a*b', [{ kind: 'code', offset: 4, length: 3 }]).content).toBe('run `a*b`')
})

test('inline code with a backtick is wrapped in double backticks', () => {
  expect(render('a`b', [{ kind: 'code', offset: 0, length: 3 }]).content).toBe('`` a`b ``')
})

test('inline code breaks consecutive backticks', () => {
  expect(render('a``b', [{ kind: 'code', offset: 0, length: 4 }]).content).toBe('`` a`​`b ``')
})

test('pre keeps the language and breaks triple backticks', () => {
  expect(render('x```y', [{ kind: 'pre', offset: 0, length: 5, language: 'sh' }]).content).toBe(
    '```sh\nx`​`​`y\n```',
  )
})

test('pre without a language has an empty info string', () => {
  expect(render('x', [{ kind: 'pre', offset: 0, length: 1 }]).content).toBe('```\nx\n```')
})

test('blockquote prefixes every line at a line start', () => {
  expect(render('one\ntwo', [{ kind: 'blockquote', offset: 0, length: 7 }]).content).toBe(
    '> one\n> two',
  )
  expect(render('x\none', [{ kind: 'blockquote', offset: 2, length: 3 }]).content).toBe('x\n> one')
})

test('blockquote starting mid-line keeps its text without a prefix', () => {
  expect(render('a one', [{ kind: 'blockquote', offset: 2, length: 3 }]).content).toBe('a one')
})

test('blockquote holding code is dropped and the code kept', () => {
  expect(
    render('see a*b', [
      { kind: 'blockquote', offset: 0, length: 7 },
      { kind: 'code', offset: 4, length: 3 },
    ]).content,
  ).toBe('see `a*b`')
})

test('too long with markup falls back to unformatted', () => {
  const text = 'x'.repeat(1999)
  expect(render(text, [{ kind: 'bold', offset: 0, length: 1999 }])).toEqual({
    content: text,
    fallback: 'unformatted',
  })
})

test('too long once escaped falls back to raw text', () => {
  const text = '*'.repeat(1800)
  expect(renderContent(plain(text), 2000)).toEqual({ content: text, fallback: 'raw' })
})

test('too long with markup and escapes falls back to raw text', () => {
  const text = '*'.repeat(1200)
  expect(render(text, [{ kind: 'bold', offset: 0, length: 1200 }]).fallback).toBe('raw')
})

test('empty text renders empty', () => {
  expect(renderContent(plain(''), 2000)).toEqual({ content: '', fallback: 'none' })
})
