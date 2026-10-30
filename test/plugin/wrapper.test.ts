import { spawn, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vite-plus/test'

const ROOT = new URL('../..', import.meta.url).pathname
const WRAPPER = join(ROOT, 'claude-plugin', 'bin', 'jaypost-plugin')
const MANIFEST = join(ROOT, 'claude-plugin', '.claude-plugin', 'plugin.json')
const INSTALL_MESSAGE =
  "jaypost isn't installed or isn't on PATH, so permission prompts stay in the terminal. Install it with `npm install -g jaypost` or see https://github.com/bithyte/jaypost#quick-start"
const CHECK_FAILED_MESSAGE =
  "jaypost's setup check failed, so permission prompts may stay in the terminal. Run `jaypost status` to see why."
const TOO_OLD_MESSAGE =
  'jaypost is too old for this plugin. Run `jaypost update`, then `jaypost service update`.'
const PERMISSION_EVENT = '{"hook_event_name":"PermissionRequest"}'
const DECISION = '{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}'
const FAKE_SCRIPT = `#!/bin/sh
{
  echo "args=$*"
  echo "PORT=\${PORT-unset}"
  echo "JAYPOST_TOKEN=\${JAYPOST_TOKEN-unset}"
  echo "stdin=$(cat)"
} >> "$FAKE_LOG"
if [ -n "$FAKE_STDOUT" ]; then printf '%s\\n' "$FAKE_STDOUT"; fi
if [ -n "$FAKE_STDERR" ]; then printf '%s\\n' "$FAKE_STDERR" >&2; fi
exit "\${FAKE_EXIT:-0}"
`
const TRAPPING_SCRIPT = `#!/bin/sh
trap 'echo terminated >> "$FAKE_LOG"; exit 0' TERM
echo started >> "$FAKE_LOG"
while :; do sleep 0.1; done
`
const SLEEPING_SCRIPT = `#!/bin/sh
echo started >> "$FAKE_LOG"
sleep 1
`

type Sandbox = {
  readonly root: string
  readonly bin: string
  readonly home: string
  readonly log: string
  readonly path: string
}

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'jaypost-plugin-'))
  directories.push(directory)
  return directory
}

async function createSandbox(script: string | null = FAKE_SCRIPT): Promise<Sandbox> {
  const root = await createDirectory()
  const bin = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(bin)
  await mkdir(home)
  if (script !== null) {
    await writeFile(join(bin, 'jaypost'), script, { mode: 0o755 })
    await chmod(join(bin, 'jaypost'), 0o755)
  }
  return { root, bin, home, log: join(root, 'log'), path: `${bin}:/usr/bin:/bin` }
}

function environment(sandbox: Sandbox, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: sandbox.path, HOME: sandbox.home, FAKE_LOG: sandbox.log, ...extra }
}

function run(mode: string, sandbox: Sandbox, extra: Record<string, string> = {}, input = '') {
  return spawnSync(WRAPPER, [mode], { env: environment(sandbox, extra), input, encoding: 'utf8' })
}

async function readLog(sandbox: Sandbox): Promise<string> {
  return readFile(sandbox.log, 'utf8')
}

async function waitForStarted(sandbox: Sandbox): Promise<boolean> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const started = await readLog(sandbox).then(
      (text) => text.includes('started'),
      () => false,
    )
    if (started) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

test('hook passes the event through and prints the decision', async () => {
  const sandbox = await createSandbox()
  const result = run('hook', sandbox, { FAKE_STDOUT: DECISION }, PERMISSION_EVENT)
  expect(result.status).toBe(0)
  expect(result.stdout).toBe(`${DECISION}\n`)
  const log = await readLog(sandbox)
  expect(log).toContain('args=hook\n')
  expect(log).toContain(`stdin=${PERMISSION_EVENT}`)
})

test('hook drops PORT and keeps JAYPOST_TOKEN', async () => {
  const sandbox = await createSandbox()
  run('hook', sandbox, { PORT: '3000', JAYPOST_TOKEN: 't' }, PERMISSION_EVENT)
  const log = await readLog(sandbox)
  expect(log).toContain('PORT=unset\n')
  expect(log).toContain('JAYPOST_TOKEN=t\n')
})

test('hook swallows a failing jaypost', async () => {
  const sandbox = await createSandbox()
  const result = run(
    'hook',
    sandbox,
    { FAKE_EXIT: '1', FAKE_STDERR: 'jaypost: service not reachable' },
    PERMISSION_EVENT,
  )
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('')
})

test('hook passes a stop reply through with exit 2', async () => {
  const sandbox = await createSandbox()
  const result = run(
    'hook',
    sandbox,
    { FAKE_EXIT: '2', FAKE_STDOUT: 'The user replied: next' },
    '{"hook_event_name":"Stop"}',
  )
  expect(result.status).toBe(2)
  expect(result.stdout).toBe('The user replied: next\n')
  expect(result.stderr).toBe('')
})

test('hook without jaypost exits 0 silently', async () => {
  const sandbox = await createSandbox(null)
  const result = run('hook', sandbox, {}, PERMISSION_EVENT)
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('')
})

test('hook finds jaypost in ~/.local/bin when it is not on PATH', async () => {
  const sandbox = await createSandbox(null)
  const localBin = join(sandbox.home, '.local', 'bin')
  await mkdir(localBin, { recursive: true })
  await writeFile(join(localBin, 'jaypost'), FAKE_SCRIPT, { mode: 0o755 })
  const result = run('hook', sandbox, {}, PERMISSION_EVENT)
  expect(result.status).toBe(0)
  expect(await readLog(sandbox)).toContain('args=hook\n')
})

test('hook forwards sigterm to jaypost', async () => {
  const sandbox = await createSandbox(TRAPPING_SCRIPT)
  const child = spawn(WRAPPER, ['hook'], {
    env: environment(sandbox),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve))
  expect(await waitForStarted(sandbox)).toBe(true)
  child.kill('SIGTERM')
  expect(await exited).toBe(0)
  expect(await readLog(sandbox)).toContain('terminated')
})

test('the manifest hook command execs the wrapper so sigterm reaches it', async () => {
  const sandbox = await createSandbox(TRAPPING_SCRIPT)
  const pluginRoot = join(sandbox.root, 'plugin')
  await mkdir(join(pluginRoot, 'bin'), { recursive: true })
  await writeFile(join(pluginRoot, 'bin', 'jaypost-plugin'), TRAPPING_SCRIPT, { mode: 0o755 })
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as {
    hooks: { PermissionRequest: { hooks: { command: string }[] }[] }
  }
  const command = manifest.hooks.PermissionRequest[0]?.hooks[0]?.command ?? ''
  const child = spawn('sh', ['-c', command], {
    env: environment(sandbox, { CLAUDE_PLUGIN_ROOT: pluginRoot }),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve))
  expect(await waitForStarted(sandbox)).toBe(true)
  child.kill('SIGTERM')
  expect(await exited).toBe(0)
  expect(await readLog(sandbox)).toContain('terminated')
})

test('session start without jaypost prints the install message', async () => {
  const sandbox = await createSandbox(null)
  const result = run('session-start', sandbox)
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ systemMessage: INSTALL_MESSAGE })
})

test('session start with an old jaypost says to update', async () => {
  const sandbox = await createSandbox()
  const result = run('session-start', sandbox, {
    FAKE_EXIT: '1',
    FAKE_STDERR: 'jaypost: unsupported hook event "SessionStart"',
  })
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ systemMessage: TOO_OLD_MESSAGE })
})

test("session start passes jaypost's message through", async () => {
  const sandbox = await createSandbox()
  const result = run('session-start', sandbox, { FAKE_STDOUT: '{"systemMessage":"x"}' })
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('{"systemMessage":"x"}\n')
})

test('session start reports other failures', async () => {
  const sandbox = await createSandbox()
  const result = run('session-start', sandbox, { FAKE_EXIT: '1', FAKE_STDERR: 'boom' })
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ systemMessage: CHECK_FAILED_MESSAGE })
  expect(result.stderr).toBe('')
})

test('session start killed by sigterm exits 0 and removes its temp file', async () => {
  const sandbox = await createSandbox(SLEEPING_SCRIPT)
  const temporary = await createDirectory()
  const child = spawn(WRAPPER, ['session-start'], {
    env: environment(sandbox, { TMPDIR: temporary }),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve))
  expect(await waitForStarted(sandbox)).toBe(true)
  child.kill('SIGTERM')
  expect(await exited).toBe(0)
  expect(await readdir(temporary)).toEqual([])
})

test('session start leaves no temp files behind', async () => {
  const sandbox = await createSandbox()
  const temporary = await createDirectory()
  run('session-start', sandbox, { TMPDIR: temporary, FAKE_EXIT: '1', FAKE_STDERR: 'boom' })
  expect(await readdir(temporary)).toEqual([])
})

test('mcp runs jaypost mcp without PORT', async () => {
  const sandbox = await createSandbox()
  run('mcp', sandbox, { PORT: '3000' })
  const log = await readLog(sandbox)
  expect(log).toContain('args=mcp\n')
  expect(log).toContain('PORT=unset\n')
})

test('mcp without jaypost exits 1 with the install message', async () => {
  const sandbox = await createSandbox(null)
  const result = run('mcp', sandbox)
  expect(result.status).toBe(1)
  expect(result.stderr).toBe(`${INSTALL_MESSAGE}\n`)
})

test('an unknown mode exits 1 naming it', async () => {
  const sandbox = await createSandbox()
  const result = run('bogus', sandbox)
  expect(result.status).toBe(1)
  expect(result.stderr).toBe('jaypost-plugin: unknown mode "bogus"\n')
})

test('session start against the real cli reports a stopped service', async () => {
  const sandbox = await createSandbox(
    `#!/bin/sh\nexec "${process.execPath}" "${ROOT}apps/cli/src/cli.ts" "$@"\n`,
  )
  const configHome = join(sandbox.root, 'config')
  await mkdir(configHome)
  const botPort = await freePort()
  await mkdir(join(configHome, 'jaypost'), { recursive: true })
  await writeFile(
    join(configHome, 'jaypost', 'bots.json'),
    JSON.stringify({
      version: 1,
      default: 'home',
      remotes: [],
      bots: [{ alias: 'home', url: `http://127.0.0.1:${botPort}/` }],
    }),
  )
  const result = run(
    'session-start',
    sandbox,
    { XDG_CONFIG_HOME: configHome },
    '{"session_id":"s1","hook_event_name":"SessionStart","source":"startup","cwd":"/work"}',
  )
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    systemMessage: `jaypost isn't running on 127.0.0.1:${botPort}, so permission prompts stay in the terminal. Run \`jaypost service install\` to set it up, or \`jaypost status\` to check an existing install.`,
  })
})
