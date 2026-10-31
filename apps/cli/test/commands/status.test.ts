import { expect, test, vi } from 'vite-plus/test'
import { NO_CLIENT_TOKEN } from '@jaypost/store'
import type { ClientToken } from '@jaypost/store'
import { TOKEN_REJECTED_MESSAGE } from '@jaypost/client'
import type { ResolvedBot } from '@jaypost/client'
import type { InstallRecord, Target } from '@jaypost/install'
import type { StatusInfo } from '@jaypost/protocol'
import { runStatus } from '../../src/commands/index.ts'
import type { StatusDeps, StatusFetch } from '../../src/commands/index.ts'
import { UNAUTHORIZED_STATUS, UNREACHABLE_STATUS } from '../../src/commands/constants.ts'

const KEY = 'K'.repeat(43)
const RECORD: InstallRecord = {
  target: 'systemd',
  port: 9000,
  version: '1.0.0',
}

function answered(status: StatusInfo): StatusFetch {
  return { kind: 'answered', status }
}

function bot(url: string, alias: string | undefined, token: ClientToken = NO_CLIENT_TOKEN) {
  return {
    endpoint: { kind: 'url', url: new URL(url) },
    token,
    alias,
    failure: undefined,
  } satisfies ResolvedBot
}

function installed(running = true): StatusDeps['install'] {
  const target = {
    isRunning: vi.fn(async () => running),
    logsHint: vi.fn(() => 'logs hint'),
  } as unknown as Target
  return { record: RECORD, target }
}

function setup(over: Partial<StatusDeps> = {}) {
  const out: string[] = []
  const deps: StatusDeps = {
    resolved: bot('http://127.0.0.1:9000/', 'local'),
    install: installed(),
    fetchStatus: vi.fn(async () => answered({ paired: true, bot: 'b' })),
    print: (text) => out.push(text),
    ...over,
  }
  return { deps, out }
}

test('status prints install lines for the local bot', async () => {
  const { deps, out } = setup({
    fetchStatus: vi.fn(async () =>
      answered({ paired: true, key: 'k1', contact: 'c1', state: 'running' }),
    ),
  })
  expect(await runStatus(deps)).toBe(0)
  expect(out).toEqual([
    'Bot:     local (127.0.0.1:9000)',
    'Target:  systemd',
    'Version: 1.0.0',
    'Port:    9000',
    'Running: yes',
    'Key:     k1 (contact c1)',
    'Pairing: paired',
  ])
})

test('status prints the bot and pairing for a remote bot without install lines', async () => {
  const isRunning = vi.fn(async () => true)
  const fetchStatus = vi.fn(async () =>
    answered({ paired: false, code: 'ABCD-EFGH', bot: 'mybot' }),
  )
  const { deps, out } = setup({
    resolved: bot('https://relay.example.com/team', 'work', {
      kind: 'token',
      token: KEY,
      source: 'inbox',
    }),
    install: { record: RECORD, target: { isRunning } as unknown as Target },
    fetchStatus,
  })
  expect(await runStatus(deps)).toBe(0)
  expect(out[0]).toBe('Bot:     work (https://relay.example.com/team)')
  expect(out.join('\n')).toContain(
    'Pairing: not paired\nPairing code: ABCD-EFGH\nSend "/start ABCD-EFGH"',
  )
  expect(out.join('\n')).not.toContain('Target:')
  expect(out.join('\n')).not.toContain(KEY)
  expect(isRunning).not.toHaveBeenCalled()
  expect(fetchStatus).toHaveBeenCalledWith(new URL('https://relay.example.com/team'), KEY)
})

test('status for a loopback url on another port than the install asks that url', async () => {
  const isRunning = vi.fn(async () => false)
  const target = { isRunning, logsHint: vi.fn(() => 'logs hint') } as unknown as Target
  const fetchStatus = vi.fn(async () => answered({ paired: true, bot: 'b' }))
  const { deps, out } = setup({
    resolved: bot('http://127.0.0.1:9999/', undefined),
    install: { record: RECORD, target },
    fetchStatus,
  })
  expect(await runStatus(deps)).toBe(0)
  expect(out).toEqual(['Bot:     env (127.0.0.1:9999)', 'Pairing: paired'])
  expect(isRunning).not.toHaveBeenCalled()
})

test('status treats localhost on the install port as the install', async () => {
  const { deps, out } = setup({ resolved: bot('http://localhost:9000/', 'local') })
  expect(await runStatus(deps)).toBe(0)
  expect(out).toContain('Target:  systemd')
})

test('status treats a loopback url with no port as its scheme default', async () => {
  const { deps, out } = setup({
    resolved: bot('http://127.0.0.1/', undefined),
    install: { record: { ...RECORD, port: 80 }, target: installed()?.target as Target },
  })
  expect(await runStatus(deps)).toBe(0)
  expect(out).toContain('Port:    80')
})

test('status names env mode', async () => {
  const { deps, out } = setup({
    resolved: bot('http://127.0.0.1:9000/', undefined),
    install: undefined,
  })
  expect(await runStatus(deps)).toBe(0)
  expect(out[0]).toBe('Bot:     env (127.0.0.1:9000)')
  expect(out).toEqual(['Bot:     env (127.0.0.1:9000)', 'Pairing: paired'])
})

test('status with no bot and no install says how to get one', async () => {
  const fetchStatus = vi.fn()
  const { deps, out } = setup({
    resolved: {
      endpoint: {
        kind: 'invalid',
        message: 'no bot to send to; run "jaypost service install" or "jaypost inbox join"',
      },
      token: NO_CLIENT_TOKEN,
      alias: undefined,
      failure: 'noBot',
    },
    install: undefined,
    fetchStatus,
  })
  expect(await runStatus(deps)).toBe(1)
  expect(out).toEqual(['No bot. Run "jaypost service install" or "jaypost inbox join".'])
  expect(fetchStatus).not.toHaveBeenCalled()
})

test('status prints the message of an unresolvable bot and returns 1', async () => {
  const { deps, out } = setup({
    resolved: {
      endpoint: {
        kind: 'invalid',
        message: 'no bot "x" in your inbox; known: a, b',
      },
      token: NO_CLIENT_TOKEN,
      alias: undefined,
      failure: 'unresolvable',
    },
  })
  expect(await runStatus(deps)).toBe(1)
  expect(out).toEqual(['no bot "x" in your inbox; known: a, b'])
})

test('status for a local bot that is not running returns 1 with the logs hint', async () => {
  const fetchStatus = vi.fn()
  const { deps, out } = setup({ install: installed(false), fetchStatus })
  expect(await runStatus(deps)).toBe(1)
  expect(out).toContain('Running: no')
  expect(out.at(-1)).toBe('logs hint')
  expect(fetchStatus).not.toHaveBeenCalled()
})

test('status shows a failed bot with its error', async () => {
  const { deps, out } = setup({
    fetchStatus: vi.fn(async () =>
      answered({
        paired: true,
        key: 'k1',
        contact: 'c1',
        state: 'failed',
        error: 'the bot token was rejected',
      }),
    ),
  })
  expect(await runStatus(deps)).toBe(0)
  expect(out.slice(-3)).toEqual([
    'Key:     k1 (contact c1)',
    'Bot:     failed (the bot token was rejected)',
    'Pairing: paired',
  ])
})

test('status with an unusable key returns 1 without calling the service', async () => {
  const fetchStatus = vi.fn()
  const { deps, out } = setup({
    resolved: bot('http://127.0.0.1:9000/', 'local', {
      kind: 'unusable',
      message: 'bad key here',
    }),
    fetchStatus,
  })
  expect(await runStatus(deps)).toBe(1)
  expect(out).toContain('Pairing: unknown (no usable token: bad key here)')
  expect(fetchStatus).not.toHaveBeenCalled()
})

test('status returns 1 when the service rejects the key, never printing it', async () => {
  const { deps, out } = setup({
    resolved: bot('http://127.0.0.1:9000/', 'local', {
      kind: 'token',
      token: KEY,
      source: 'inbox',
    }),
    fetchStatus: vi.fn(async () => UNAUTHORIZED_STATUS),
  })
  expect(await runStatus(deps)).toBe(1)
  expect(out.join('\n')).toContain(
    `Pairing: unknown (the service rejected the token)\n${TOKEN_REJECTED_MESSAGE}`,
  )
  expect(out.join('\n')).not.toContain(KEY)
})

test('status returns 1 when /status did not answer', async () => {
  const { deps, out } = setup({
    fetchStatus: vi.fn(async () => UNREACHABLE_STATUS),
  })
  expect(await runStatus(deps)).toBe(1)
  expect(out.at(-1)).toBe('Pairing: unknown (the service did not answer on /status yet)')
})
