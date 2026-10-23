import { expect, test } from 'vite-plus/test'
import { appendText, prependText, toFormattedText } from '../../src/format/index.ts'

test('plain is untouched', () => {
  expect(toFormattedText('  a\r\n*b*  ', 'plain')).toEqual({ text: '  a\r\n*b*  ', spans: [] })
})

test('markdown parses', () => {
  expect(toFormattedText('`ls`', 'markdown')).toEqual({
    text: 'ls',
    spans: [{ kind: 'code', offset: 0, length: 2 }],
  })
})

test('prepend shifts spans', () => {
  expect(
    prependText('[api]\n\n', { text: 'ls', spans: [{ kind: 'code', offset: 0, length: 2 }] }),
  ).toEqual({ text: '[api]\n\nls', spans: [{ kind: 'code', offset: 7, length: 2 }] })
})

test('append keeps spans', () => {
  expect(
    appendText({ text: 'ls', spans: [{ kind: 'code', offset: 0, length: 2 }] }, '\n\nok'),
  ).toEqual({ text: 'ls\n\nok', spans: [{ kind: 'code', offset: 0, length: 2 }] })
})
