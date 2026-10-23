import { expect, test } from 'vite-plus/test'
import {
  parseApprovalRequest,
  parseRetryCount,
  parseVoteRequest,
  parseWaitSeconds,
} from '../../src/approval/index.ts'

const LIMIT = 1000
const base = { text: 'This is a test', options: ['Approve', 'Decline'], timeoutOption: 'Decline' }
const expectedBase = {
  message: { text: 'This is a test', spans: [] },
  options: ['Approve', 'Decline'],
  timeoutOption: 'Decline',
}

test('valid, default timeout', () =>
  expect(parseApprovalRequest(base, 3900, LIMIT)).toEqual({
    ok: true,
    value: { ...expectedBase, question: base.text, allowText: false, timeoutSeconds: 300 },
  }))
test('custom timeout', () =>
  expect(parseApprovalRequest({ ...base, timeout: 30 }, 3900, LIMIT)).toMatchObject({
    ok: true,
    value: { timeoutSeconds: 30 },
  }))
test.each([
  [undefined, 300],
  [900, 900],
  [86_400, 86_400],
  [100_000, 86_400],
])('timeout %s becomes %s (default 300, clamped to 24 h)', (timeout, expected) => {
  const result = parseApprovalRequest(
    { ...base, ...(timeout === undefined ? {} : { timeout }) },
    3900,
    LIMIT,
  )
  expect(result.ok && result.value.timeoutSeconds).toBe(expected)
})
test.each([0, -5, '30', null, Number.NaN, Infinity])('bad timeout %s', (t) => {
  const r = parseApprovalRequest({ ...base, timeout: t }, 3900, LIMIT)
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.error).toContain('timeout')
  }
})
test.each([
  ['not object', 'hi'],
  ['null', null],
  ['array', []],
  ['missing text', { ...base, text: undefined }],
  ['empty text', { ...base, text: '' }],
  ['whitespace-only text', { ...base, text: '  \n\t ' }],
  ['text too long', { ...base, text: 'x'.repeat(3901) }],
  ['options not array', { ...base, options: 'Approve' }],
  ['empty options', { ...base, options: [], timeoutOption: 'x' }],
  ['non-string option', { ...base, options: ['Approve', 1] }],
  ['empty option label', { ...base, options: ['Approve', ''] }],
  ['65-char option label', { ...base, options: ['Approve', 'x'.repeat(65)] }],
  ['duplicate options', { ...base, options: ['Approve', 'Approve'], timeoutOption: 'Approve' }],
  ['missing timeoutOption', { ...base, timeoutOption: undefined }],
  ['timeoutOption not in options', { ...base, timeoutOption: 'Maybe' }],
])('%s rejected', (_n, body) => {
  const r = parseApprovalRequest(body, 3900, LIMIT)
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.error.length).toBeGreaterThan(0)
  }
})

test('64-char option label accepted', () => {
  const long = 'x'.repeat(64)
  expect(
    parseApprovalRequest({ ...base, options: ['Approve', long], timeoutOption: long }, 3900, LIMIT)
      .ok,
  ).toBe(true)
})

test('text limit comes from the caller', () => {
  expect(parseApprovalRequest({ ...base, text: 'x'.repeat(11) }, 10, LIMIT)).toEqual({
    ok: false,
    error: 'text must be at most 10 characters',
  })
})

test('request with a project keeps project and bare question, combined text for the chat', () => {
  expect(
    parseApprovalRequest({ ...base, text: 'Deploy?', project: '  api ' }, 3900, LIMIT),
  ).toEqual({
    ok: true,
    value: {
      ...expectedBase,
      message: { text: '[api]\n\nDeploy?', spans: [] },
      question: 'Deploy?',
      project: 'api',
      allowText: false,
      timeoutSeconds: 300,
    },
  })
})

test('request without a project has no project key and question equals text', () => {
  const result = parseApprovalRequest({ ...base, text: 'Deploy?' }, 3900, LIMIT)
  expect(result.ok && Object.hasOwn(result.value, 'project')).toBe(false)
  expect(result.ok && result.value.question).toBe('Deploy?')
})

test('project goes on its own first line, trimmed', () =>
  expect(parseApprovalRequest({ ...base, project: ' api ' }, 3900, LIMIT)).toEqual({
    ok: true,
    value: {
      ...expectedBase,
      message: { text: '[api]\n\nThis is a test', spans: [] },
      question: base.text,
      project: 'api',
      allowText: false,
      timeoutSeconds: 300,
    },
  }))
test('project counts toward the text limit', () => {
  expect(parseApprovalRequest({ ...base, text: 'xxxx', project: 'ab' }, 10, LIMIT).ok).toBe(true)
  expect(parseApprovalRequest({ ...base, text: 'xxxxx', project: 'ab' }, 10, LIMIT)).toEqual({
    ok: false,
    error: 'text must be at most 4 characters',
  })
})
test.each([5, '', '   '])('bad project %s', (project) =>
  expect(parseApprovalRequest({ ...base, project }, 3900, LIMIT)).toEqual({
    ok: false,
    error: 'project must be a non-empty string',
  }),
)
test('project length limit', () => {
  expect(parseApprovalRequest({ ...base, project: 'x'.repeat(100) }, 3900, LIMIT).ok).toBe(true)
  expect(parseApprovalRequest({ ...base, project: 'x'.repeat(101) }, 3900, LIMIT)).toEqual({
    ok: false,
    error: 'project must be at most 100 characters',
  })
})

const SPAN_CODE_7 = { kind: 'code', offset: 7, length: 2 } as const

test('plain is the default and keeps the text as is', () =>
  expect(parseApprovalRequest({ ...base, text: '  **a**  ' }, 3900, LIMIT)).toMatchObject({
    ok: true,
    value: { message: { text: '  **a**  ', spans: [] } },
  }))
test('bad format', () =>
  expect(parseApprovalRequest({ ...base, format: 'html' }, 3900, LIMIT)).toEqual({
    ok: false,
    error: 'format must be "plain" or "markdown"',
  }))
test.each(['```\n```', '`   `'])('blank after formatting: %j', (text) =>
  expect(parseApprovalRequest({ ...base, text, format: 'markdown' }, 3900, LIMIT)).toEqual({
    ok: false,
    error: 'text must not be blank after formatting',
  }),
)
test('markdown source over the limit that renders under it passes', () => {
  const result = parseApprovalRequest(
    { ...base, text: `\`${'x'.repeat(3899)}\``, format: 'markdown' },
    3900,
    LIMIT,
  )
  expect(result.ok && result.value.message.text.length).toBe(3899)
})
test('markdown rendered one over the limit fails', () =>
  expect(
    parseApprovalRequest(
      { ...base, text: `**${'x'.repeat(3901)}**`, format: 'markdown' },
      3900,
      LIMIT,
    ),
  ).toEqual({ ok: false, error: 'text must be at most 3900 characters after formatting' }))
test('plain over the limit keeps its message', () =>
  expect(parseApprovalRequest({ ...base, text: 'x'.repeat(3901) }, 3900, LIMIT)).toEqual({
    ok: false,
    error: 'text must be at most 3900 characters',
  }))
test('project shifts spans', () =>
  expect(
    parseApprovalRequest(
      { ...base, text: '`ls`', project: 'api', format: 'markdown' },
      3900,
      LIMIT,
    ),
  ).toMatchObject({
    ok: true,
    value: { message: { text: '[api]\n\nls', spans: [SPAN_CODE_7] } },
  }))
test('markup in project stays literal', () =>
  expect(
    parseApprovalRequest(
      { ...base, text: '**go**', project: '**x**', format: 'markdown' },
      3900,
      LIMIT,
    ),
  ).toMatchObject({
    ok: true,
    value: {
      message: { text: '[**x**]\n\ngo', spans: [{ kind: 'bold', offset: 9, length: 2 }] },
    },
  }))
test('markdown with project over the limit', () =>
  expect(
    parseApprovalRequest(
      { ...base, text: `**${'x'.repeat(3894)}**`, project: 'api', format: 'markdown' },
      3900,
      LIMIT,
    ),
  ).toEqual({ ok: false, error: 'text must be at most 3893 characters after formatting' }))

const text = { text: 'Which branch?', allowText: true, timeoutOption: 'main' }
const errorOf = (body: unknown) => {
  const r = parseApprovalRequest(body, 3900, LIMIT)
  return r.ok ? undefined : r.error
}

test('allowText without options is a text-only question', () =>
  expect(parseApprovalRequest(text, 3900, LIMIT)).toEqual({
    ok: true,
    value: {
      message: { text: text.text, spans: [] },
      question: text.text,
      allowText: true,
      options: [],
      timeoutOption: 'main',
      timeoutSeconds: 300,
    },
  }))
test('allowText with empty options', () =>
  expect(parseApprovalRequest({ ...text, options: [] }, 3900, LIMIT)).toMatchObject({
    ok: true,
    value: { options: [] },
  }))
test('allowText with options, timeoutOption not among them', () =>
  expect(parseApprovalRequest({ ...text, options: ['develop'] }, 3900, LIMIT)).toMatchObject({
    ok: true,
    value: { options: ['develop'], timeoutOption: 'main', allowText: true },
  }))
test.each([undefined, false])('allowText %s without options keeps the old error', (allowText) =>
  expect(errorOf({ ...text, allowText, options: undefined })).toBe(
    'options must be a non-empty array',
  ),
)
test('allowText false with empty options keeps the old error', () =>
  expect(errorOf({ ...base, allowText: false, options: [] })).toBe(
    'options must be a non-empty array',
  ))
test.each(['yes', 1, null])('allowText %s rejected', (allowText) =>
  expect(errorOf({ ...base, allowText })).toBe('allowText must be a boolean'),
)
test('allowText with non-array options', () =>
  expect(errorOf({ ...text, options: 'main' })).toBe('options must be an array'))
test('allowText keeps the option element and uniqueness rules', () => {
  expect(errorOf({ ...text, options: ['a', ''] })).toBe(
    'options must contain only non-empty strings of at most 64 characters',
  )
  expect(errorOf({ ...text, options: ['a', 'a'] })).toBe('options must be unique')
})
test.each(['', 'x'.repeat(65)])('allowText with bad timeoutOption %#', (timeoutOption) =>
  expect(errorOf({ ...text, timeoutOption })).toBe(
    'timeoutOption must be a non-empty string of at most 64 characters',
  ),
)
test('64-char timeoutOption accepted with allowText', () =>
  expect(parseApprovalRequest({ ...text, timeoutOption: 'x'.repeat(64) }, 3900, LIMIT).ok).toBe(
    true,
  ))
test('without allowText timeoutOption must still be one of options', () =>
  expect(errorOf({ ...base, timeoutOption: 'Maybe' })).toBe('timeoutOption must be one of options'))
test.each([
  [undefined, 0],
  ['0', 0],
  ['-0', 0],
  ['2.5', 2.5],
  ['120', 120],
  ['500', 120],
])('wait %s becomes %s seconds (clamped to 120)', (raw, seconds) =>
  expect(parseWaitSeconds(raw)).toEqual({ ok: true, seconds }),
)
test.each([[''], ['   '], ['-1'], ['abc'], ['Infinity'], ['1e999'], [['1', '2']], [5], [null]])(
  'bad wait %j',
  (raw: unknown) =>
    expect(parseWaitSeconds(raw)).toEqual({
      ok: false,
      error: 'wait must be a non-negative number',
    }),
)

const parse = (attachment: unknown) => parseApprovalRequest({ ...base, attachment }, 3900, LIMIT)
const attachmentErrorOf = (attachment: unknown) => {
  const result = parse(attachment)
  return result.ok ? undefined : result.error
}
const contentOf = (attachment: unknown) => {
  const result = parse(attachment)
  return result.ok ? result.value.attachment?.content : undefined
}
const NAME_CONTENT_ERROR = 'attachment.name must not contain "/", "\\" or control characters'

test('a text attachment is decoded as utf-8', () => {
  const result = parse({ name: 'changes.diff', text: 'diff --git a/x b/x\n' })
  expect(result.ok && result.value.attachment).toEqual({
    name: 'changes.diff',
    content: new Uint8Array(Buffer.from('diff --git a/x b/x\n')),
  })
})
test('a data attachment is decoded from base64', () => {
  const data = Buffer.from([0, 1, 255]).toString('base64')
  expect(contentOf({ name: 'x.bin', data })).toEqual(new Uint8Array([0, 1, 255]))
})
test('line-wrapped base64 with padding is accepted', () => {
  expect(contentOf({ name: 'x.bin', data: 'AAEC\n/w==\r\n' })).toEqual(
    new Uint8Array([0, 1, 2, 255]),
  )
})
test('base64 without padding is accepted', () => {
  expect(contentOf({ name: 'x.bin', data: 'AAECAw' })).toEqual(new Uint8Array([0, 1, 2, 3]))
})
test('a body without attachment parses with attachment undefined', () => {
  const result = parseApprovalRequest(base, 3900, LIMIT)
  expect(result.ok && result.value.attachment).toBeUndefined()
  expect(result).toEqual({
    ok: true,
    value: {
      ...expectedBase,
      question: base.text,
      allowText: false,
      timeoutSeconds: 300,
      attachment: undefined,
    },
  })
})
test.each(['日本語 ログ.txt', 'my report (final).pdf'])('name %j is accepted', (name) => {
  expect(parse({ name, text: 'x' }).ok).toBe(true)
})
test('text size counts utf-8 bytes', () => {
  expect(parse({ name: 'x.txt', text: 'é'.repeat(500) }).ok).toBe(true)
  expect(attachmentErrorOf({ name: 'x.txt', text: 'é'.repeat(500) + 'a' })).toBe(
    'attachment must be at most 1000 bytes',
  )
})
test('data exactly at the limit is accepted and one byte over is rejected', () => {
  expect(parse({ name: 'x.bin', data: Buffer.alloc(1000, 1).toString('base64') }).ok).toBe(true)
  expect(attachmentErrorOf({ name: 'x.bin', data: Buffer.alloc(1001, 1).toString('base64') })).toBe(
    'attachment must be at most 1000 bytes',
  )
})
test.each([
  ['url-safe', '-_8'],
  ['stray character', 'AAEC*w=='],
  ['bad length', 'AAECA'],
  ['padding in the middle', 'AA==AAEC'],
  ['data url', 'data:text/plain;base64,AAEC'],
])('%s base64 is rejected', (_case, data) => {
  expect(attachmentErrorOf({ name: 'x.bin', data })).toBe('attachment.data must be base64')
})
test('data that is not a string is rejected', () => {
  expect(attachmentErrorOf({ name: 'x.bin', data: 5 })).toBe('attachment.data must be base64')
})
test('text that is not a string is rejected', () => {
  expect(attachmentErrorOf({ name: 'x.txt', text: 5 })).toBe('attachment.text must be a string')
})
test('empty content is rejected', () => {
  expect(attachmentErrorOf({ name: 'x.txt', text: '' })).toBe('attachment must not be empty')
  expect(attachmentErrorOf({ name: 'x.bin', data: '' })).toBe('attachment must not be empty')
})
test('neither or both of text and data is rejected', () => {
  const message = 'attachment must have exactly one of text and data'
  expect(attachmentErrorOf({ name: 'x.txt' })).toBe(message)
  expect(attachmentErrorOf({ name: 'x.txt', text: 'a', data: 'AAEC' })).toBe(message)
})
test.each([null, 'x', [], 1])('attachment %j is not an object', (attachment) => {
  expect(attachmentErrorOf(attachment)).toBe('attachment must be an object')
})
test.each([
  ['', 'attachment.name must be a non-empty string'],
  ['a'.repeat(256), 'attachment.name must be at most 255 characters'],
  ['a/b', NAME_CONTENT_ERROR],
  ['a\\b', NAME_CONTENT_ERROR],
  ['a\u0000b', NAME_CONTENT_ERROR],
  ['a\u007fb', NAME_CONTENT_ERROR],
  [' a.txt', 'attachment.name must not start or end with whitespace'],
  ['a.txt ', 'attachment.name must not start or end with whitespace'],
  ['.', 'attachment.name must not be "." or ".."'],
  ['..', 'attachment.name must not be "." or ".."'],
])('name %j is rejected', (name, message) => {
  expect(attachmentErrorOf({ name, text: 'x' })).toBe(message)
})
test('a 255-character name is accepted', () => {
  expect(parse({ name: 'a'.repeat(255), text: 'x' }).ok).toBe(true)
})
test('a missing name is rejected', () => {
  expect(attachmentErrorOf({ text: 'x' })).toBe('attachment.name must be a non-empty string')
})

const BIG_LIMIT = 10_485_760
const parseBig = (bytes: number) =>
  parseApprovalRequest(
    { ...base, attachment: { name: 'big.bin', data: Buffer.alloc(bytes, 1).toString('base64') } },
    3900,
    BIG_LIMIT,
  )

test('a 10 MiB base64 payload parses without throwing', () => {
  const result = parseBig(BIG_LIMIT)
  expect(result.ok && result.value.attachment?.content.byteLength).toBe(BIG_LIMIT)
})
test('a base64 payload one byte over a 10 MiB limit is rejected', () => {
  expect(parseBig(BIG_LIMIT + 1)).toEqual({
    ok: false,
    error: 'attachment must be at most 10485760 bytes',
  })
})
test.each(['=', '==', 'A===', 'AAECAw='])(
  'padding-only or misplaced padding %j is rejected',
  (data) => {
    expect(attachmentErrorOf({ name: 'x.bin', data })).toBe('attachment.data must be base64')
  },
)
test('a non-string name is rejected', () => {
  expect(attachmentErrorOf({ name: 5, text: 'x' })).toBe(
    'attachment.name must be a non-empty string',
  )
})

test('more options than maxOptionCount is rejected', () => {
  const body = { text: 'q', options: ['a', 'b', 'c'], timeoutOption: 'a' }
  expect(parseApprovalRequest(body, 100, 0, 2)).toEqual({
    ok: false,
    error: 'options must have at most 2 entries',
  })
  expect(parseApprovalRequest(body, 100, 0, 3).ok).toBe(true)
  expect(parseApprovalRequest(body, 100, 0).ok).toBe(true)
})

test('parseRetryCount reads retry, absent meaning none', () => {
  expect(parseRetryCount({ ...base, retry: 3 })).toEqual({ ok: true, retryCount: 3 })
  expect(parseRetryCount(base)).toEqual({ ok: true, retryCount: undefined })
})

test.each([-1, 1.5, 101, '1', null])('parseRetryCount rejects retry %j', (retry) => {
  expect(parseRetryCount({ ...base, retry })).toEqual({
    ok: false,
    error: 'retry must be an integer 0-100',
  })
})

test('parseVoteRequest defaults to all and no retries, voters as sent', () => {
  const result = parseVoteRequest(base, 3900, LIMIT)
  expect(result).toMatchObject({ ok: true, value: { rule: 'all', retryCount: 0 } })
  expect(result.ok && result.value).not.toHaveProperty('voters')
  expect(
    parseVoteRequest({ ...base, voters: [' 1 ', '2'], require: 'majority', retry: 2 }, 3900, LIMIT),
  ).toMatchObject({ ok: true, value: { voters: ['1', '2'], rule: 'majority', retryCount: 2 } })
})

test('parseVoteRequest reports the question problem before the vote shape', () => {
  expect(parseVoteRequest({ ...base, text: '' }, 3900, LIMIT)).toEqual({
    ok: false,
    error: 'text must be a non-empty string',
  })
})

test('parseVoteRequest caps the voter count', () => {
  const voters = Array.from({ length: 26 }, (_, index) => String(index))
  expect(parseVoteRequest({ ...base, voters }, 3900, LIMIT)).toEqual({
    ok: false,
    error: 'voters must have at most 25 entries',
  })
})
