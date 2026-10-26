import { expect, test } from 'vite-plus/test'
import { parseNotifyRequest } from '../../src/notify/index.ts'

test('valid body', () => {
  expect(parseNotifyRequest({ text: 'hi' }, 3900, 1000)).toEqual({
    ok: true,
    value: { message: { text: 'hi', spans: [] } },
  })
})

test('extra fields are dropped', () => {
  expect(parseNotifyRequest({ text: 'hi', foo: 1 }, 3900, 1000)).toEqual({
    ok: true,
    value: { message: { text: 'hi', spans: [] } },
  })
})

test('text at the limit is accepted', () => {
  expect(parseNotifyRequest({ text: 'a'.repeat(3900) }, 3900, 1000).ok).toBe(true)
})

test('text over the limit', () => {
  expect(parseNotifyRequest({ text: 'a'.repeat(3901) }, 3900, 1000)).toEqual({
    ok: false,
    error: 'text must be at most 3900 characters',
  })
})

test.each([undefined, '', '   ', 5])('bad text %s', (text) => {
  expect(parseNotifyRequest({ text }, 3900, 1000)).toEqual({
    ok: false,
    error: 'text must be a non-empty string',
  })
})

test.each([null, [], 'x'])('non-object body %s', (body) => {
  expect(parseNotifyRequest(body, 3900, 1000)).toEqual({
    ok: false,
    error: 'body must be a JSON object',
  })
})

test('text limit comes from the caller', () => {
  expect(parseNotifyRequest({ text: 'x'.repeat(11) }, 10, 1000)).toEqual({
    ok: false,
    error: 'text must be at most 10 characters',
  })
})

test('project goes on its own first line, trimmed', () => {
  expect(parseNotifyRequest({ text: 'hi', project: ' api ' }, 3900, 1000)).toEqual({
    ok: true,
    value: { message: { text: '[api]\n\nhi', spans: [] } },
  })
})

test('project counts toward the text limit', () => {
  expect(parseNotifyRequest({ text: 'xxxx', project: 'ab' }, 10, 1000).ok).toBe(true)
  expect(parseNotifyRequest({ text: 'xxxxx', project: 'ab' }, 10, 1000)).toEqual({
    ok: false,
    error: 'text must be at most 4 characters',
  })
})

test.each([5, '', '   '])('bad project %s', (project) => {
  expect(parseNotifyRequest({ text: 'hi', project }, 3900, 1000)).toEqual({
    ok: false,
    error: 'project must be a non-empty string',
  })
})

test('project length limit', () => {
  expect(parseNotifyRequest({ text: 'hi', project: 'x'.repeat(100) }, 3900, 1000).ok).toBe(true)
  expect(parseNotifyRequest({ text: 'hi', project: 'x'.repeat(101) }, 3900, 1000)).toEqual({
    ok: false,
    error: 'project must be at most 100 characters',
  })
})

const SPAN_CODE_7 = { kind: 'code', offset: 7, length: 2 } as const

test('plain is the default and keeps the text as is', () => {
  expect(parseNotifyRequest({ text: '  **a**  ' }, 3900, 1000)).toEqual({
    ok: true,
    value: { message: { text: '  **a**  ', spans: [] } },
  })
})

test('bad format', () => {
  expect(parseNotifyRequest({ text: 'hi', format: 'html' }, 3900, 1000)).toEqual({
    ok: false,
    error: 'format must be "plain" or "markdown"',
  })
})

test.each(['```\n```', '`   `'])('blank after formatting: %j', (text) => {
  expect(parseNotifyRequest({ text, format: 'markdown' }, 3900, 1000)).toEqual({
    ok: false,
    error: 'text must not be blank after formatting',
  })
})

test('markdown limit counts the rendered text', () => {
  const fits = parseNotifyRequest(
    { text: `\`${'x'.repeat(3899)}\``, format: 'markdown' },
    3900,
    1000,
  )
  expect(fits.ok && fits.value.message.text.length).toBe(3899)
  expect(
    parseNotifyRequest({ text: `**${'x'.repeat(3901)}**`, format: 'markdown' }, 3900, 1000),
  ).toEqual({ ok: false, error: 'text must be at most 3900 characters after formatting' })
})

test('project shifts spans and stays literal', () => {
  expect(
    parseNotifyRequest({ text: '`ls`', project: 'api', format: 'markdown' }, 3900, 1000),
  ).toEqual({
    ok: true,
    value: { message: { text: '[api]\n\nls', spans: [SPAN_CODE_7] } },
  })
  expect(
    parseNotifyRequest({ text: '**go**', project: '**x**', format: 'markdown' }, 3900, 1000),
  ).toEqual({
    ok: true,
    value: {
      message: { text: '[**x**]\n\ngo', spans: [{ kind: 'bold', offset: 9, length: 2 }] },
    },
  })
})

test('a notify body carries the decoded attachment', () => {
  expect(
    parseNotifyRequest({ text: 'hi', attachment: { name: 'a.txt', text: 'abc' } }, 3900, 1000),
  ).toEqual({
    ok: true,
    value: {
      message: { text: 'hi', spans: [] },
      attachment: { name: 'a.txt', content: new Uint8Array(Buffer.from('abc')) },
    },
  })
})

test('a notify body without attachment has attachment undefined', () => {
  const result = parseNotifyRequest({ text: 'hi' }, 3900, 1000)
  expect(result.ok && result.value.attachment).toBeUndefined()
})

test('a null attachment is rejected', () => {
  expect(parseNotifyRequest({ text: 'hi', attachment: null }, 3900, 1000)).toEqual({
    ok: false,
    error: 'attachment must be an object',
  })
})

const NOW = Date.parse('2026-10-26T12:00:00Z')

test('deleteAfter seconds', () => {
  expect(parseNotifyRequest({ text: 'hi', deleteAfter: 300 }, 3900, 1000, NOW)).toEqual({
    ok: true,
    value: { message: { text: 'hi', spans: [] }, deleteAfter: { kind: 'seconds', seconds: 300 } },
  })
})

test('deleteAfter numeric string is seconds', () => {
  const result = parseNotifyRequest({ text: 'hi', deleteAfter: '300' }, 3900, 1000, NOW)
  expect(result.ok && result.value.deleteAfter).toEqual({ kind: 'seconds', seconds: 300 })
})

test('deleteAfter timestamp', () => {
  const result = parseNotifyRequest(
    { text: 'hi', deleteAfter: '2026-10-26T18:00:00+02:00' },
    3900,
    1000,
    NOW,
  )
  expect(result.ok && result.value.deleteAfter).toEqual({
    kind: 'timestamp',
    atMs: Date.parse('2026-10-26T16:00:00Z'),
  })
})

test('deleteAfter omitted is undefined', () => {
  const result = parseNotifyRequest({ text: 'hi' }, 3900, 1000, NOW)
  expect(result.ok && result.value.deleteAfter).toBeUndefined()
})

test('bad deleteAfter values are rejected', () => {
  const badValues = [
    0,
    -5,
    '0',
    '5m',
    '',
    '2026-10-26T18:00:00',
    '2026-13-45T99:00:00Z',
    null,
    true,
  ]
  for (const deleteAfter of badValues) {
    expect(parseNotifyRequest({ text: 'hi', deleteAfter }, 3900, 1000, NOW)).toEqual({
      ok: false,
      error:
        'deleteAfter must be a positive number of seconds or an ISO 8601 timestamp with a timezone',
    })
  }
})

test('a deleteAfter timestamp at or before now is rejected', () => {
  for (const deleteAfter of ['2026-10-26T12:00:00Z', '2026-10-26T11:00:00Z']) {
    expect(parseNotifyRequest({ text: 'hi', deleteAfter }, 3900, 1000, NOW)).toEqual({
      ok: false,
      error: 'deleteAfter is in the past',
    })
  }
})
