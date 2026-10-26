import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import { ApprovalService, OWNER_COMMANDS, runOwnerCommand } from '../../src/approval/index.ts'
import type { ApprovalRequest } from '../../src/approval/index.ts'

const AT = new Date(2026, 0, 1, 9, 5)
const OPTIONS = { now: () => AT, maxTextLength: 3900 }
const REQUEST: ApprovalRequest = {
  message: { text: 'Deploy?', spans: [] },
  question: 'Deploy?',
  options: ['Approve', 'Decline'],
  timeoutOption: 'Decline',
  allowText: false,
  timeoutSeconds: 300,
  attachment: undefined,
}

const flush = () => vi.advanceTimersByTimeAsync(0)

function createService(): ApprovalService {
  let counter = 0
  return new ApprovalService(
    { sendRequest: async () => ({}) },
    () => AT,
    () => `id${(counter += 1)}`,
  )
}

async function settleAnswered(service: ApprovalService, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const result = service.request(REQUEST)
    await flush()
    const [open] = service.listPending(undefined)
    service.tap(open?.id ?? '', 0)
    await result
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

test('pending lists open requests', async () => {
  const service = createService()
  void service.request(REQUEST)
  await flush()
  expect(runOwnerCommand(service, 'pending', '', undefined, OPTIONS)?.startsWith('1 pending')).toBe(
    true,
  )
})

test('cancel rejects everything and replies with what it rejected', async () => {
  const service = createService()
  const first = service.request(REQUEST)
  const second = service.request({ ...REQUEST, message: { text: 'Push?', spans: [] } })
  await flush()
  const reply = runOwnerCommand(service, 'cancel', '', undefined, OPTIONS)
  expect(reply).toBe('Rejected 2\n\nDeploy?\n→ Decline\n\nPush?\n→ Decline')
  const expected = { kind: 'completed', outcome: { answer: 'Decline', timedOut: false } }
  await expect(first).resolves.toEqual(expected)
  await expect(second).resolves.toEqual(expected)
  expect(service.listPending(undefined)).toEqual([])
})

test('cancel with nothing open says so', () => {
  expect(runOwnerCommand(createService(), 'cancel', '', undefined, OPTIONS)).toBe(
    'Nothing pending.',
  )
})

test('history defaults to 10', async () => {
  const service = createService()
  await settleAnswered(service, 12)
  expect(
    runOwnerCommand(service, 'history', '', undefined, OPTIONS)?.startsWith('Last 10\n\n'),
  ).toBe(true)
})

test('history argument cases', async () => {
  const service = createService()
  await settleAnswered(service, 25)
  const cases = [
    ['5', 'Last 5'],
    [' 5 ', 'Last 5'],
    ['50', 'Last 20'],
    ['99999999999999999999', 'Last 20'],
  ] as const
  for (const [argument, header] of cases) {
    expect(runOwnerCommand(service, 'history', argument, undefined, OPTIONS)?.split('\n')[0]).toBe(
      header,
    )
  }
  for (const argument of ['0', '-3', 'abc', '2.5', '3 4']) {
    expect(runOwnerCommand(service, 'history', argument, undefined, OPTIONS)).toBe(
      'Usage: /history [1-20]',
    )
  }
})

test('history header counts what was shown', async () => {
  const service = createService()
  await settleAnswered(service, 1)
  expect(
    runOwnerCommand(service, 'history', '5', undefined, OPTIONS)?.startsWith('Last 1\n\n'),
  ).toBe(true)
})

test('history with nothing recorded', () => {
  expect(runOwnerCommand(createService(), 'history', '', undefined, OPTIONS)).toBe(
    'No answers since the service started.',
  )
})

test('unknown name returns undefined', () => {
  for (const name of ['start', 'mute', '']) {
    expect(runOwnerCommand(createService(), name, '', undefined, OPTIONS)).toBeUndefined()
  }
})

test("pending, cancel and history with recipient 'A' leave 'B' out", async () => {
  const service = createService()
  const toA = service.request({ ...REQUEST, recipient: 'A' })
  const toB = service.request({
    ...REQUEST,
    message: { text: 'Push?', spans: [] },
    recipient: 'B',
  })
  await flush()
  const pending = runOwnerCommand(service, 'pending', '', 'A', OPTIONS)
  expect(pending?.startsWith('1 pending')).toBe(true)
  expect(pending).toContain('Deploy?')
  expect(pending).not.toContain('Push?')
  expect(runOwnerCommand(service, 'cancel', '', 'A', OPTIONS)).toBe(
    'Rejected 1\n\nDeploy?\n→ Decline',
  )
  await toA
  expect(service.listPending('B').map((summary) => summary.request.recipient)).toEqual(['B'])
  const [openB] = service.listPending('B')
  service.tap(openB?.id ?? '', 0)
  await toB
  const history = runOwnerCommand(service, 'history', '', 'A', OPTIONS)
  expect(history?.startsWith('Last 1\n\n')).toBe(true)
  expect(history).toContain('Deploy?')
  expect(history).not.toContain('Push?')
})

test('OWNER_COMMANDS names and order', () =>
  expect(OWNER_COMMANDS.map((command) => command.name)).toEqual(['pending', 'cancel', 'history']))
