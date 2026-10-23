import { expect, test } from 'vite-plus/test'
import { runStep } from '../../src/progress/index.ts'
import { createRecordingProgress } from './recording.ts'

test('a step that resolves succeeds and returns the value', async () => {
  const { progress, events } = createRecordingProgress()
  const value = await runStep(progress, 'Working', async (step) => {
    step.output('line\n')
    return 42
  })
  expect(value).toBe(42)
  expect(events).toEqual(['start:Working', 'output:line\n', 'succeed:Working'])
})

test('settle decides how a resolved step ends', async () => {
  const { progress, events } = createRecordingProgress()
  await runStep(progress, 'Checking', async () => 'v1.2.3', {
    settle: (step, version) => step.succeed(`Latest is ${version}`),
  })
  expect(events).toEqual(['start:Checking', 'succeed:Latest is v1.2.3'])
})

test('a step that throws fails and rethrows', async () => {
  const { progress, events } = createRecordingProgress()
  const failing = runStep(progress, 'Working', async () => {
    throw new Error('boom')
  })
  await expect(failing).rejects.toThrow('boom')
  expect(events).toEqual(['start:Working', 'fail:Working'])
})

test('a step that throws after the signal aborted is cancelled', async () => {
  const { progress, events } = createRecordingProgress()
  const controller = new AbortController()
  const failing = runStep(
    progress,
    'Working',
    async () => {
      controller.abort()
      throw new Error('interrupted')
    },
    { signal: controller.signal },
  )
  await expect(failing).rejects.toThrow('interrupted')
  expect(events).toEqual(['start:Working', 'cancel:Working'])
})

test('consecutive steps each end before the next one starts', async () => {
  const { progress, events } = createRecordingProgress()
  await runStep(progress, 'One', async () => 1)
  await runStep(progress, 'Two', async () => 2)
  expect(events).toEqual(['start:One', 'succeed:One', 'start:Two', 'succeed:Two'])
})
