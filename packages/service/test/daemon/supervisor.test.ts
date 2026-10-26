import { afterEach, expect, test, vi } from 'vite-plus/test'
import { PairingCodes } from '@jaypost/core'
import { BotSupervisor } from '../../src/daemon/index.ts'
import type { RunningBot } from '../../src/daemon/index.ts'
import type { ApiBot } from '../../src/server/index.ts'

afterEach(() => {
  vi.useRealTimers()
})

type FakeRunning = RunningBot & { readonly stop: ReturnType<typeof vi.fn> }

function createRunning(): FakeRunning {
  return {
    // The supervisor never looks inside the bot.
    bot: {} as ApiBot,
    codes: new PairingCodes(),
    recover: async () => undefined,
    stop: vi.fn(async () => undefined),
  }
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

test('fatal stops the runtime and retries; stop cancels the retry', async () => {
  vi.useFakeTimers()
  const first = createRunning()
  const second = createRunning()
  const start = vi
    .fn<() => Promise<RunningBot>>()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second)
  const log = vi.fn()
  const supervisor = new BotSupervisor({ start, log })
  await supervisor.run()
  expect(supervisor.state).toEqual({ kind: 'running', running: first })
  supervisor.fail('connection lost')
  expect(first.stop).toHaveBeenCalledTimes(1)
  expect(supervisor.state).toEqual({ kind: 'failed', reason: 'connection lost' })
  expect(log).toHaveBeenLastCalledWith('stopped: connection lost; retrying in 5s')
  await vi.advanceTimersByTimeAsync(5_000)
  expect(supervisor.state).toEqual({ kind: 'running', running: second })
  // A successful start resets the backoff.
  supervisor.fail('connection lost again')
  expect(log).toHaveBeenLastCalledWith('stopped: connection lost again; retrying in 5s')
  await supervisor.stop()
  await vi.advanceTimersByTimeAsync(600_000)
  expect(start).toHaveBeenCalledTimes(2)
  expect(second.stop).toHaveBeenCalledTimes(1)
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
  const supervisor = new BotSupervisor({ start: () => promise, log: vi.fn() })
  const started = supervisor.run()
  await supervisor.stop()
  resolve(running)
  await started
  expect(running.stop).toHaveBeenCalledTimes(1)
  expect(supervisor.state.kind).not.toBe('running')
})
