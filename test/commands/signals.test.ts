import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vite-plus/test'

const COMMANDS_URL = new URL('../../src/commands/index.ts', import.meta.url).href

type ChildResult = {
  readonly stdout: string
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

// A child that waits until its controller aborts, so the test can signal it mid-wait.
function childScript(reraised: readonly NodeJS.Signals[]): string {
  return `
import { runWithSignals } from ${JSON.stringify(COMMANDS_URL)}
const code = await runWithSignals(
  async (controller) => {
    // Signal handlers don't hold the event loop open; real commands have pending I/O instead.
    const keepAlive = setInterval(() => {}, 1000)
    process.stdout.write('ready\\n')
    await new Promise((resolve) => controller.signal.addEventListener('abort', resolve))
    clearInterval(keepAlive)
    process.stdout.write('aborted\\n')
    return 7
  },
  ['SIGINT', 'SIGTERM', 'SIGHUP'],
  ${JSON.stringify(reraised)},
)
process.stdout.write('settled ' + code + '\\n')
process.exitCode = code
`
}

function runChild(reraised: readonly NodeJS.Signals[], signal: NodeJS.Signals) {
  return new Promise<ChildResult>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript(reraised)], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const wasReady = stdout.includes('ready\n')
      stdout += chunk
      if (!wasReady && stdout.includes('ready\n')) {
        child.kill(signal)
      }
    })
    child.on('error', reject)
    child.on('close', (code, exitSignal) => resolve({ stdout, code, signal: exitSignal }))
  })
}

test('a signal aborts the wait and run settles with its code', async () => {
  const result = await runChild([], 'SIGHUP')
  expect(result).toEqual({ stdout: 'ready\naborted\nsettled 7\n', code: 7, signal: null })
})

test('a re-raised SIGTERM ends the process with the default SIGTERM status', async () => {
  const result = await runChild(['SIGTERM'], 'SIGTERM')
  expect(result.stdout.startsWith('ready\naborted\n')).toBe(true)
  expect(result.code).toBe(null)
  expect(result.signal).toBe('SIGTERM')
})

test('a re-raised SIGHUP ends the process with the default SIGHUP status', async () => {
  const result = await runChild(['SIGHUP'], 'SIGHUP')
  expect(result.stdout.startsWith('ready\naborted\n')).toBe(true)
  expect(result.signal).toBe('SIGHUP')
})

test('a signal that is not re-raised keeps the exit code run returned', async () => {
  const result = await runChild(['SIGHUP'], 'SIGTERM')
  expect(result).toEqual({ stdout: 'ready\naborted\nsettled 7\n', code: 7, signal: null })
})

test('a second signal ends a run that ignores the abort', async () => {
  const script = `
import { runWithSignals } from ${JSON.stringify(COMMANDS_URL)}
await runWithSignals(
  async (controller) => {
    setInterval(() => {}, 1000)
    controller.signal.addEventListener('abort', () => process.stdout.write('aborted\\n'))
    process.stdout.write('ready\\n')
    await new Promise(() => {})
    return 0
  },
  ['SIGINT', 'SIGTERM'],
)
`
  const result = await new Promise<ChildResult>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    // Without the fix the child never exits; SIGKILL makes that a failure instead of a hang.
    const fallback = setTimeout(() => child.kill('SIGKILL'), 3000)
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      // The first signal aborts but the run never settles; the second must end the process.
      if (stdout === 'ready\n' || stdout === 'ready\naborted\n') {
        child.kill('SIGTERM')
      }
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      clearTimeout(fallback)
      resolve({ stdout, code, signal })
    })
  })
  expect(result).toEqual({ stdout: 'ready\naborted\n', code: null, signal: 'SIGTERM' })
})
