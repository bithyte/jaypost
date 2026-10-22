import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import { SendError } from '../../src/approval/index.ts'
import type { FormattedText } from '../../src/format/index.ts'
import type { Attachment, MessageReference } from '../../src/approval/index.ts'
import { NOTIFICATION_TTL_MS, NotificationService } from '../../src/notify/index.ts'
import type {
  Notifier,
  NotificationServiceOptions,
  QuietSource,
  SendNotificationOptions,
} from '../../src/notify/index.ts'
import type { NotificationRecord } from '../../src/state/index.ts'

const NOW = 1_792_400_000_000
const REFERENCE: MessageReference = { chatId: 1, messageId: 9 }

class FakeNotifier implements Notifier {
  sent: { id: string; text: string }[] = []
  attachments: (Attachment | undefined)[] = []
  silent: boolean[] = []
  deleted: MessageReference[] = []
  sendError: Error | undefined
  deleteError: Error | undefined
  #nextMessageId = 1

  async sendNotification(
    id: string,
    message: FormattedText,
    options: SendNotificationOptions,
    attachment: Attachment | undefined,
  ): Promise<MessageReference> {
    if (this.sendError) {
      throw this.sendError
    }
    this.sent.push({ id, text: message.text })
    this.attachments.push(attachment)
    this.silent.push(options.silent)
    const messageId = this.#nextMessageId
    this.#nextMessageId += 1
    return { chatId: 1, messageId }
  }

  async deleteMessage(ref: MessageReference): Promise<void> {
    if (this.deleteError) {
      throw this.deleteError
    }
    this.deleted.push(ref)
  }
}

function createStore() {
  const added: NotificationRecord[] = []
  const removed: string[] = []
  return {
    added,
    removed,
    addNotification: (record: NotificationRecord) => {
      added.push(record)
    },
    removeNotification: (id: string) => {
      removed.push(id)
    },
  }
}

function setup(m: Notifier = new FakeNotifier(), options: NotificationServiceOptions = {}) {
  let count = 0
  const log = vi.fn()
  const svc = new NotificationService(
    m,
    () => {
      count += 1
      return `id${count}`
    },
    log,
    options,
  )
  return { svc, log }
}

const HOUR_MS = 3_600_000

function quietUntil(offsetMs: number): QuietSource {
  return { quietUntil: vi.fn(() => new Date(NOW + offsetMs)) }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

test('notify sends and starts the expiry', async () => {
  const m = new FakeNotifier()
  const { svc } = setup(m)
  await svc.notify({ message: { text: 'hi', spans: [] }, attachment: undefined })
  expect(m.sent).toEqual([{ id: 'id1', text: 'hi' }])
  expect(svc.size).toBe(1)
  expect(m.deleted).toEqual([])
})

test('deletes at exactly 8 hours', async () => {
  const m = new FakeNotifier()
  const { svc } = setup(m)
  await svc.notify({ message: { text: 'hi', spans: [] }, attachment: undefined })
  await vi.advanceTimersByTimeAsync(NOTIFICATION_TTL_MS - 1)
  expect(m.deleted).toEqual([])
  await vi.advanceTimersByTimeAsync(1)
  expect(m.deleted).toEqual([{ chatId: 1, messageId: 1 }])
  expect(svc.size).toBe(0)
})

test('dismiss clears the expiry', async () => {
  const m = new FakeNotifier()
  const { svc } = setup(m)
  await svc.notify({ message: { text: 'hi', spans: [] }, attachment: undefined })
  expect(svc.dismiss('id1')).toBe(true)
  await vi.advanceTimersByTimeAsync(NOTIFICATION_TTL_MS)
  expect(m.deleted).toEqual([])
  expect(svc.size).toBe(0)
})

test('dismissing one notification leaves the others', async () => {
  const m = new FakeNotifier()
  const { svc } = setup(m)
  await svc.notify({ message: { text: 'a', spans: [] }, attachment: undefined })
  await svc.notify({ message: { text: 'b', spans: [] }, attachment: undefined })
  svc.dismiss('id1')
  await vi.advanceTimersByTimeAsync(NOTIFICATION_TTL_MS)
  expect(m.deleted).toEqual([{ chatId: 1, messageId: 2 }])
})

test('dismiss for an unknown or expired id returns false', async () => {
  const { svc } = setup()
  expect(svc.dismiss('nope')).toBe(false)
  await svc.notify({ message: { text: 'hi', spans: [] }, attachment: undefined })
  await vi.advanceTimersByTimeAsync(NOTIFICATION_TTL_MS)
  expect(svc.dismiss('id1')).toBe(false)
})

test('expiry delete failure is logged and not thrown', async () => {
  const m = new FakeNotifier()
  const { svc, log } = setup(m)
  m.deleteError = new Error('message to delete not found')
  await svc.notify({ message: { text: 'hi', spans: [] }, attachment: undefined })
  await vi.advanceTimersByTimeAsync(NOTIFICATION_TTL_MS)
  expect(log).toHaveBeenCalledTimes(1)
  expect(log).toHaveBeenCalledWith('failed to delete notification: message to delete not found')
  expect(svc.size).toBe(0)
})

test('send failure throws SendError with cause and starts no timer', async () => {
  const m = new FakeNotifier()
  const { svc } = setup(m)
  const boom = new Error('boom')
  m.sendError = boom
  const error = await svc
    .notify({ message: { text: 'hi', spans: [] }, attachment: undefined })
    .catch((e: unknown) => e)
  expect(error).toBeInstanceOf(SendError)
  expect((error as SendError).cause).toBe(boom)
  expect(svc.size).toBe(0)
})

test('without deleteMessage no timer is started', async () => {
  const sendNotification = vi.fn(async () => ({ chatId: 1, messageId: 1 }))
  const { svc } = setup({ sendNotification })
  await svc.notify({ message: { text: 'hi', spans: [] }, attachment: undefined })
  expect(sendNotification).toHaveBeenCalledWith(
    'id1',
    { text: 'hi', spans: [] },
    { silent: false, dismissible: true },
    undefined,
  )
  expect(svc.size).toBe(0)
})

function setupWithStore() {
  const m = new FakeNotifier()
  const store = createStore()
  const { svc, log } = setup(m, { store, now: () => NOW })
  return { m, store, svc, log }
}

test('records the notification with its absolute expiry', async () => {
  const { store, svc } = setupWithStore()
  await svc.notify({ message: { text: 'hi', spans: [] }, attachment: undefined })
  expect(store.added).toEqual([
    { id: 'id1', reference: { chatId: 1, messageId: 1 }, expiresAtMs: NOW + NOTIFICATION_TTL_MS },
  ])
})

test('removes the record after the expiry delete', async () => {
  const { store, svc } = setupWithStore()
  await svc.notify({ message: { text: 'hi', spans: [] }, attachment: undefined })
  await vi.advanceTimersByTimeAsync(NOTIFICATION_TTL_MS)
  expect(store.removed).toEqual(['id1'])
})

test('removes the record after a failed expiry delete', async () => {
  const { m, store, svc } = setupWithStore()
  m.deleteError = new Error('gone')
  await svc.notify({ message: { text: 'hi', spans: [] }, attachment: undefined })
  await vi.advanceTimersByTimeAsync(NOTIFICATION_TTL_MS)
  expect(store.removed).toEqual(['id1'])
})

test('removes the record on dismiss', async () => {
  const { store, svc } = setupWithStore()
  await svc.notify({ message: { text: 'hi', spans: [] }, attachment: undefined })
  svc.dismiss('id1')
  expect(store.removed).toEqual(['id1'])
})

test('records nothing without deleteMessage', async () => {
  const store = createStore()
  const { svc } = setup({ sendNotification: async () => REFERENCE }, { store, now: () => NOW })
  await svc.notify({ message: { text: 'hi', spans: [] }, attachment: undefined })
  expect(store.added).toEqual([])
})

test('restored future notification is deleted at the remaining time', async () => {
  const { m, store, svc } = setupWithStore()
  svc.restore([{ id: 'old', reference: REFERENCE, expiresAtMs: NOW + 60_000 }])
  expect(svc.size).toBe(1)
  await vi.advanceTimersByTimeAsync(59_999)
  expect(m.deleted).toEqual([])
  await vi.advanceTimersByTimeAsync(1)
  expect(m.deleted).toEqual([REFERENCE])
  expect(store.removed).toEqual(['old'])
})

test('restored notification beyond the timer limit is not deleted at once', async () => {
  const { m, svc } = setupWithStore()
  svc.restore([{ id: 'far', reference: REFERENCE, expiresAtMs: NOW + 2 ** 31 + 1000 }])
  await vi.advanceTimersByTimeAsync(1000)
  expect(m.deleted).toEqual([])
  expect(svc.size).toBe(1)
})

test('overdue notification is deleted during recovery, including one expiring exactly now', async () => {
  const { m, store, svc } = setupWithStore()
  const first = { chatId: 1, messageId: 11 }
  const second = { chatId: 1, messageId: 12 }
  svc.restore([
    { id: 'a', reference: first, expiresAtMs: NOW - 1 },
    { id: 'b', reference: second, expiresAtMs: NOW },
  ])
  await vi.advanceTimersByTimeAsync(0)
  expect(m.deleted).toEqual([])
  expect(svc.size).toBe(2)
  await svc.deleteOverdue()
  expect(m.deleted).toEqual([first, second])
  expect(store.removed).toEqual(['a', 'b'])
  expect(svc.size).toBe(0)
})

test('overdue recovery removes the record when the delete fails', async () => {
  const { m, store, svc } = setupWithStore()
  m.deleteError = new Error('gone')
  svc.restore([{ id: 'a', reference: REFERENCE, expiresAtMs: NOW - 1 }])
  await svc.deleteOverdue()
  expect(store.removed).toEqual(['a'])
})

test('dismiss on a restored id returns true and stops the delete', async () => {
  const { m, store, svc } = setupWithStore()
  svc.restore([{ id: 'old', reference: REFERENCE, expiresAtMs: NOW + 60_000 }])
  expect(svc.dismiss('old')).toBe(true)
  await vi.advanceTimersByTimeAsync(NOTIFICATION_TTL_MS)
  expect(m.deleted).toEqual([])
  expect(store.removed).toEqual(['old'])
})

test('dismiss on a queued overdue id returns true and skips its delete', async () => {
  const { m, store, svc } = setupWithStore()
  svc.restore([{ id: 'old', reference: REFERENCE, expiresAtMs: NOW - 5 }])
  expect(svc.dismiss('old')).toBe(true)
  await svc.deleteOverdue()
  expect(m.deleted).toEqual([])
  expect(store.removed).toEqual(['old'])
})

test('restore without deleteMessage only removes the records', async () => {
  const store = createStore()
  const { svc } = setup({ sendNotification: async () => REFERENCE }, { store, now: () => NOW })
  svc.restore([
    { id: 'a', reference: REFERENCE, expiresAtMs: NOW + 1 },
    { id: 'b', reference: REFERENCE, expiresAtMs: NOW - 1 },
  ])
  expect(store.removed).toEqual(['a', 'b'])
  expect(svc.size).toBe(0)
})

test('stop clears the timers', async () => {
  const { m, store, svc } = setupWithStore()
  await svc.notify({ message: { text: 'hi', spans: [] }, attachment: undefined })
  svc.restore([{ id: 'old', reference: REFERENCE, expiresAtMs: NOW + 60_000 }])
  svc.restore([{ id: 'late', reference: REFERENCE, expiresAtMs: NOW - 1 }])
  svc.stop()
  expect(svc.size).toBe(0)
  await svc.deleteOverdue()
  await vi.advanceTimersByTimeAsync(NOTIFICATION_TTL_MS)
  expect(m.deleted).toEqual([])
  expect(store.removed).toEqual([])
})

test('not quiet: sent with a ping and expires after 8h', async () => {
  const m = new FakeNotifier()
  const store = createStore()
  const { svc } = setup(m, { store, now: () => NOW })
  await svc.notify({ message: { text: 'hi', spans: [] }, attachment: undefined })
  expect(m.silent).toEqual([false])
  expect(store.added.map((record) => record.expiresAtMs)).toEqual([NOW + NOTIFICATION_TTL_MS])
})

test('quiet: sent silently and expires 8h after the quiet period ends', async () => {
  const m = new FakeNotifier()
  const store = createStore()
  const { svc } = setup(m, { store, now: () => NOW, quiet: quietUntil(9 * HOUR_MS) })
  await svc.notify({ message: { text: 'hi', spans: [] }, attachment: undefined })
  expect(m.silent).toEqual([true])
  expect(store.added.map((record) => record.expiresAtMs)).toEqual([NOW + 17 * HOUR_MS])
  await vi.advanceTimersByTimeAsync(17 * HOUR_MS - 1)
  expect(m.deleted).toEqual([])
  await vi.advanceTimersByTimeAsync(1)
  expect(m.deleted).toEqual([{ chatId: 1, messageId: 1 }])
})

test('quiet: no expiry when it would pass 47h after the send', async () => {
  const m = new FakeNotifier()
  const store = createStore()
  const { svc } = setup(m, { store, now: () => NOW, quiet: quietUntil(39 * HOUR_MS + 1) })
  await svc.notify({ message: { text: 'hi', spans: [] }, attachment: undefined })
  expect(m.silent).toEqual([true])
  expect(store.added).toEqual([])
  expect(svc.size).toBe(0)
  await vi.advanceTimersByTimeAsync(49 * HOUR_MS)
  expect(m.deleted).toEqual([])
})

test('quiet: an expiry of exactly 47h is still scheduled', async () => {
  const store = createStore()
  const { svc } = setup(new FakeNotifier(), {
    store,
    now: () => NOW,
    quiet: quietUntil(39 * HOUR_MS),
  })
  await svc.notify({ message: { text: 'hi', spans: [] }, attachment: undefined })
  expect(store.added.map((record) => record.expiresAtMs)).toEqual([NOW + 47 * HOUR_MS])
  expect(svc.size).toBe(1)
})

test('quietUntil is read once per notify', async () => {
  const quiet = quietUntil(HOUR_MS)
  const { svc } = setup(new FakeNotifier(), { now: () => NOW, quiet })
  await svc.notify({ message: { text: 'hi', spans: [] }, attachment: undefined })
  expect(quiet.quietUntil).toHaveBeenCalledTimes(1)
})

test('the attachment reaches sendNotification', async () => {
  const m = new FakeNotifier()
  const { svc } = setup(m)
  const attachment: Attachment = { name: 'changes.diff', content: new Uint8Array([1, 2, 3]) }
  await svc.notify({ message: { text: 'hi', spans: [] }, attachment })
  expect(m.attachments).toEqual([attachment])
  expect(m.attachments[0]).toBe(attachment)
})

test('a notification without an attachment passes undefined', async () => {
  const m = new FakeNotifier()
  const { svc } = setup(m)
  await svc.notify({ message: { text: 'hi', spans: [] }, attachment: undefined })
  expect(m.attachments).toEqual([undefined])
})
