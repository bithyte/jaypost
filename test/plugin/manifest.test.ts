import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vite-plus/test'

const ROOT = new URL('../..', import.meta.url).pathname
const PACKAGE_PATH = join(ROOT, 'apps', 'cli', 'package.json')
const MANIFEST_PATH = join(ROOT, 'claude-plugin', '.claude-plugin', 'plugin.json')
const WRAPPER_PATH = join(ROOT, 'claude-plugin', 'bin', 'jaypost-plugin')
const SYNC_SCRIPT_PATH = join(ROOT, 'scripts', 'sync-plugin-version.ts')
const WRAPPER_COMMAND = 'exec "${CLAUDE_PLUGIN_ROOT}/bin/jaypost-plugin"'
const EXPECTED_HOOKS = {
  SessionStart: [
    {
      matcher: 'startup|clear',
      hooks: [{ type: 'command', command: `${WRAPPER_COMMAND} session-start`, timeout: 10 }],
    },
  ],
  PermissionRequest: [
    { hooks: [{ type: 'command', command: `${WRAPPER_COMMAND} hook`, timeout: 360 }] },
  ],
  Notification: [
    {
      matcher: 'elicitation_dialog|agent_needs_input',
      hooks: [{ type: 'command', command: `${WRAPPER_COMMAND} hook` }],
    },
  ],
  Stop: [
    {
      hooks: [
        { type: 'command', command: `${WRAPPER_COMMAND} hook`, asyncRewake: true, timeout: 3720 },
      ],
    },
  ],
  UserPromptSubmit: [
    { hooks: [{ type: 'command', command: `${WRAPPER_COMMAND} hook`, async: true }] },
  ],
  SessionEnd: [{ hooks: [{ type: 'command', command: `${WRAPPER_COMMAND} hook` }] }],
}
const EXPECTED_MCP_SERVERS = {
  jaypost: { command: '${CLAUDE_PLUGIN_ROOT}/bin/jaypost-plugin', args: ['mcp'] },
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

test('plugin version matches the jaypost package', () => {
  expect(readJson(MANIFEST_PATH).version).toBe(readJson(PACKAGE_PATH).version)
})

test('plugin declares the hooks and mcp server', () => {
  const manifest = readJson(MANIFEST_PATH)
  expect(manifest.hooks).toEqual(EXPECTED_HOOKS)
  expect(manifest.mcpServers).toEqual(EXPECTED_MCP_SERVERS)
})

test('plugin wrapper is executable', () => {
  expect(statSync(WRAPPER_PATH).mode & 0o111).not.toBe(0)
})

test('sync script copies the package version into plugin.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'jaypost-sync-'))
  try {
    const manifestPath = join(root, 'claude-plugin', '.claude-plugin', 'plugin.json')
    mkdirSync(join(root, 'claude-plugin', '.claude-plugin'), { recursive: true })
    mkdirSync(join(root, 'apps', 'cli'), { recursive: true })
    cpSync(PACKAGE_PATH, join(root, 'apps', 'cli', 'package.json'))
    const original = readFileSync(MANIFEST_PATH, 'utf8')
    writeFileSync(manifestPath, original.replace(/"version": "[^"]*"/, '"version": "0.0.1"'))
    const result = spawnSync(process.execPath, [SYNC_SCRIPT_PATH, '--root', root], {
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    const expected = original.replace(
      /"version": "[^"]*"/,
      `"version": "${String(readJson(PACKAGE_PATH).version)}"`,
    )
    expect(readFileSync(manifestPath, 'utf8')).toBe(expected)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
