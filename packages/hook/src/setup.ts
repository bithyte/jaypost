import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describeEndpoint, isLoopbackEndpoint } from '@jaypost/client'
import type { Caller } from '@jaypost/client'
import { MANUAL_HOOK_PATTERN, MANUAL_MCP_PATTERN, SETUP_STATUS_TIMEOUT_MS } from './constants.ts'
import type { HookDeps } from './types.ts'

/**
 * Asks the service for /status and describes what stops permission prompts from reaching the
 * phone: not running, a token it can't use, or no phone paired. `undefined` means all is well.
 * A killed hook (`deps.signal` aborted) gets `undefined` too, so the caller can stay silent.
 * Never throws.
 */
export async function checkService(caller: Caller, deps: HookDeps): Promise<string | undefined> {
  const { endpoint } = deps
  if (endpoint.kind === 'invalid') {
    return deps.signal.aborted
      ? undefined
      : `jaypost can't find its service (${endpoint.message}), so permission prompts stay in the terminal.`
  }
  const result = await caller.status({ signal: deps.signal, timeoutMs: SETUP_STATUS_TIMEOUT_MS })
  if (result.kind === 'status') {
    return result.status.paired
      ? undefined
      : "jaypost isn't paired with your phone yet, so permission prompts stay in the terminal. Run `jaypost init` to pair."
  }
  if (deps.signal.aborted) {
    return undefined
  }
  switch (result.reason) {
    case 'unreachable':
    case 'cancelled':
    case 'httpTimeout':
      return isLoopbackEndpoint(endpoint.url)
        ? `jaypost isn't running on ${describeEndpoint(endpoint.url)}, so permission prompts stay in the terminal. Run \`jaypost init\` to set it up, or \`jaypost status\` to check an existing install.`
        : `jaypost isn't reachable on ${describeEndpoint(endpoint.url)}, so permission prompts stay in the terminal. Check JAYPOST_URL and that the service there is running.`
    case 'unusableToken':
    case 'unauthorized':
      return `jaypost can't use its API token (${result.message}), so permission prompts stay in the terminal. Run \`jaypost init\`, or set JAYPOST_TOKEN in a container.`
    default:
      return `jaypost setup check failed (${result.message}), so permission prompts may stay in the terminal.`
  }
}

type ConfigFile = {
  readonly path: string
  readonly display: string
  readonly hasEntry: (config: Record<string, unknown>) => boolean
}

/**
 * Display paths of the Claude Code config files that hold a hand-written jaypost hook or MCP
 * server, in a fixed order, with `home` shown as `~`. A missing `home` or `projectDir` skips the
 * files that need it. Never throws.
 */
export function findManualSetup(
  home: string | undefined,
  projectDir: string | undefined,
): readonly string[] {
  const files: ConfigFile[] = []
  if (home !== undefined) {
    files.push({
      path: join(home, '.claude', 'settings.json'),
      display: '~/.claude/settings.json',
      hasEntry: hasManualHook,
    })
  }
  if (projectDir !== undefined) {
    files.push(
      {
        path: join(projectDir, '.claude', 'settings.json'),
        display: join(projectDir, '.claude', 'settings.json'),
        hasEntry: hasManualHook,
      },
      {
        path: join(projectDir, '.claude', 'settings.local.json'),
        display: join(projectDir, '.claude', 'settings.local.json'),
        hasEntry: hasManualHook,
      },
    )
  }
  if (home !== undefined) {
    files.push({
      path: join(home, '.claude.json'),
      display: '~/.claude.json',
      hasEntry: (config) =>
        hasManualServer(config['mcpServers']) ||
        (projectDir !== undefined &&
          isRecord(config['projects']) &&
          isRecord(config['projects'][projectDir]) &&
          hasManualServer(config['projects'][projectDir]['mcpServers'])),
    })
  }
  if (projectDir !== undefined) {
    files.push({
      path: join(projectDir, '.mcp.json'),
      display: join(projectDir, '.mcp.json'),
      hasEntry: (config) => hasManualServer(config['mcpServers']),
    })
  }
  return files
    .filter((file) => {
      const config = readConfig(file.path)
      return config !== undefined && file.hasEntry(config)
    })
    .map((file) => file.display)
}

function readConfig(path: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // Missing is normal; unreadable or unparsable is Claude Code's to report, and a session-start
    // hook must not fail over a broken settings file, so it counts as having no jaypost entry.
    return undefined
  }
  // An oddly shaped file (not an object, wrong field types) is skipped for the same reason.
  return isRecord(parsed) ? parsed : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasManualHook(config: Record<string, unknown>): boolean {
  const events = config['hooks']
  if (!isRecord(events)) {
    return false
  }
  return Object.values(events).some(
    (groups) =>
      Array.isArray(groups) &&
      groups.some(
        (group) =>
          isRecord(group) &&
          Array.isArray(group['hooks']) &&
          group['hooks'].some(
            (hook) =>
              isRecord(hook) &&
              typeof hook['command'] === 'string' &&
              MANUAL_HOOK_PATTERN.test(hook['command']),
          ),
      ),
  )
}

function hasManualServer(servers: unknown): boolean {
  if (!isRecord(servers)) {
    return false
  }
  return Object.values(servers).some((server) => {
    if (!isRecord(server) || typeof server['command'] !== 'string') {
      return false
    }
    const args = Array.isArray(server['args'])
      ? server['args'].filter((argument) => typeof argument === 'string')
      : []
    return MANUAL_MCP_PATTERN.test([server['command'], ...args].join(' '))
  })
}
