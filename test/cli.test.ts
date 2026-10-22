import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { parse } from 'yaml'
import { main } from '../src/cli.ts'
import { VERSION } from '../src/config/index.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

test('unknown command returns 2', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  expect(await main(['nope'])).toBe(2)
})

test('--version prints VERSION', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  expect(await main(['--version'])).toBe(0)
  expect(write).toHaveBeenCalledWith(`${VERSION}\n`)
})

test('init rejects bad port and unknown target with 2', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  expect(await main(['init', '--port', 'abc'])).toBe(2)
  expect(await main(['init', '--port', '70000'])).toBe(2)
  expect(await main(['init', 'nope'])).toBe(2)
})

test('log rejects bad --since, --limit and empty --project with 2', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  expect(await main(['log', '--since', 'soon'])).toBe(2)
  expect(await main(['log', '--since', '99999999999d'])).toBe(2)
  expect(await main(['log', '-n', '0'])).toBe(2)
  expect(await main(['log', '-n', 'x'])).toBe(2)
  expect(await main(['log', '--project', ' '])).toBe(2)
})

test('init --help lists --provider', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  expect(await main(['init', '--help'])).toBe(0)
  expect(write.mock.calls.map((call) => String(call[0])).join('')).toContain('--provider <name>')
})

test('init --help lists --token and --no-token', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  expect(await main(['init', '--help'])).toBe(0)
  const help = write.mock.calls.map((call) => String(call[0])).join('')
  expect(help).toContain('--token ')
  expect(help).toContain('--no-token')
})

test('setup-ci --help lists --provider', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  expect(await main(['setup-ci', '--help'])).toBe(0)
  expect(write.mock.calls.map((call) => String(call[0])).join('')).toContain('--provider <name>')
})

test('setup-ci --provider nope exits 2', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  expect(await main(['setup-ci', '--provider', 'nope'])).toBe(2)
})

test('mcp rejects a bad port with 2', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  expect(await main(['mcp', '--port', 'abc'])).toBe(2)
})

test('send request needs -o or --allow-text', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  expect(await main(['send', 'request', 'Deploy?', '-d', 'No'])).toBe(2)
  expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain('--allow-text')
})

test('send request --allow-text without -o reaches the service', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  // An invalid token makes send exit 1 before any network call; a usage error would be 2.
  vi.stubEnv('JAYPOST_TOKEN', 'short-secret')
  const ask = ['send', 'request', 'Which?', '--allow-text', '-d', 'main']
  expect(await main([...ask, '--port', '1'])).toBe(1)
})

test('send request requires a default, and rejects a bad timeout', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  expect(await main(['send', 'request', 'Deploy?', '-o', 'Yes', '-o', 'No'])).toBe(2)
  expect(await main(['send', 'request', 'Deploy?', '-o', 'Yes', '--timeout-option', 'No'])).toBe(2)
  const ask = ['send', 'request', 'Deploy?', '-o', 'Yes', '-d', 'No']
  expect(await main([...ask, '--timeout', '0'])).toBe(2)
  expect(await main([...ask, '--timeout', 'soon'])).toBe(2)
})

test('send request adds the default as the last button unless an option names it or --allow-text', async () => {
  const bodies: unknown[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => (body += chunk.toString()))
    request.on('end', () => {
      bodies.push(JSON.parse(body))
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ answer: 'Decline', timedOut: true }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = String((server.address() as AddressInfo).port)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const ask = ['send', 'request', 'Deploy?', '--port', port]
    expect(await main([...ask, '-o', 'Approve', '-d', 'Decline'])).toBe(0)
    expect(await main([...ask, '-o', 'Decline', '-o', 'Approve', '--default', 'Decline'])).toBe(0)
    expect(await main([...ask, '-o', 'Approve', '--allow-text', '-d', 'Decline'])).toBe(0)
  } finally {
    server.close()
  }
  expect(bodies).toEqual([
    { text: 'Deploy?', options: ['Approve', 'Decline'], timeoutOption: 'Decline' },
    { text: 'Deploy?', options: ['Decline', 'Approve'], timeoutOption: 'Decline' },
    { text: 'Deploy?', options: ['Approve'], allowText: true, timeoutOption: 'Decline' },
  ])
})

test('test --port sends to that port, over the install and PORT', async () => {
  const urls: (string | undefined)[] = []
  const server = createServer((request, response) => {
    urls.push(request.url)
    request.resume()
    request.on('end', () => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ answer: 'Approve', timedOut: false }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = String((server.address() as AddressInfo).port)
  vi.stubEnv('PORT', '1')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    expect(await main(['test', '--port', port])).toBe(0)
  } finally {
    server.close()
  }
  expect(urls).toEqual(['/request'])
})

test('test rejects a bad port with 2', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  expect(await main(['test', '--port', 'abc'])).toBe(2)
})

test('send notify requires text', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  expect(await main(['send', 'notify'])).toBe(2)
})

test('hook rejects a bad port, a bad timeout and positional arguments with 2', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  expect(await main(['hook', '--port', 'abc'])).toBe(2)
  expect(await main(['hook', '--timeout', '0'])).toBe(2)
  expect(await main(['hook', 'extra'])).toBe(2)
})

test('send exits 1 with the message on an invalid JAYPOST_TOKEN', async () => {
  vi.stubEnv('JAYPOST_TOKEN', 'short-secret')
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(await main(['send', 'notify', 'hi', '--port', '1'])).toBe(1)
  expect(error).toHaveBeenCalledWith("jaypost: JAYPOST_TOKEN isn't a valid jaypost token")
})

test('send rejects an unknown JAYPOST_MODE with 2', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.stubEnv('JAYPOST_MODE', 'bogus')
  expect(await main(['send', 'request', 'x', '-o', 'a', '-d', 'a'])).toBe(2)
  expect(await main(['send', 'notify', 'x'])).toBe(2)
  expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain(
    'JAYPOST_MODE must be "direct" or "service", got "bogus"',
  )
})

test('direct send without a bot token exits 1 naming the env var', async () => {
  vi.stubEnv('JAYPOST_MODE', 'direct')
  vi.stubEnv('JAYPOST_PROVIDER', '')
  vi.stubEnv('JAYPOST_BOT_TOKEN', '')
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(await main(['send', 'request', 'x', '-o', 'a', '-d', 'a'])).toBe(1)
  expect(await main(['send', 'notify', 'x'])).toBe(1)
  const output = error.mock.calls.map((call) => String(call[0])).join('\n')
  expect(output).toContain('missing bot token; set JAYPOST_BOT_TOKEN')
})

test('openapi writes the spec with the given port to a file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jaypost-openapi-'))
  try {
    const file = join(directory, 'openapi.yaml')
    expect(await main(['openapi', '--port', '9999', file])).toBe(0)
    expect(parse(readFileSync(file, 'utf8')).servers).toEqual([{ url: 'http://127.0.0.1:9999' }])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('openapi for the discord provider carries its option limit', async () => {
  vi.stubEnv('JAYPOST_PROVIDER', 'discord')
  vi.stubEnv('JAYPOST_BOT_TOKEN', 'x')
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  expect(await main(['openapi', '--port', '9999'])).toBe(0)
  expect(String(write.mock.calls[0]?.[0])).toContain('25')
})

test('openapi prints the spec without a file', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  expect(await main(['openapi', '--port', '9999'])).toBe(0)
  expect(String(write.mock.calls[0]?.[0])).toMatch(/^openapi: 3\.1\.0\n/)
})

test('openapi returns 1 when the file cannot be written', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(await main(['openapi', '/nonexistent-directory/openapi.yaml'])).toBe(1)
})

test('send rejects an unknown format with 2', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const ask = ['send', 'request', 'Deploy?', '-o', 'Yes', '-d', 'Yes']
  expect(await main([...ask, '--format', 'html'])).toBe(2)
  expect(await main(['send', 'notify', 'hi', '--format', 'html'])).toBe(2)
})

function runAuditDump(args: readonly string[], directory: string) {
  return spawnSync(process.execPath, ['src/cli.ts', 'audit', ...args], {
    env: { ...process.env, JAYPOST_CONFIG: join(directory, 'config.json') },
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8',
  })
}

test('audit dump writes .1 then current from the config directory, whole', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cli-audit-'))
  try {
    const current = `${'x'.repeat(2 * 1024 * 1024)}\n`
    writeFileSync(join(directory, 'audit.jsonl.1'), 'old\n')
    writeFileSync(join(directory, 'audit.jsonl'), current)
    const result = runAuditDump(['dump'], directory)
    expect(result.status).toBe(0)
    expect(result.stdout.length).toBe(`old\n${current}`.length)
    expect(result.stdout === `old\n${current}`).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('audit dump with no files prints nothing and exits 0', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cli-audit-'))
  try {
    const result = runAuditDump(['dump'], directory)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('audit with an unknown subcommand exits 2', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cli-audit-'))
  try {
    const result = runAuditDump(['nope'], directory)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Usage: audit dump')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

function bigAuditLog(count: number): string {
  return Array.from({ length: count }, (_, index) =>
    JSON.stringify({
      v: 1,
      event: 'asked',
      id: `id${index}`,
      at: '2026-10-19T07:00:00.000Z',
      text: `question ${index} ${'x'.repeat(100)}`,
      options: ['Approve', 'Decline'],
      timeoutOption: 'Decline',
      timeoutSeconds: 300,
      attachment: undefined,
    }),
  ).join('\n')
}

function runLogCli(args: readonly string[], directory: string) {
  return spawnSync(process.execPath, ['src/cli.ts', 'log', ...args], {
    env: {
      ...process.env,
      HOME: directory,
      XDG_CONFIG_HOME: join(directory, 'xdg'),
      JAYPOST_CONFIG: join(directory, 'config.json'),
    },
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
  })
}

test('log writes output larger than a pipe buffer whole, as json and as a table', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cli-log-'))
  try {
    writeFileSync(join(directory, 'audit.jsonl'), `${bigAuditLog(2500)}\n`)
    const json = runLogCli(['--since', '2000-01-01', '--json'], directory)
    expect(json.status).toBe(0)
    expect(json.stdout.length).toBeGreaterThan(65_536 * 3)
    const lines = json.stdout.split('\n')
    expect(lines.at(-1)).toBe('')
    expect(lines).toHaveLength(2501)
    expect(JSON.parse(lines[2499] ?? '').id).toBe('id2499')
    const table = runLogCli(['--since', '2000-01-01'], directory)
    expect(table.status).toBe(0)
    expect(table.stdout.length).toBeGreaterThan(65_536)
    expect(table.stdout.endsWith('\n')).toBe(true)
    expect(table.stdout.split('\n')).toHaveLength(2501)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('send --attach-name without --attach exits 2', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  expect(
    await main(['send', 'request', 'Deploy?', '-o', 'Yes', '-d', 'No', '--attach-name', 'a']),
  ).toBe(2)
  expect(await main(['send', 'notify', 'done', '--attach-name', 'a'])).toBe(2)
  const output = stderr.mock.calls.map((call) => String(call[0])).join('')
  expect(output).toContain("error: option '--attach-name <name>' needs '--attach <file>'")
})
