import { expect, test } from 'vite-plus/test'
import { parseState } from '../../src/state/index.ts'

const VALID = {
  version: 1,
  provider: 'telegram',
  requests: [{ id: 'r1', reference: { chatId: 1, messageId: 2 }, text: 'Deploy?' }],
  notifications: [
    { id: 'n1', reference: { chatId: 1, messageId: 3 }, expiresAtMs: 1_792_400_000_000 },
  ],
}
const VALID_RESULT = {
  ok: true,
  state: { requests: VALID.requests, notifications: VALID.notifications },
}

test('parses a valid file', () => {
  expect(parseState(VALID, 'telegram')).toEqual(VALID_RESULT)
})

test('rejects an unknown version', () => {
  expect(parseState({ ...VALID, version: 2 }, 'telegram')).toEqual({
    ok: false,
    reason: 'unsupported version',
  })
})

test('rejects a file without a version', () => {
  const { version: _version, ...raw } = VALID
  expect(parseState(raw, 'telegram')).toEqual({ ok: false, reason: 'invalid or missing fields' })
})

test('rejects a wrong shape', () => {
  const invalid = { ok: false, reason: 'invalid or missing fields' }
  expect(parseState({ ...VALID, requests: 'x' }, 'telegram')).toEqual(invalid)
  expect(parseState('nope', 'telegram')).toEqual(invalid)
})

test('rejects a provider mismatch', () => {
  expect(parseState(VALID, 'fake')).toEqual({
    ok: false,
    reason: 'written for provider "telegram"',
  })
})

test('rejects a record without a reference', () => {
  const requests = [{ id: 'r1', text: 'Deploy?' }]
  expect(parseState({ ...VALID, requests }, 'telegram')).toEqual({
    ok: false,
    reason: 'invalid or missing fields',
  })
})

test('drops extra fields', () => {
  const raw = {
    ...VALID,
    extra: 1,
    requests: [{ ...VALID.requests[0], more: true }],
  }
  expect(parseState(raw, 'telegram')).toEqual(VALID_RESULT)
})

test('a record with spans loads', () => {
  const spans = [{ kind: 'pre', offset: 0, length: 5, language: 'diff' }]
  const requests = [{ ...VALID.requests[0], spans }]
  expect(parseState({ ...VALID, requests }, 'telegram')).toEqual({
    ok: true,
    state: { requests, notifications: VALID.notifications },
  })
})

test('a 0.4.0 record without spans loads', () => {
  const result = parseState(VALID, 'telegram')
  expect(result.ok && Object.hasOwn(result.state.requests[0] ?? {}, 'spans')).toBe(false)
})

test('a bad span invalidates the file', () => {
  const requests = [{ ...VALID.requests[0], spans: [{ kind: 'link', offset: 0, length: 1 }] }]
  expect(parseState({ ...VALID, requests }, 'telegram')).toEqual({
    ok: false,
    reason: 'invalid or missing fields',
  })
})

test('a record with a caller round-trips', () => {
  const requests = [{ ...VALID.requests[0], caller: { key: 'k1', pairing: 'p1' } }]
  expect(parseState({ ...VALID, requests }, 'telegram')).toEqual({
    ok: true,
    state: { requests, notifications: VALID.notifications },
  })
})

test('a record without a caller still loads without one', () => {
  const result = parseState(VALID, 'telegram')
  expect(result.ok && Object.hasOwn(result.state.requests[0] ?? {}, 'caller')).toBe(false)
})

test('a caller without a pairing invalidates the file', () => {
  const requests = [{ ...VALID.requests[0], caller: { key: 'k1' } }]
  expect(parseState({ ...VALID, requests }, 'telegram')).toEqual({
    ok: false,
    reason: 'invalid or missing fields',
  })
})
