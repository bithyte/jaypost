/* eslint-disable no-control-regex -- the tests match terminal escape sequences */
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test'
import {
  SILENT_PROGRESS,
  createProgress,
  type ProgressMode,
  type ProgressStream,
} from '../../src/progress/index.ts'

type FakeStream = ProgressStream & { readonly chunks: string[] }

function createStream(columns = 40, isTTY = true): FakeStream {
  const chunks: string[] = []
  return {
    chunks,
    write: (text: string) => chunks.push(text),
    isTTY,
    columns,
  }
}

function createClock(): { readonly now: () => number; readonly set: (value: number) => void } {
  let current = 0
  return {
    now: () => current,
    set: (value) => {
      current = value
    },
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

// Replays cursor-up and clear-to-end over a line buffer: what the user ends up seeing.
function finalScreen(chunks: readonly string[]): string[] {
  const lines: string[] = []
  let cursor = 0
  for (const chunk of chunks) {
    for (const part of chunk.split(/(\x1b\[\d+A|\x1b\[0J)/)) {
      const up = /^\x1b\[(\d+)A$/.exec(part)
      if (up !== null) {
        cursor -= Number(up[1])
      } else if (part === '\x1b[0J') {
        lines.length = cursor
      } else if (part !== '') {
        const text = stripAnsi(part)
        if (text === '') {
          continue
        }
        for (const line of text.split('\n').slice(0, -1)) {
          lines[cursor] = line
          cursor += 1
        }
      }
    }
  }
  return lines
}

function setup(mode: ProgressMode = 'live', columns = 40, env: NodeJS.ProcessEnv = {}) {
  const stream = createStream(columns, mode !== 'silent')
  const clock = createClock()
  const progress = createProgress({ stream, mode, env, now: clock.now })
  return { stream, clock, progress }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

test('a finished checklist leaves one line per step with durations', () => {
  const { stream, clock, progress } = setup()
  progress.plan(['Building image', 'Starting service'])
  progress.done('Port 8787 is free')
  const build = progress.start('Building image')
  clock.set(108_000)
  build.succeed('Built image')
  const service = progress.start('Starting service')
  clock.set(110_000)
  service.succeed('Service started')
  expect(finalScreen(stream.chunks)).toEqual([
    '◇ Port 8787 is free',
    '◇ Built image 1:48',
    '◇ Service started 0:02',
  ])
})

test('a running step shows its spinner, the last four output lines and the pending steps', () => {
  const { stream, progress } = setup()
  progress.plan(['Building image', 'Starting service'])
  const build = progress.start('Building image')
  build.output('one\ntwo\nthree\nfour\nfive\n')
  vi.advanceTimersByTime(120)
  expect(finalScreen(stream.chunks)).toEqual([
    '◒ Building image 0:00',
    '│  two',
    '│  three',
    '│  four',
    '│  five',
    '○ Starting service',
  ])
})

test('detail lines draw under the step and disappear when it finishes', () => {
  const { stream, progress } = setup()
  const step = progress.start('Waiting')
  step.detail('Pairing code: 482-913')
  vi.advanceTimersByTime(120)
  expect(finalScreen(stream.chunks)).toEqual(['◒ Waiting 0:00', '│  Pairing code: 482-913'])
  step.succeed('Paired')
  expect(finalScreen(stream.chunks)).toEqual(['◇ Paired 0:00'])
})

test('a multi-line detail draws one rail line per line and redraws cleanly', () => {
  const { stream, progress } = setup()
  progress.plan(['Next'])
  const step = progress.start('Waiting')
  step.detail('Pairing code: 482-913\nSend it to the bot')
  vi.advanceTimersByTime(360)
  expect(finalScreen(stream.chunks)).toEqual([
    '◓ Waiting 0:00',
    '│  Pairing code: 482-913',
    '│  Send it to the bot',
    '○ Next',
  ])
  step.succeed('Paired')
  expect(finalScreen(stream.chunks)).toEqual(['◇ Paired 0:00', '○ Next'])
})

test('a function title is redrawn as returned with no elapsed time', () => {
  const { stream, clock, progress } = setup()
  let remaining = 5
  const step = progress.start(() => `Waiting, ${remaining}s left`)
  expect(finalScreen(stream.chunks)).toEqual(['◒ Waiting, 5s left'])
  remaining = 4
  clock.set(1_000)
  vi.advanceTimersByTime(120)
  expect(finalScreen(stream.chunks)).toEqual(['◒ Waiting, 4s left'])
  step.succeed('Answered')
  expect(finalScreen(stream.chunks)).toEqual(['◇ Answered'])
})

test('a failed step prints every output line under it', () => {
  const { stream, progress } = setup()
  const build = progress.start('Building image')
  build.output('one\ntwo\nthree\nfour\nfive\n')
  build.fail()
  expect(finalScreen(stream.chunks)).toEqual([
    '■ Building image',
    '│  one',
    '│  two',
    '│  three',
    '│  four',
    '│  five',
  ])
})

test('a cancelled step prints the cancel mark', () => {
  const { stream, progress } = setup()
  progress.start('Waiting').cancel('Cancelled')
  expect(finalScreen(stream.chunks)).toEqual(['◆ Cancelled'])
})

test('a failed step drops the pending steps', () => {
  const { stream, progress } = setup()
  progress.plan(['Building image', 'Starting service', 'Checking health'])
  progress.start('Building image').fail()
  expect(finalScreen(stream.chunks)).toEqual(['■ Building image'])
})

test('a cancelled step drops the pending steps', () => {
  const { stream, progress } = setup()
  progress.plan(['Waiting', 'Next'])
  progress.start('Waiting').cancel('Cancelled')
  expect(finalScreen(stream.chunks)).toEqual(['◆ Cancelled'])
})

test('a note printed while a step runs stays once above the redrawn region', () => {
  const { stream, progress } = setup()
  progress.plan(['Next'])
  const step = progress.start('Waiting')
  progress.note('Pairing code: 482-913\nhttps://example.test/very/long/pairing/url/that/overflows')
  vi.advanceTimersByTime(360)
  const screen = finalScreen(stream.chunks)
  expect(screen).toEqual([
    'Pairing code: 482-913',
    'https://example.test/very/long/pairing/url/that/overflows',
    '◓ Waiting 0:00',
    '○ Next',
  ])
  expect(stream.chunks.join('').split('Pairing code: 482-913')).toHaveLength(2)
  step.succeed('Paired')
  expect(finalScreen(stream.chunks)).toEqual([
    'Pairing code: 482-913',
    'https://example.test/very/long/pairing/url/that/overflows',
    '◇ Paired 0:00',
    '○ Next',
  ])
})

test('a note while a step runs prints above the live region', () => {
  const { stream, progress } = setup()
  progress.plan(['Next'])
  const step = progress.start('Running')
  progress.note('heads up')
  expect(finalScreen(stream.chunks)).toEqual(['heads up', '◒ Running 0:00', '○ Next'])
  step.succeed()
  expect(finalScreen(stream.chunks)).toEqual(['heads up', '◇ Running 0:00', '○ Next'])
})

test('lines are cut to the terminal width', () => {
  const { stream, progress } = setup('live', 20)
  const step = progress.start('A very long step title that overflows')
  step.output('x'.repeat(50) + '\n')
  vi.advanceTimersByTime(120)
  const screen = finalScreen(stream.chunks)
  expect(screen).toEqual(['◒ A very long step ', `│  ${'x'.repeat(16)}`])
})

test('carriage returns in output start a new tail line', () => {
  const { stream, progress } = setup()
  const step = progress.start('Downloading')
  step.output('a\rb\rc\n')
  vi.advanceTimersByTime(120)
  expect(finalScreen(stream.chunks)).toEqual(['◒ Downloading 0:00', '│  c'])
})

test('an escape sequence split across output chunks is stripped', () => {
  const { stream, progress } = setup()
  const step = progress.start('Building')
  step.output('\x1b[3')
  vi.advanceTimersByTime(120)
  step.output('2mgreen\x1b[0m\n')
  step.fail()
  expect(stream.chunks.join('')).not.toContain('\x1b[3\n')
  expect(stream.chunks.join('')).not.toContain('\x1b[32m')
  expect(finalScreen(stream.chunks)).toEqual(['■ Building', '│  green'])
})

test('a stream that throws on write does not break the step', () => {
  const clock = createClock()
  const progress = createProgress({
    stream: {
      isTTY: true,
      columns: 40,
      write: () => {
        throw new Error('EPIPE')
      },
    },
    mode: 'live',
    env: {},
    now: clock.now,
  })
  const step = progress.start('Working')
  step.output('line\n')
  vi.advanceTimersByTime(240)
  expect(() => step.succeed()).not.toThrow()
  expect(() => progress.note('still fine')).not.toThrow()
})

test('plain mode writes only finished lines with no escapes', () => {
  const { stream, clock, progress } = setup('plain')
  progress.plan(['Building image', 'Starting service'])
  progress.done('Port 8787 is free')
  const build = progress.start('Building image')
  build.detail('hidden')
  clock.set(108_000)
  build.succeed('Built image')
  const service = progress.start('Starting service')
  service.output('boom\n')
  service.fail()
  expect(stream.chunks.join('')).toBe(
    '◇ Port 8787 is free\n◇ Built image 1:48\n■ Starting service\n│  boom\n',
  )
})

test('plain mode prints cancel and note lines', () => {
  const { stream, progress } = setup('plain')
  progress.note('hello')
  progress.start('Waiting').cancel('Cancelled')
  expect(stream.chunks.join('')).toBe('hello\n◆ Cancelled\n')
})

test('NO_COLOR leaves no color codes but keeps cursor movement', () => {
  const { stream, progress } = setup('live', 40, { NO_COLOR: '1' })
  progress.plan(['Next'])
  const step = progress.start('Running')
  vi.advanceTimersByTime(120)
  step.succeed('Ran')
  const text = stream.chunks.join('')
  expect(text).not.toMatch(/\x1b\[3|\x1b\[9|\x1b\[2m/)
  expect(text).toContain('\x1b[0J')
  expect(finalScreen(stream.chunks)).toEqual(['◇ Ran 0:00', '○ Next'])
})

test('color is applied in live mode when NO_COLOR is unset', () => {
  const { stream, progress } = setup()
  progress.start('Running').succeed()
  expect(stream.chunks.join('')).toMatch(/\x1b\[3\dm/)
})

test('live mode hides the cursor while a step runs and restores it after', () => {
  const { stream, progress } = setup()
  const step = progress.start('Running')
  expect(stream.chunks.join('')).toContain('\x1b[?25l')
  expect(stream.chunks.join('')).not.toContain('\x1b[?25h')
  step.succeed()
  expect(stream.chunks.join('')).toContain('\x1b[?25h')
})

test('the frame timer stops when the step finishes', () => {
  const { progress } = setup()
  const step = progress.start('Running')
  expect(vi.getTimerCount()).toBe(1)
  step.succeed()
  expect(vi.getTimerCount()).toBe(0)
})

test('starting a step while one runs throws a RangeError', () => {
  const { progress } = setup()
  progress.start('One')
  expect(() => progress.start('Two')).toThrow(new RangeError('a progress step is already running'))
})

test('the silent progress writes nothing', () => {
  expect(SILENT_PROGRESS.mode).toBe('silent')
  SILENT_PROGRESS.plan(['a'])
  SILENT_PROGRESS.done('b')
  SILENT_PROGRESS.note('c')
  const step = SILENT_PROGRESS.start('d')
  step.detail('e')
  step.output('f')
  step.succeed()
  step.fail()
  step.cancel()
  const { stream, progress } = setup('silent')
  progress.start('x').succeed()
  progress.note('y')
  expect(stream.chunks).toEqual([])
})
