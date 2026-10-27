import { afterEach, expect, test, vi } from 'vite-plus/test'
import { BotSupervisor } from '../../src/daemon/index.ts'
import type { RunningBot } from '../../src/daemon/index.ts'
import type { ApiBot } from '../../src/server/index.ts'

afterEach(() => {
  vi.useRealTimers()
})

type FakeRunning = RunningBot & {
  readonly stop: ReturnType<typeof vi.fn>
  readonly abandon: ReturnType<typeof vi.fn>
}

function createRunning(): FakeRunning {
  return {
    // The supervisor never looks inside the bot.
    bot: {} as ApiBot,
    recover: async () => undefined,
    forgetPerson: () => undefined,
    stop: vi.fn(async () => undefined),
    abandon: vi.fn(async () => undefined),
  }
}

function createRepeatingStart() {
  const runnings: FakeRunning[] = []
  const start = vi.fn<() => Promise<RunningBot>>(async () => {
    const running = createRunning()
    runnings.push(running)
    return running
  })
  return { start, runnings }
}

test('a bot that fails to start is retried with doubling backoff', async () => {
  vi.useFakeTimers()
  const running = createRunning()
  const start = vi
    .fn<() => Promise<RunningBot>>()
    .mockRejectedValueOnce(new Error('no network'))
    .mockRejectedValueOnce(new Error('still no network'))
    .mockResolvedValueOnce(running)
  const log = vi.fn()
  const supervisor = new BotSupervisor({ start, log })
  expect(supervisor.state).toEqual({ kind: 'starting' })
  await supervisor.run()
  expect(supervisor.state).toEqual({ kind: 'failed', reason: 'no network' })
  expect(log).toHaveBeenLastCalledWith("couldn't start: no network; retrying in 5s")
  await vi.advanceTimersByTimeAsync(4_999)
  expect(start).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(start).toHaveBeenCalledTimes(2)
  expect(supervisor.state).toEqual({ kind: 'failed', reason: 'still no network' })
  expect(log).toHaveBeenLastCalledWith("couldn't start: still no network; retrying in 10s")
  await vi.advanceTimersByTimeAsync(9_999)
  expect(start).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(start).toHaveBeenCalledTimes(3)
  expect(supervisor.state).toEqual({ kind: 'running', running })
  await supervisor.stop()
  expect(running.stop).toHaveBeenCalledTimes(1)
})

test('the backoff stops doubling at the max delay', async () => {
  vi.useFakeTimers()
  const start = vi.fn<() => Promise<RunningBot>>(async () => {
    throw new Error('down')
  })
  const log = vi.fn()
  const supervisor = new BotSupervisor({ start, log, initialDelayMs: 1_000, maxDelayMs: 3_000 })
  await supervisor.run()
  for (const delayMs of [1_000, 2_000, 3_000, 3_000]) {
    const callCount = start.mock.calls.length
    await vi.advanceTimersByTimeAsync(delayMs - 1)
    expect(start).toHaveBeenCalledTimes(callCount)
    await vi.advanceTimersByTimeAsync(1)
    expect(start).toHaveBeenCalledTimes(callCount + 1)
  }
  await supervisor.stop()
})

test('fatal abandons the runtime and retries; stop cancels the retry', async () => {
  vi.useFakeTimers()
  const first = createRunning()
  const second = createRunning()
  const start = vi
    .fn<() => Promise<RunningBot>>()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second)
  const log = vi.fn()
  const onRunning = vi.fn()
  const supervisor = new BotSupervisor({ start, log, onRunning })
  await supervisor.run()
  expect(supervisor.state).toEqual({ kind: 'running', running: first })
  expect(onRunning).toHaveBeenLastCalledWith(first)
  supervisor.fail('connection lost')
  expect(first.abandon).toHaveBeenCalledTimes(1)
  expect(first.stop).not.toHaveBeenCalled()
  expect(supervisor.state).toEqual({ kind: 'failed', reason: 'connection lost' })
  expect(log).toHaveBeenLastCalledWith('stopped: connection lost; retrying in 5s')
  await vi.advanceTimersByTimeAsync(5_000)
  expect(supervisor.state).toEqual({ kind: 'running', running: second })
  expect(onRunning).toHaveBeenLastCalledWith(second)
  await supervisor.stop()
  await vi.advanceTimersByTimeAsync(600_000)
  expect(start).toHaveBeenCalledTimes(2)
  expect(second.stop).toHaveBeenCalledTimes(1)
  expect(second.abandon).not.toHaveBeenCalled()
})

test('abandon ends the running bot without stopping it and cancels any retry', async () => {
  vi.useFakeTimers()
  const { start, runnings } = createRepeatingStart()
  const supervisor = new BotSupervisor({ start, log: vi.fn() })
  await supervisor.run()
  await supervisor.abandon()
  expect(runnings[0]?.abandon).toHaveBeenCalledTimes(1)
  expect(runnings[0]?.stop).not.toHaveBeenCalled()
  expect(supervisor.state).toEqual({ kind: 'failed', reason: 'stopped' })
  supervisor.fail('late fatal')
  await vi.advanceTimersByTimeAsync(600_000)
  expect(start).toHaveBeenCalledTimes(1)
})

test('a bot that fails right after starting keeps backing off', async () => {
  vi.useFakeTimers()
  const { start } = createRepeatingStart()
  const log = vi.fn()
  const supervisor = new BotSupervisor({ start, log })
  await supervisor.run()
  for (const delay of ['5s', '10s', '20s', '40s']) {
    supervisor.fail('another instance is polling')
    expect(log).toHaveBeenLastCalledWith(
      `stopped: another instance is polling; retrying in ${delay}`,
    )
    await vi.advanceTimersByTimeAsync(40_000)
    expect(supervisor.state.kind).toBe('running')
  }
  await supervisor.stop()
})

test('a bot that stayed running for the stable period starts over at the initial delay', async () => {
  vi.useFakeTimers()
  const { start } = createRepeatingStart()
  const log = vi.fn()
  const supervisor = new BotSupervisor({ start, log, stableMs: 60_000 })
  await supervisor.run()
  supervisor.fail('blip')
  await vi.advanceTimersByTimeAsync(5_000)
  supervisor.fail('blip')
  expect(log).toHaveBeenLastCalledWith('stopped: blip; retrying in 10s')
  await vi.advanceTimersByTimeAsync(10_000)
  // Stable means the longer of the stable period and the delay it took to get here.
  await vi.advanceTimersByTimeAsync(59_999)
  supervisor.fail('blip')
  expect(log).toHaveBeenLastCalledWith('stopped: blip; retrying in 20s')
  await vi.advanceTimersByTimeAsync(20_000)
  await vi.advanceTimersByTimeAsync(60_000)
  supervisor.fail('blip')
  expect(log).toHaveBeenLastCalledWith('stopped: blip; retrying in 5s')
  await supervisor.stop()
})

test('a fatal while already failed is ignored', async () => {
  vi.useFakeTimers()
  const start = vi.fn<() => Promise<RunningBot>>(async () => {
    throw new Error('down')
  })
  const log = vi.fn()
  const supervisor = new BotSupervisor({ start, log })
  await supervisor.run()
  supervisor.fail('late fatal from an old runtime')
  expect(supervisor.state).toEqual({ kind: 'failed', reason: 'down' })
  await vi.advanceTimersByTimeAsync(5_000)
  expect(start).toHaveBeenCalledTimes(2)
  await supervisor.stop()
})

test('a bot that finishes starting after stop is stopped at once', async () => {
  const running = createRunning()
  const { promise, resolve } = Promise.withResolvers<RunningBot>()
  const onRunning = vi.fn()
  const supervisor = new BotSupervisor({ start: () => promise, log: vi.fn(), onRunning })
  const started = supervisor.run()
  await supervisor.stop()
  resolve(running)
  await started
  expect(running.stop).toHaveBeenCalledTimes(1)
  expect(supervisor.state.kind).not.toBe('running')
  expect(onRunning).not.toHaveBeenCalled()
})
