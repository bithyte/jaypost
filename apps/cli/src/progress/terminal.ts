import { styleText } from 'node:util'
import {
  ANSI_PATTERN,
  CANCEL_SYMBOL,
  CLEAR_TO_END,
  DEFAULT_COLUMNS,
  DONE_SYMBOL,
  FAIL_SYMBOL,
  FRAME_INTERVAL_MS,
  HIDE_CURSOR,
  PARTIAL_ANSI_PATTERN,
  PENDING_SYMBOL,
  RAIL,
  SHOW_CURSOR,
  SPINNER_FRAMES,
  TAIL_LINE_COUNT,
} from './constants.ts'
import { formatDuration } from './format.ts'
import type { Progress, ProgressMode, ProgressOptions, ProgressStep } from './types.ts'

type Style = 'green' | 'red' | 'cyan' | 'dim'

type RunningStep = {
  readonly title: string | (() => string)
  readonly startedAtMs: number
  readonly details: string[]
  readonly lines: string[]
  partialLine: string
  frameIndex: number
  timer: ReturnType<typeof setInterval> | undefined
}

const NO_OP = (): void => {}

const SILENT_STEP: ProgressStep = {
  detail: NO_OP,
  output: NO_OP,
  succeed: NO_OP,
  fail: NO_OP,
  cancel: NO_OP,
}

/** Mode `silent`: every method does nothing, `start` returns a step that does nothing. */
export const SILENT_PROGRESS: Progress = {
  mode: 'silent',
  plan: NO_OP,
  done: NO_OP,
  start: () => SILENT_STEP,
  note: NO_OP,
}

/**
 * `live` only on a TTY that is not `TERM=dumb` and not CI; otherwise `fallback`.
 * Never throws.
 */
export function resolveProgressMode(
  stream: { readonly isTTY?: boolean },
  env: NodeJS.ProcessEnv,
  fallback: 'plain' | 'silent',
): ProgressMode {
  if (stream.isTTY === true && env.TERM !== 'dumb' && !isSet(env.CI)) {
    return 'live'
  }
  return fallback
}

/**
 * Draws a checklist on `stream`. Write errors are swallowed so a closed pipe never breaks the
 * command. Color only in `live` mode and only when `NO_COLOR` is empty or unset.
 */
export function createProgress(options: ProgressOptions): Progress {
  if (options.mode === 'silent') {
    return SILENT_PROGRESS
  }
  const { stream, mode } = options
  const now = options.now ?? Date.now
  const isLive = mode === 'live'
  const useColor = isLive && !isSet((options.env ?? process.env).NO_COLOR)
  const maxLineLength = (stream.columns ?? DEFAULT_COLUMNS) - 1
  let pending: readonly string[] = []
  let running: RunningStep | undefined
  let drawnLineCount = 0

  const paint = (text: string, style: Style): string =>
    useColor ? styleText(style, text, { validateStream: false }) : text

  // Cut before coloring so escape codes never count toward the width.
  const fit = (symbol: string, symbolStyle: Style, text: string, suffix: string): string => {
    const head = `${symbol} ${text}`.slice(0, maxLineLength)
    const tail = suffix.slice(0, Math.max(0, maxLineLength - head.length))
    const coloredTail = tail === '' ? '' : paint(tail, 'dim')
    return (
      paint(head.slice(0, symbol.length), symbolStyle) + head.slice(symbol.length) + coloredTail
    )
  }

  const write = (text: string): void => {
    try {
      stream.write(text)
    } catch {
      // A closed pipe or terminal (EPIPE, EIO) must not turn a progress line into a crash.
    }
  }

  const regionLines = (): readonly string[] => {
    const lines: string[] = []
    if (running !== undefined) {
      const title = typeof running.title === 'function' ? running.title() : running.title
      const elapsed =
        typeof running.title === 'function' ? '' : ` ${formatDuration(now() - running.startedAtMs)}`
      lines.push(
        fit(
          SPINNER_FRAMES[running.frameIndex % SPINNER_FRAMES.length] ?? '',
          'cyan',
          title,
          elapsed,
        ),
      )
      for (const text of [...running.details, ...flushOutput(running).slice(-TAIL_LINE_COUNT)]) {
        lines.push(fitRail(text))
      }
    }
    for (const title of pending) {
      lines.push(fit(PENDING_SYMBOL, 'dim', title, ''))
    }
    return lines
  }

  const fitRail = (text: string): string => {
    const line = (RAIL + text).slice(0, maxLineLength)
    return paint(line.slice(0, RAIL.length), 'dim') + line.slice(RAIL.length)
  }

  const clearRegion = (): void => {
    if (drawnLineCount === 0) {
      return
    }
    write(`\x1b[${drawnLineCount}A${CLEAR_TO_END}`)
    drawnLineCount = 0
  }

  const drawRegion = (): void => {
    const lines = regionLines()
    drawnLineCount = lines.length
    if (lines.length > 0) {
      write(lines.map((line) => `${line}\n`).join(''))
    }
  }

  // Permanent text goes above the region: wipe the region, print, put it back.
  const printAbove = (text: string): void => {
    if (isLive) {
      clearRegion()
    }
    write(text)
    if (isLive) {
      drawRegion()
    }
  }

  const printPermanent = (lines: readonly string[]): void => {
    printAbove(lines.map((line) => `${line}\n`).join(''))
  }

  const markedLine = (symbol: string, style: Style, title: string, suffix = ''): string =>
    `${paint(symbol, style)} ${title}${suffix === '' ? '' : paint(suffix, 'dim')}`

  const finish = (step: RunningStep, lines: readonly string[]): void => {
    if (step.timer !== undefined) {
      clearInterval(step.timer)
    }
    running = undefined
    if (isLive) {
      clearRegion()
      write(SHOW_CURSOR)
    }
    printPermanent(lines)
  }

  const start = (title: string | (() => string)): ProgressStep => {
    if (running !== undefined) {
      throw new RangeError('a progress step is already running')
    }
    if (typeof title === 'string') {
      const index = pending.indexOf(title)
      if (index !== -1) {
        pending = pending.filter((_entry, position) => position !== index)
      }
    }
    const step: RunningStep = {
      title,
      startedAtMs: now(),
      details: [],
      lines: [],
      partialLine: '',
      frameIndex: 0,
      timer: undefined,
    }
    running = step
    if (isLive) {
      clearRegion()
      write(HIDE_CURSOR)
      drawRegion()
      step.timer = setInterval(() => {
        clearRegion()
        drawRegion()
        step.frameIndex += 1
      }, FRAME_INTERVAL_MS)
      step.timer.unref()
    }
    const resolveTitle = (finalTitle: string | undefined): string =>
      finalTitle ?? (typeof title === 'function' ? title() : title)
    const isCurrent = (): boolean => running === step
    return {
      // One region line per text line: a line feed inside a line would desync the redraw count.
      detail: (text) => {
        if (isCurrent()) {
          step.details.push(...text.split('\n'))
        }
      },
      output: (chunk) => {
        if (isCurrent()) {
          appendOutput(step, chunk)
        }
      },
      succeed: (finalTitle) => {
        if (!isCurrent()) {
          return
        }
        const suffix =
          typeof title === 'string' ? ` ${formatDuration(now() - step.startedAtMs)}` : ''
        finish(step, [markedLine(DONE_SYMBOL, 'green', resolveTitle(finalTitle), suffix)])
      },
      fail: (finalTitle) => {
        if (!isCurrent()) {
          return
        }
        const outputLines = flushOutput(step)
        // Nothing planned runs after a failure, so its pending lines would only linger.
        pending = []
        finish(step, [
          markedLine(FAIL_SYMBOL, 'red', resolveTitle(finalTitle)),
          ...outputLines.map((line) => paint(RAIL, 'dim') + line),
        ])
      },
      cancel: (finalTitle) => {
        if (!isCurrent()) {
          return
        }
        pending = []
        finish(step, [markedLine(CANCEL_SYMBOL, 'red', resolveTitle(finalTitle))])
      },
    }
  }

  return {
    mode,
    plan: (titles) => {
      if (!isLive) {
        return
      }
      pending = [...pending, ...titles]
      clearRegion()
      drawRegion()
    },
    done: (title) => {
      printPermanent([markedLine(DONE_SYMBOL, 'green', title)])
    },
    start,
    // Not cut to the width like rail lines, so long URLs stay whole. An empty note only ends a
    // line, such as the one ^C was echoed on, so it gets no rail.
    note: (text) => {
      if (text === '') {
        printAbove('\n')
        return
      }
      printAbove(`${formatOnRail(text, useColor)}\n`)
    },
  }
}

/** Every line of `text` behind the checklist rail, dimmed when `useColor`; never cut to a width. */
export function formatOnRail(text: string, useColor: boolean): string {
  const rail = useColor ? styleText('dim', RAIL, { validateStream: false }) : RAIL
  return text
    .split('\n')
    .map((line) => rail + line)
    .join('\n')
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== ''
}

// A carriage return rewinds the line, so only the text after the last one is what the user saw.
// Escapes are stripped from finished lines only, since one can arrive split across two chunks.
function appendOutput(step: RunningStep, chunk: string): void {
  const parts = (step.partialLine + chunk).split('\n')
  step.partialLine = parts.pop() ?? ''
  for (const part of parts) {
    step.lines.push(lastSegment(cleanOutput(part)))
  }
}

function cleanOutput(text: string): string {
  return text.replace(ANSI_PATTERN, '').replaceAll('\t', '  ')
}

// The unfinished line may end in half an escape sequence; the next chunk completes it.
function flushOutput(step: RunningStep): readonly string[] {
  const rest = lastSegment(cleanOutput(step.partialLine).replace(PARTIAL_ANSI_PATTERN, ''))
  return rest === '' ? step.lines : [...step.lines, rest]
}

function lastSegment(line: string): string {
  const segments = line.split('\r').filter((segment) => segment !== '')
  return segments.at(-1) ?? ''
}
