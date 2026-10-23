import type { Progress, ProgressMode, ProgressStep } from '../../src/progress/index.ts'

/** A Progress that records what it was asked to draw, for command tests. */
export function createRecordingProgress(mode: ProgressMode = 'live'): {
  readonly progress: Progress
  readonly events: string[]
  readonly notes: () => string[]
} {
  const events: string[] = []
  let isRunning = false
  const progress: Progress = {
    mode,
    plan: (titles) => {
      events.push(`plan:${titles.join('|')}`)
    },
    done: (title) => {
      events.push(`done:${title}`)
    },
    // Mirrors the real renderer: one step at a time, and a finished step ignores later calls.
    start: (title): ProgressStep => {
      if (isRunning) {
        throw new RangeError('a progress step is already running')
      }
      isRunning = true
      let isFinished = false
      const startTitle = typeof title === 'function' ? title() : title
      events.push(`start:${startTitle}`)
      const record = (event: string): void => {
        if (!isFinished) {
          events.push(event)
        }
      }
      const settle = (event: string): void => {
        record(event)
        if (!isFinished) {
          isFinished = true
          isRunning = false
        }
      }
      return {
        detail: (text) => record(`detail:${text}`),
        output: (chunk) => record(`output:${chunk}`),
        succeed: (finalTitle) => settle(`succeed:${finalTitle ?? startTitle}`),
        fail: (finalTitle) => settle(`fail:${finalTitle ?? startTitle}`),
        cancel: (finalTitle) => settle(`cancel:${finalTitle ?? startTitle}`),
      }
    },
    note: (text) => {
      events.push(`note:${text}`)
    },
  }
  const notes = (): string[] =>
    events.filter((event) => event.startsWith('note:')).map((event) => event.slice('note:'.length))
  return { progress, events, notes }
}
