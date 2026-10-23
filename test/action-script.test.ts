import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { parse } from 'yaml'
import { afterEach, expect, test } from 'vite-plus/test'

const ROOT = join(import.meta.dirname, '..')
const SCRIPT = join(ROOT, 'action', 'run.sh')
const VERSION = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
).version
const LINK = '\n\nWorkflow run: https://github.com/bithyte/demo/actions/runs/42'
const FAKE_BINARY = `#!/bin/sh
printf '%s\\0' "$@" >"$FAKE_ARGS_FILE"
echo "$JAYPOST_MODE $JAYPOST_PROVIDER $JAYPOST_BOT_TOKEN $JAYPOST_OWNER_ID" >"$FAKE_ENV_FILE"
echo "\${JAYPOST_APPROVERS-unset}" >"$FAKE_ENV_FILE.approvers"
if [ "\${FAKE_WAIT:-}" = 1 ]; then
  trap 'echo TERM >"$FAKE_SIGNAL_FILE"; exit 1' TERM
  echo ready >&2
  while true; do sleep 0.1; done
fi
if [ -n "\${FAKE_ANSWER:-}" ]; then printf '%s\\n' "$FAKE_ANSWER"; fi
exit "\${FAKE_EXIT:-0}"
`

type RunResult = {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

type Runner = {
  readonly directory: string
  readonly output: string
  readonly argsFile: string
  readonly envFile: string
  readonly env: Record<string, string>
}

type Running = {
  readonly child: ChildProcess
  readonly result: Promise<RunResult>
  readonly ready: Promise<void>
}

const directories: string[] = []
const servers: Server[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  for (const server of servers.splice(0)) {
    server.close()
  }
})

async function startRelease(
  files: Record<string, Buffer>,
): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    const body = files[request.url ?? '']
    response.statusCode = body === undefined ? 404 : 200
    response.end(body)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}

function createReleaseFiles(): Record<string, Buffer> {
  const gzipped = gzipSync(FAKE_BINARY)
  const hash = createHash('sha256').update(gzipped).digest('hex')
  return {
    '/jaypost-linux-x64.gz': gzipped,
    '/SHA256SUMS': Buffer.from(`${hash}  jaypost-linux-x64.gz\n`),
  }
}

function createRunner(releaseUrl: string, inputs: Record<string, string> = {}): Runner {
  const directory = mkdtempSync(join(tmpdir(), 'jaypost-action-'))
  directories.push(directory)
  const fakeBin = join(directory, 'fake-bin')
  mkdirSync(fakeBin)
  writeFileSync(
    join(fakeBin, 'uname'),
    '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n',
  )
  chmodSync(join(fakeBin, 'uname'), 0o755)
  mkdirSync(join(directory, 'runner-temp'))
  const output = join(directory, 'output')
  writeFileSync(output, '')
  const argsFile = join(directory, 'args')
  const envFile = join(directory, 'env')
  const env: Record<string, string> = {
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    HOME: directory,
    GITHUB_ACTION_PATH: ROOT,
    GITHUB_OUTPUT: output,
    RUNNER_TEMP: join(directory, 'runner-temp'),
    RUNNER_OS: 'Linux',
    GITHUB_REPOSITORY: 'bithyte/demo',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_RUN_ID: '42',
    JAYPOST_MODE: 'direct',
    JAYPOST_PROVIDER: 'telegram',
    JAYPOST_BOT_TOKEN: '123:secret',
    JAYPOST_OWNER_ID: '7',
    JAYPOST_RELEASE_URL: releaseUrl,
    FAKE_ARGS_FILE: argsFile,
    FAKE_ENV_FILE: envFile,
    FAKE_SIGNAL_FILE: join(directory, 'signal'),
    INPUT_COMMAND: 'request',
    INPUT_TEXT: '',
    INPUT_OPTIONS: '',
    INPUT_DEFAULT: '',
    INPUT_TIMEOUT: '',
    INPUT_ALLOW_TEXT: '',
    INPUT_PROJECT: '',
    INPUT_FORMAT: '',
    INPUT_REQUIRE: '',
    INPUT_RETRY: '',
    ...inputs,
  }
  return { directory, output, argsFile, envFile, env }
}

// The runner runs the step's `run` text in `bash --noprofile --norc -e -o pipefail FILE` and signals
// only that shell, so cancel tests go through it instead of spawning the script directly.
function runStep(env: Record<string, string>): Running {
  const action = parse(readFileSync(join(ROOT, 'action.yml'), 'utf8')) as {
    runs: { steps: { run: string }[] }
  }
  const stepFile = join(env.RUNNER_TEMP ?? '', 'step.sh')
  writeFileSync(stepFile, `${action.runs.steps[0]?.run ?? ''}\n`)
  return spawnRunning('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', stepFile], env)
}

function runAction(env: Record<string, string>): Running {
  return spawnRunning('bash', [SCRIPT], env)
}

function spawnRunning(command: string, args: string[], env: Record<string, string>): Running {
  const child = spawn(command, args, { env })
  let stdout = ''
  let stderr = ''
  let markReady = (): void => {}
  const ready = new Promise<void>((resolve) => {
    markReady = resolve
  })
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
    if (stderr.includes('ready')) {
      markReady()
    }
  })
  const result = new Promise<RunResult>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
  return { child, result, ready }
}

function readArgs(runner: Runner): string[] {
  return readFileSync(runner.argsFile, 'utf8').split('\0').slice(0, -1)
}

async function setUp(
  inputs: Record<string, string>,
  extraEnv: Record<string, string> = {},
): Promise<Runner> {
  const release = await startRelease(createReleaseFiles())
  const runner = createRunner(release.url, inputs)
  Object.assign(runner.env, extraEnv)
  return runner
}

async function expectInputError(
  inputs: Record<string, string>,
  message: string,
  status = 2,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  const runner = await setUp(inputs, extraEnv)
  const result = await runAction(runner.env).result
  expect(result.stderr).toBe(`jaypost action: ${message}\n`)
  expect(result.status).toBe(status)
  expect(existsSync(runner.argsFile)).toBe(false)
  return result
}

test('asks with the inputs as send arguments and sets the answer output', async () => {
  const runner = await setUp({
    INPUT_TEXT: 'Publish v1.2.3?',
    INPUT_OPTIONS: 'Yes\n  No  \n\n',
    INPUT_DEFAULT: 'No',
    INPUT_TIMEOUT: '600',
    FAKE_ANSWER: 'Yes',
  })
  const result = await runAction(runner.env).result
  expect(result.status, result.stderr).toBe(0)
  expect(readArgs(runner)).toEqual([
    'send',
    'request',
    '--project=demo',
    '--option=Yes',
    '--option=No',
    '--default=No',
    '--timeout=600',
    '--',
    `Publish v1.2.3?${LINK}`,
  ])
  expect(readFileSync(runner.envFile, 'utf8').trim()).toBe('direct telegram 123:secret 7')
  expect(readFileSync(runner.output, 'utf8')).toMatch(/^answer<<(jaypost_[0-9a-f]{32})\nYes\n\1\n$/)
  expect(result.stdout).toContain('Yes')
})

test('notify sends the text with the run link and nothing else', async () => {
  const runner = await setUp({ INPUT_COMMAND: 'notify', INPUT_TEXT: 'Shipped' })
  const result = await runAction(runner.env).result
  expect(result.status, result.stderr).toBe(0)
  expect(readArgs(runner)).toEqual(['send', 'notify', '--project=demo', '--', `Shipped${LINK}`])
})

test('passes project, format and allow-text through', async () => {
  const runner = await setUp({
    INPUT_TEXT: 'Name the release',
    INPUT_PROJECT: 'api',
    INPUT_FORMAT: 'markdown',
    INPUT_ALLOW_TEXT: 'true',
    INPUT_DEFAULT: 'No',
  })
  const result = await runAction(runner.env).result
  expect(result.status, result.stderr).toBe(0)
  expect(readArgs(runner)).toEqual([
    'send',
    'request',
    '--project=api',
    '--format=markdown',
    '--default=No',
    '--allow-text',
    '--',
    `Name the release${LINK}`,
  ])
})

test('keeps values that start with a dash as values', async () => {
  const runner = await setUp({
    INPUT_TEXT: '--force push?',
    INPUT_OPTIONS: '-1',
    INPUT_DEFAULT: '-2',
  })
  const result = await runAction(runner.env).result
  expect(result.status, result.stderr).toBe(0)
  const args = readArgs(runner)
  expect(args).toContain('--option=-1')
  expect(args).toContain('--default=-2')
  expect(args.slice(-2)).toEqual(['--', `--force push?${LINK}`])
})

test('fails the step with exit 3 and says why when declined', async () => {
  const runner = await setUp({
    INPUT_TEXT: 'Go?',
    INPUT_OPTIONS: 'Yes\nNo',
    INPUT_DEFAULT: 'No',
    FAKE_ANSWER: 'No',
    FAKE_EXIT: '3',
  })
  const result = await runAction(runner.env).result
  expect(result.status).toBe(3)
  expect(readFileSync(runner.output, 'utf8')).toMatch(/\nNo\n/)
  expect(result.stderr).toContain('declined')
})

test('keeps a multi-line answer intact in the output', async () => {
  const runner = await setUp({
    INPUT_TEXT: 'Why?',
    INPUT_ALLOW_TEXT: 'true',
    INPUT_DEFAULT: 'No',
    FAKE_ANSWER: 'line one\nline two',
  })
  const result = await runAction(runner.env).result
  expect(result.status, result.stderr).toBe(0)
  expect(readFileSync(runner.output, 'utf8')).toMatch(
    /^answer<<(jaypost_[0-9a-f]{32})\nline one\nline two\n\1\n$/,
  )
})

test('reuses the binary already installed for this version', async () => {
  const release = await startRelease(createReleaseFiles())
  const runner = createRunner(release.url, {
    INPUT_COMMAND: 'notify',
    INPUT_TEXT: 'one',
  })
  const first = await runAction(runner.env).result
  expect(first.status, first.stderr).toBe(0)
  await new Promise((resolve) => release.server.close(resolve))
  rmSync(runner.argsFile)
  const second = await runAction({ ...runner.env, INPUT_TEXT: 'two' }).result
  expect(second.status, second.stderr).toBe(0)
  expect(readArgs(runner).slice(-1)).toEqual([`two${LINK}`])
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`forwards ${signal} to the binary as SIGTERM`, async () => {
    const runner = await setUp({
      INPUT_TEXT: 'Go?',
      INPUT_OPTIONS: 'Yes\nNo',
      INPUT_DEFAULT: 'No',
      FAKE_WAIT: '1',
    })
    const running = runStep(runner.env)
    await running.ready
    running.child.kill(signal)
    const result = await running.result
    expect(result.status).toBe(1)
    expect(readFileSync(runner.env.FAKE_SIGNAL_FILE ?? '', 'utf8').trim()).toBe('TERM')
  })
}

test('keeps an answer that looks like an echo flag', async () => {
  const runner = await setUp({
    INPUT_TEXT: 'Why?',
    INPUT_ALLOW_TEXT: 'true',
    INPUT_DEFAULT: 'No',
    FAKE_ANSWER: '-n',
  })
  const result = await runAction(runner.env).result
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('-n')
  expect(readFileSync(runner.output, 'utf8')).toMatch(/^answer<<(jaypost_[0-9a-f]{32})\n-n\n\1\n$/)
})

test('passes the binary exit code through on an error', async () => {
  const runner = await setUp({ INPUT_COMMAND: 'notify', INPUT_TEXT: 'Hi', FAKE_EXIT: '1' })
  const result = await runAction(runner.env).result
  expect(result.status).toBe(1)
})

test('fails when the download fails', async () => {
  const release = await startRelease({})
  const runner = createRunner(release.url, { INPUT_COMMAND: 'notify', INPUT_TEXT: 'Hi' })
  const result = await runAction(runner.env).result
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('may still be uploading')
})

test('rejects an unknown command', async () => {
  await expectInputError(
    { INPUT_COMMAND: 'ask', INPUT_TEXT: 'Hi' },
    'input command must be request or notify, got "ask"',
  )
})

test('rejects empty text', async () => {
  await expectInputError({ INPUT_TEXT: '' }, 'input text is empty')
})

test('names the empty bot token and why', async () => {
  await expectInputError(
    { INPUT_TEXT: 'Hi', JAYPOST_BOT_TOKEN: '' },
    "input bot-token is empty; pass it from a secret (pull requests from forks don't get secrets)",
  )
})

test('names the empty owner id without printing the token', async () => {
  const result = await expectInputError(
    { INPUT_TEXT: 'Hi', JAYPOST_OWNER_ID: '' },
    "input owner-id is empty; pass it from a secret (pull requests from forks don't get secrets)",
  )
  expect(result.stdout + result.stderr).not.toContain('123:secret')
})

test('rejects an allow-text that is not true or false', async () => {
  await expectInputError(
    { INPUT_TEXT: 'Hi', INPUT_ALLOW_TEXT: 'yes' },
    'input allow-text must be true or false, got "yes"',
  )
})

test('requires a default for request', async () => {
  await expectInputError(
    { INPUT_TEXT: 'Hi', INPUT_OPTIONS: 'Yes' },
    'input default is required for command request',
  )
})

test('requires options or allow-text for request', async () => {
  await expectInputError(
    { INPUT_TEXT: 'Hi', INPUT_DEFAULT: 'No' },
    'input options or allow-text: true is required for command request',
  )
})

test('rejects request-only inputs on notify', async () => {
  await expectInputError(
    { INPUT_COMMAND: 'notify', INPUT_TEXT: 'Hi', INPUT_OPTIONS: 'Yes' },
    'input options only applies to command request',
  )
})

test('passes approvers through env and require and retry as flags', async () => {
  const runner = await setUp(
    {
      INPUT_TEXT: 'Ship it?',
      INPUT_OPTIONS: 'Yes\nNo',
      INPUT_DEFAULT: 'No',
      INPUT_REQUIRE: 'majority',
      INPUT_RETRY: '2',
    },
    { JAYPOST_APPROVERS: '1,2' },
  )
  const result = await runAction(runner.env).result
  expect(result.status, result.stderr).toBe(0)
  const args = readArgs(runner)
  expect(args).toContain('--require=majority')
  expect(args).toContain('--retry=2')
  expect(args.filter((arg) => arg.includes('1,2'))).toEqual([])
  expect(readFileSync(`${runner.envFile}.approvers`, 'utf8').trim()).toBe('1,2')
})

test('unsets empty approvers', async () => {
  const runner = await setUp(
    { INPUT_TEXT: 'Ship it?', INPUT_OPTIONS: 'Yes', INPUT_DEFAULT: 'No' },
    { JAYPOST_APPROVERS: '' },
  )
  const result = await runAction(runner.env).result
  expect(result.status, result.stderr).toBe(0)
  expect(readFileSync(`${runner.envFile}.approvers`, 'utf8').trim()).toBe('unset')
})

test('retry alone re-asks without a vote', async () => {
  const runner = await setUp({
    INPUT_TEXT: 'Ship it?',
    INPUT_OPTIONS: 'Yes',
    INPUT_DEFAULT: 'No',
    INPUT_RETRY: '1',
  })
  const result = await runAction(runner.env).result
  expect(result.status, result.stderr).toBe(0)
  const args = readArgs(runner)
  expect(args).toContain('--retry=1')
  expect(args.filter((arg) => arg.startsWith('--require'))).toEqual([])
})

test('requires require with approvers', async () => {
  await expectInputError(
    { INPUT_TEXT: 'Hi', INPUT_OPTIONS: 'Yes', INPUT_DEFAULT: 'No' },
    'input require is required with approvers (all or majority)',
    2,
    { JAYPOST_APPROVERS: '1,2' },
  )
})

test('rejects require with empty approvers', async () => {
  await expectInputError(
    { INPUT_TEXT: 'Hi', INPUT_OPTIONS: 'Yes', INPUT_DEFAULT: 'No', INPUT_REQUIRE: 'all' },
    'input approvers is empty; pass it from a secret (a missing secret is empty too)',
    2,
    { JAYPOST_APPROVERS: '' },
  )
})

test('rejects vote inputs on notify', async () => {
  const cases: readonly (readonly [string, Record<string, string>, Record<string, string>])[] = [
    ['approvers', {}, { JAYPOST_APPROVERS: '1,2' }],
    ['require', { INPUT_REQUIRE: 'all' }, {}],
    ['retry', { INPUT_RETRY: '1' }, {}],
  ]
  for (const [name, inputs, extraEnv] of cases) {
    await expectInputError(
      { INPUT_COMMAND: 'notify', INPUT_TEXT: 'Hi', ...inputs },
      `input ${name} only applies to command request`,
      2,
      extraEnv,
    )
  }
})

test('rejects windows runners', async () => {
  await expectInputError(
    { INPUT_TEXT: 'Hi', RUNNER_OS: 'Windows' },
    "Windows runners aren't supported; see the npx example in the jaypost CI docs",
    1,
  )
})
