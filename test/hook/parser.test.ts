import { expect, test } from 'vite-plus/test'
import { parseHookEvent } from '../../src/hook/index.ts'

const PERMISSION_EVENT = {
  session_id: 's1',
  transcript_path: '/tmp/t.jsonl',
  cwd: '/work/api',
  permission_mode: 'default',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'npm test', description: 'Run tests' },
  permission_suggestions: [
    {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
      behavior: 'allow',
      destination: 'localSettings',
    },
  ],
}

const NOTIFICATION_EVENT = {
  session_id: 's1',
  hook_event_name: 'Notification',
  message: 'Claude is waiting for your input',
  title: 'Claude Code',
  notification_type: 'idle_prompt',
  cwd: '/work/api',
}

test('parses a permission request and keeps unknown suggestion fields', () => {
  expect(parseHookEvent(JSON.stringify(PERMISSION_EVENT))).toEqual({
    kind: 'parsed',
    event: {
      kind: 'PermissionRequest',
      toolName: 'Bash',
      toolInput: { command: 'npm test', description: 'Run tests' },
      permissionSuggestions: PERMISSION_EVENT.permission_suggestions,
      mcpServer: undefined,
      agentType: undefined,
      cwd: '/work/api',
    },
  })
})

test('parses a notification', () => {
  expect(parseHookEvent(JSON.stringify(NOTIFICATION_EVENT))).toEqual({
    kind: 'parsed',
    event: {
      kind: 'Notification',
      message: 'Claude is waiting for your input',
      title: 'Claude Code',
      notificationType: 'idle_prompt',
      agentType: undefined,
      cwd: '/work/api',
    },
  })
})

test('defaults missing suggestions to an empty array', () => {
  const { permission_suggestions: _omitted, ...event } = PERMISSION_EVENT
  const result = parseHookEvent(JSON.stringify(event))
  expect(result.kind).toBe('parsed')
  if (result.kind === 'parsed' && result.event.kind === 'PermissionRequest') {
    expect(result.event.permissionSuggestions).toEqual([])
  }
})

test('reads agent_type and mcp_server', () => {
  const result = parseHookEvent(
    JSON.stringify({ ...PERMISSION_EVENT, agent_type: 'reviewer', mcp_server: 'github' }),
  )
  expect(result.kind).toBe('parsed')
  if (result.kind === 'parsed' && result.event.kind === 'PermissionRequest') {
    expect(result.event.agentType).toBe('reviewer')
    expect(result.event.mcpServer).toBe('github')
  }
})

test('rejects a missing tool_name', () => {
  const { tool_name: _omitted, ...event } = PERMISSION_EVENT
  const result = parseHookEvent(JSON.stringify(event))
  expect(result.kind).toBe('invalid')
  if (result.kind === 'invalid') {
    expect(result.message).toMatch(/^invalid hook input/)
  }
})

test.each([['npm test'], [[]]])('rejects a non-object tool_input %j', (toolInput) => {
  const result = parseHookEvent(JSON.stringify({ ...PERMISSION_EVENT, tool_input: toolInput }))
  expect(result.kind).toBe('invalid')
  if (result.kind === 'invalid') {
    expect(result.message).toMatch(/^invalid hook input/)
  }
})

test.each([
  ['null', 'null'],
  ['[]', 'array'],
])('rejects json %s that is not an object, with no empty path', (raw, received) => {
  expect(parseHookEvent(raw)).toEqual({
    kind: 'invalid',
    message: `invalid hook input: Invalid input: expected object, received ${received}`,
  })
})

test.each(['', 'nope'])('rejects text that is not json %j', (raw) => {
  expect(parseHookEvent(raw)).toEqual({ kind: 'invalid', message: 'hook input is not valid JSON' })
})

test('rejects an unknown event', () => {
  expect(parseHookEvent(JSON.stringify({ hook_event_name: 'Stop' }))).toEqual({
    kind: 'invalid',
    message: 'unsupported hook event "Stop"',
  })
})

test('rejects a missing hook_event_name', () => {
  const result = parseHookEvent(JSON.stringify({ tool_name: 'Bash' }))
  expect(result.kind).toBe('invalid')
  if (result.kind === 'invalid') {
    expect(result.message).toMatch(/^invalid hook input/)
  }
})

test('parses a session start event', () => {
  const raw = JSON.stringify({
    session_id: 's1',
    hook_event_name: 'SessionStart',
    source: 'startup',
    cwd: '/work/api',
    model: 'x',
  })
  expect(parseHookEvent(raw)).toEqual({
    kind: 'parsed',
    event: { kind: 'SessionStart', source: 'startup', cwd: '/work/api' },
  })
})

test('session start without source or cwd parses', () => {
  expect(parseHookEvent(JSON.stringify({ hook_event_name: 'SessionStart' }))).toEqual({
    kind: 'parsed',
    event: { kind: 'SessionStart', source: undefined, cwd: undefined },
  })
})

test('session start with a non-string source is invalid', () => {
  const result = parseHookEvent(JSON.stringify({ hook_event_name: 'SessionStart', source: 3 }))
  expect(result.kind).toBe('invalid')
  if (result.kind === 'invalid') {
    expect(result.message).toMatch(/^invalid hook input: source:/)
  }
})
