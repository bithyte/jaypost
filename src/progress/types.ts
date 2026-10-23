/** `live` redraws in place, `plain` prints finished lines only, `silent` prints nothing. */
export type ProgressMode = 'live' | 'plain' | 'silent'

/** The slice of a writable stream the renderer needs; `write` may throw (EPIPE, EIO). */
export type ProgressStream = {
  readonly write: (text: string) => unknown
  readonly isTTY?: boolean
  readonly columns?: number
}

/** The one step that runs at a time; every method after `succeed`, `fail` or `cancel` is moot. */
export type ProgressStep = {
  /** Shows text under the step until it finishes, one line per line feed; live mode only. */
  readonly detail: (text: string) => void
  /** Feeds raw subprocess output; the last lines show as a tail and `fail` prints all of it. */
  readonly output: (chunk: string) => void
  readonly succeed: (title?: string) => void
  readonly fail: (title?: string) => void
  readonly cancel: (title?: string) => void
}

/** A checklist on a stream: pending steps, one running step, permanent finished lines. */
export type Progress = {
  readonly mode: ProgressMode
  /** Lists steps as pending; `start` with an equal string title takes the entry off. */
  readonly plan: (titles: readonly string[]) => void
  /** Prints an already finished step. */
  readonly done: (title: string) => void
  /** Throws `RangeError` while another step runs. A function title is redrawn each frame. */
  readonly start: (title: string | (() => string)) => ProgressStep
  /** Prints permanent text above the live region, each line on the rail; `''` prints a bare line feed. */
  readonly note: (text: string) => void
}

export type ProgressOptions = {
  readonly stream: ProgressStream
  readonly mode: ProgressMode
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => number
}

/** How `runStep` ends its step. */
export type StepOptions<T> = {
  /** Ends the step once the work resolved; the default is `succeed()`. */
  readonly settle?: (step: ProgressStep, value: T) => void
  /** Aborted by the time the work throws means the step is cancelled instead of failed. */
  readonly signal?: AbortSignal
}
