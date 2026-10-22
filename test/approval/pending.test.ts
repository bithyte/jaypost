import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import { PendingRequests } from '../../src/approval/index.ts'

const req = {
  message: { text: 't', spans: [] },
  question: 't',
  options: ['Approve', 'Decline'],
  timeoutOption: 'Decline',
  allowText: false,
  timeoutSeconds: 10,
  attachment: undefined,
}

const OPENED_AT = new Date(2026, 0, 1, 9, 0)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

test('answer settles with option label', async () => {
  const p = new PendingRequests()
  const s = p.open('a', req, OPENED_AT)
  expect(p.answer('a', 0)).toBe(true)
  await expect(s).resolves.toEqual({ kind: 'answered', answer: 'Approve' })
  expect(p.size).toBe(0)
})

test('timeout settles with timeoutOption', async () => {
  const p = new PendingRequests()
  const s = p.open('a', req, OPENED_AT)
  vi.advanceTimersByTime(9999)
  expect(p.size).toBe(1)
  vi.advanceTimersByTime(1)
  await expect(s).resolves.toEqual({ kind: 'timedOut', answer: 'Decline' })
  expect(p.size).toBe(0)
})

test('second answer and answer after timeout return false', () => {
  const p = new PendingRequests()
  p.open('a', req, OPENED_AT)
  p.answer('a', 1)
  expect(p.answer('a', 0)).toBe(false)
  p.open('b', req, OPENED_AT)
  vi.advanceTimersByTime(10_000)
  expect(p.answer('b', 0)).toBe(false)
})

test('out of range index returns false and keeps pending', () => {
  const p = new PendingRequests()
  p.open('a', req, OPENED_AT)
  expect(p.answer('a', 2)).toBe(false)
  expect(p.answer('a', -1)).toBe(false)
  expect(p.size).toBe(1)
})

test('cancel settles cancelled, then answer is false', async () => {
  const p = new PendingRequests()
  const s = p.open('a', req, OPENED_AT)
  expect(p.cancel('a')).toBe(true)
  await expect(s).resolves.toEqual({ kind: 'cancelled' })
  expect(p.answer('a', 0)).toBe(false)
  expect(p.cancel('a')).toBe(false)
})

test('answer clears the timer', async () => {
  const p = new PendingRequests()
  const s = p.open('a', req, OPENED_AT)
  p.answer('a', 0)
  expect(vi.getTimerCount()).toBe(0)
  await expect(s).resolves.toEqual({ kind: 'answered', answer: 'Approve' })
})

test('independent concurrent requests', async () => {
  const p = new PendingRequests()
  const a = p.open('a', req, OPENED_AT)
  const b = p.open('b', { ...req, timeoutSeconds: 5 }, OPENED_AT)
  vi.advanceTimersByTime(5000)
  p.answer('a', 0)
  await expect(b).resolves.toMatchObject({ kind: 'timedOut' })
  await expect(a).resolves.toMatchObject({ kind: 'answered' })
})

test('list returns open requests oldest first with their fields', () => {
  const p = new PendingRequests()
  p.open('a', req, OPENED_AT)
  p.open('b', { ...req, message: { text: 'u', spans: [] } }, OPENED_AT)
  p.answer('a', 0)
  p.open('c', req, OPENED_AT)
  expect(p.list()).toEqual([
    { id: 'b', request: { ...req, message: { text: 'u', spans: [] } }, openedAt: OPENED_AT },
    { id: 'c', request: req, openedAt: OPENED_AT },
  ])
})

test('rejectAll settles each with its timeout option and returns them in order', async () => {
  const p = new PendingRequests()
  const a = p.open('a', req, OPENED_AT)
  const b = p.open('b', { ...req, options: ['Yes', 'No'], timeoutOption: 'No' }, OPENED_AT)
  expect(p.rejectAll().map((summary) => summary.id)).toEqual(['a', 'b'])
  await expect(a).resolves.toEqual({ kind: 'rejected', answer: 'Decline' })
  await expect(b).resolves.toEqual({ kind: 'rejected', answer: 'No' })
  expect(p.size).toBe(0)
  expect(p.list()).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
})

test('timeout after rejectAll changes nothing', async () => {
  const p = new PendingRequests()
  const a = p.open('a', req, OPENED_AT)
  p.rejectAll()
  vi.advanceTimersByTime(10_000)
  await expect(a).resolves.toEqual({ kind: 'rejected', answer: 'Decline' })
})

test('rejectAll on empty returns []', () => {
  expect(new PendingRequests().rejectAll()).toEqual([])
})

test('answer and cancel after rejectAll return false', () => {
  const p = new PendingRequests()
  p.open('a', req, OPENED_AT)
  p.rejectAll()
  expect(p.answer('a', 0)).toBe(false)
  expect(p.cancel('a')).toBe(false)
})

const textReq = { ...req, options: [], allowText: true, timeoutOption: 'main' }

test('reply settles an allowText request as replied', async () => {
  const p = new PendingRequests()
  const s = p.open('a', textReq, OPENED_AT)
  expect(p.reply('a', 'feature/x')).toBe(true)
  await expect(s).resolves.toEqual({ kind: 'replied', answer: 'feature/x' })
  expect(p.size).toBe(0)
})

test('reply to a buttons-only request or an unknown id is false and leaves it open', () => {
  const p = new PendingRequests()
  p.open('a', req, OPENED_AT)
  expect(p.reply('a', 'x')).toBe(false)
  expect(p.reply('nope', 'x')).toBe(false)
  expect(p.size).toBe(1)
})

test('close settles as closed once', async () => {
  const p = new PendingRequests()
  const s = p.open('a', req, OPENED_AT)
  expect(p.close('a', 'Approve')).toBe(true)
  await expect(s).resolves.toEqual({ kind: 'closed', answer: 'Approve' })
  expect(p.close('a', 'Approve')).toBe(false)
  expect(p.close('nope', 'Approve')).toBe(false)
  expect(p.size).toBe(0)
})
