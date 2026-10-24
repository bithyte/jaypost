import { expect, test } from 'vite-plus/test'
import {
  toButton,
  toChoiceButtons,
  toFallbackText,
  toOutgoingMessage,
  toRichText,
} from '../../src/slack/index.ts'

const plain = (text: string) => ({ text, spans: [] })

test('plain text is one section of literal text', () => {
  expect(toRichText(plain('Deploy *prod* <now> & `x`?'))).toEqual([
    {
      type: 'rich_text_section',
      elements: [{ type: 'text', text: 'Deploy *prod* <now> & `x`?' }],
    },
  ])
})

test('bare links become link elements', () => {
  expect(toRichText(plain('see https://example.com/a?b=1 now'))).toEqual([
    {
      type: 'rich_text_section',
      elements: [
        { type: 'text', text: 'see ' },
        { type: 'link', url: 'https://example.com/a?b=1' },
        { type: 'text', text: ' now' },
      ],
    },
  ])
})

test('nested spans combine their styles', () => {
  expect(
    toRichText({
      text: 'a bold italic b',
      spans: [
        { kind: 'bold', offset: 2, length: 11 },
        { kind: 'italic', offset: 7, length: 6 },
      ],
    }),
  ).toEqual([
    {
      type: 'rich_text_section',
      elements: [
        { type: 'text', text: 'a ' },
        { type: 'text', text: 'bold ', style: { bold: true } },
        { type: 'text', text: 'italic', style: { bold: true, italic: true } },
        { type: 'text', text: ' b' },
      ],
    },
  ])
})

test('strikethrough and inline code map to strike and code, and code is never linked', () => {
  expect(
    toRichText({
      text: 'old https://x.io',
      spans: [
        { kind: 'strikethrough', offset: 0, length: 3 },
        { kind: 'code', offset: 4, length: 12 },
      ],
    }),
  ).toEqual([
    {
      type: 'rich_text_section',
      elements: [
        { type: 'text', text: 'old', style: { strike: true } },
        { type: 'text', text: ' ' },
        { type: 'text', text: 'https://x.io', style: { code: true } },
      ],
    },
  ])
})

test('a pre span is a code block with its language, dropping the line breaks around it', () => {
  expect(
    toRichText({
      text: 'before\nconst a = 1\nafter',
      spans: [{ kind: 'pre', offset: 7, length: 11, language: 'ts' }],
    }),
  ).toEqual([
    { type: 'rich_text_section', elements: [{ type: 'text', text: 'before' }] },
    {
      type: 'rich_text_preformatted',
      elements: [{ type: 'text', text: 'const a = 1' }],
      language: 'ts',
    },
    { type: 'rich_text_section', elements: [{ type: 'text', text: 'after' }] },
  ])
})

test('a blockquote at a line start is a quote with its inner styles', () => {
  expect(
    toRichText({
      text: 'quoted bold\nrest',
      spans: [
        { kind: 'blockquote', offset: 0, length: 11 },
        { kind: 'bold', offset: 7, length: 4 },
      ],
    }),
  ).toEqual([
    {
      type: 'rich_text_quote',
      elements: [
        { type: 'text', text: 'quoted ' },
        { type: 'text', text: 'bold', style: { bold: true } },
      ],
    },
    { type: 'rich_text_section', elements: [{ type: 'text', text: 'rest' }] },
  ])
})

test('a blockquote inside a line keeps its text in the section', () => {
  expect(
    toRichText({ text: 'a quote', spans: [{ kind: 'blockquote', offset: 2, length: 5 }] }),
  ).toEqual([
    {
      type: 'rich_text_section',
      elements: [
        { type: 'text', text: 'a ' },
        { type: 'text', text: 'quote' },
      ],
    },
  ])
})

test('empty text still makes a valid section', () => {
  expect(toRichText(plain(''))).toEqual([
    { type: 'rich_text_section', elements: [{ type: 'text', text: ' ' }] },
  ])
})

test('the fallback text escapes mrkdwn control characters and is cut at 4000', () => {
  expect(toFallbackText('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
  expect(toFallbackText('x'.repeat(5000))).toHaveLength(4000)
})

test('choice buttons carry the request id and index in action id and value', () => {
  expect(toChoiceButtons('r1', ['Yes', 'No'])).toEqual([
    {
      type: 'button',
      text: { type: 'plain_text', text: 'Yes', emoji: false },
      action_id: 'r1:0',
      value: 'r1:0',
    },
    {
      type: 'button',
      text: { type: 'plain_text', text: 'No', emoji: false },
      action_id: 'r1:1',
      value: 'r1:1',
    },
  ])
})

test('a long button label is cut to 75 characters with an ellipsis', () => {
  const label = toButton('é'.repeat(80), 'r1:0').text.text
  expect(Array.from(label)).toHaveLength(75)
  expect(label.endsWith('…')).toBe(true)
  expect(toButton('x'.repeat(75), 'r1:0').text.text).toBe('x'.repeat(75))
})

test('an outgoing message has the text block, then buttons only when there are some', () => {
  const buttons = toChoiceButtons('r1', ['Yes'])
  expect(toOutgoingMessage(plain('hi'), buttons)).toEqual({
    text: 'hi',
    blocks: [
      { type: 'rich_text', elements: toRichText(plain('hi')) },
      { type: 'actions', elements: buttons },
    ],
  })
  expect(toOutgoingMessage(plain('hi'), []).blocks).toHaveLength(1)
})
