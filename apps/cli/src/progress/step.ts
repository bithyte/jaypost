import type { Progress, ProgressStep, StepOptions } from './types.ts'

/**
 * Starts `title` and runs `work` with the step. When `work` resolves the step ends with `settle`
 * (default `succeed()`); when it throws the step is cancelled if `signal` has aborted, failed
 * otherwise, and the error is rethrown. Either way no step is left running.
 */
export async function runStep<T>(
  progress: Progress,
  title: string,
  work: (step: ProgressStep) => Promise<T>,
  options: StepOptions<T> = {},
): Promise<T> {
  const step = progress.start(title)
  let value: T
  try {
    value = await work(step)
  } catch (error) {
    if (options.signal?.aborted === true) {
      step.cancel()
    } else {
      step.fail()
    }
    throw error
  }
  if (options.settle === undefined) {
    step.succeed()
  } else {
    options.settle(step, value)
  }
  return value
}
