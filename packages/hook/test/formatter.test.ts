import { expect, test } from 'vite-plus/test'
import {
  ASK_IN_TERMINAL_OPTION,
  DENY_OPTION,
  MAX_HEADER_LENGTH,
  MAX_HOOK_TEXT_LENGTH,
  TOO_LONG_LINE,
  decidePermission,
  formatNotificationText,
  formatPermissionQuestion,
} from '../src/index.ts'
import type {
  NotificationEvent,
  PermissionRequestEvent,
  PermissionSuggestion,
} from '../src/index.ts'

const ADD_RULES: PermissionSuggestion = {
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
  behavior: 'allow',
  destination: 'localSettings',
  extra: { kept: true },
}

const FULL_OPTIONS = ['Allow', 'Always allow', 'Deny', 'Ask in terminal']
const SHORT_OPTIONS = ['Allow', 'Deny', 'Ask in terminal']
const LONE_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function createPermissionEvent(overrides: Partial<PermissionRequestEvent>): PermissionRequestEvent {
  return {
    kind: 'PermissionRequest',
    toolName: 'Bash',
    toolInput: { command: 'npm test', description: 'Run tests' },
    permissionSuggestions: [],
    mcpServer: undefined,
    agentType: undefined,
    cwd: '/work/api',
    ...overrides,
  }
}

function createNotificationEvent(overrides: Partial<NotificationEvent>): NotificationEvent {
  return {
    kind: 'Notification',
    message: 'Claude is waiting for your input',
    title: 'Claude Code',
    notificationType: 'idle_prompt',
    agentType: undefined,
    cwd: '/work/api',
    ...overrides,
  }
}

function textFor(toolName: string, toolInput: Record<string, unknown>): string {
  return formatPermissionQuestion(createPermissionEvent({ toolName, toolInput })).text
}

const EVENT = createPermissionEvent({ permissionSuggestions: [ADD_RULES] })
const OFFERED = FULL_OPTIONS

test('bash shows the command, then the description, then the always allow line', () => {
  expect(
    formatPermissionQuestion(createPermissionEvent({ permissionSuggestions: [ADD_RULES] })),
  ).toEqual({
    text: 'Claude wants to run Bash:\nnpm test\nRun tests\n\nAlways allow adds: Bash(npm test:*)',
    options: FULL_OPTIONS,
  })
})

test('without suggestions there is no always allow', () => {
  expect(formatPermissionQuestion(createPermissionEvent({}))).toEqual({
    text: 'Claude wants to run Bash:\nnpm test\nRun tests',
    options: SHORT_OPTIONS,
  })
})

test('subagent requests name the agent', () => {
  expect(formatPermissionQuestion(createPermissionEvent({ agentType: 'Explore' })).text).toBe(
    'Claude (subagent Explore) wants to run Bash:\nnpm test\nRun tests',
  )
})

test('edit shows the relative path and a labeled preview', () => {
  expect(
    formatPermissionQuestion(
      createPermissionEvent({
        toolName: 'Edit',
        toolInput: { file_path: '/work/api/src/a.ts', old_string: 'a', new_string: 'b' },
      }),
    ),
  ).toEqual({
    text: 'Claude wants to use Edit:\nsrc/a.ts\nNew text (preview):\nb',
    options: SHORT_OPTIONS,
  })
  expect(textFor('Edit', { file_path: '/work/api/a.ts', new_string: 'x'.repeat(600) })).toBe(
    `Claude wants to use Edit:\na.ts\nNew text (preview):\n${'x'.repeat(499)}…`,
  )
})

test('write outside cwd keeps the absolute path', () => {
  expect(textFor('Write', { file_path: '/etc/hosts', content: 'x' })).toBe(
    'Claude wants to use Write:\n/etc/hosts\nNew text (preview):\nx',
  )
  expect(textFor('Write', { file_path: '/work/api-other/a.ts', content: 'x' })).toBe(
    'Claude wants to use Write:\n/work/api-other/a.ts\nNew text (preview):\nx',
  )
})

test('multi edit joins the new strings', () => {
  expect(
    textFor('MultiEdit', {
      file_path: '/work/api/src/a.ts',
      edits: [
        { old_string: 'a', new_string: 'one' },
        { old_string: 'b', new_string: 'two' },
      ],
    }),
  ).toBe('Claude wants to use MultiEdit:\nsrc/a.ts\nNew text (preview):\none\n---\ntwo')
})

test('notebook edit shows the notebook path', () => {
  expect(
    textFor('NotebookEdit', { notebook_path: '/work/api/n.ipynb', new_source: 'print(1)' }),
  ).toBe('Claude wants to use NotebookEdit:\nn.ipynb\nNew text (preview):\nprint(1)')
})

test('read, glob and grep show the path or pattern', () => {
  expect(textFor('Read', { file_path: '/work/api/README.md' })).toBe(
    'Claude wants to use Read:\nREADME.md',
  )
  expect(textFor('Glob', { pattern: '**/*.ts' })).toBe('Claude wants to use Glob:\n**/*.ts')
  expect(textFor('Grep', { pattern: 'TODO', path: 'src' })).toBe(
    'Claude wants to use Grep:\nTODO in src',
  )
})

test('web fetch shows the url and web search the query', () => {
  expect(textFor('WebFetch', { url: 'https://example.com', prompt: 'summarize' })).toBe(
    'Claude wants to use WebFetch:\nhttps://example.com',
  )
  expect(textFor('WebSearch', { query: 'zod 4' })).toBe('Claude wants to use WebSearch:\nzod 4')
})

test('exit plan mode shows the plan', () => {
  expect(textFor('ExitPlanMode', { plan: '1. Add the hook\n2. Test it' })).toBe(
    'Claude wants to use ExitPlanMode:\n1. Add the hook\n2. Test it',
  )
})

test('mcp tools name the server and show the input json', () => {
  expect(textFor('mcp__github__create_issue', { title: 'Bug' })).toBe(
    'Claude wants to use create_issue (MCP server github):\n{\n  "title": "Bug"\n}',
  )
  expect(
    formatPermissionQuestion(
      createPermissionEvent({
        toolName: 'mcp__my__server__list',
        toolInput: {},
        mcpServer: 'my__server',
      }),
    ).text,
  ).toBe('Claude wants to use list (MCP server my__server):\n{}')
})

test('unknown tools show the input json', () => {
  expect(textFor('Task', { prompt: 'look around' })).toBe(
    'Claude wants to use Task:\n{\n  "prompt": "look around"\n}',
  )
})

test('a missing primary field falls back to the input json', () => {
  expect(formatPermissionQuestion(createPermissionEvent({ toolInput: { cmd: 'ls' } }))).toEqual({
    text: 'Claude wants to run Bash:\n{\n  "cmd": "ls"\n}',
    options: SHORT_OPTIONS,
  })
  expect(textFor('Bash', { command: 42, description: 'odd' })).toBe(
    'Claude wants to run Bash:\n{\n  "command": 42,\n  "description": "odd"\n}',
  )
  expect(textFor('Edit', { file_path: ['a'] })).toBe(
    'Claude wants to use Edit:\n{\n  "file_path": [\n    "a"\n  ]\n}',
  )
})

test('an empty description adds no line', () => {
  expect(textFor('Bash', { command: 'ls', description: '' })).toBe('Claude wants to run Bash:\nls')
})

test('describes set mode and unknown suggestion types', () => {
  const question = formatPermissionQuestion(
    createPermissionEvent({
      permissionSuggestions: [
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
        { type: 'addDirectories', directories: ['/x'], destination: 'session' },
      ],
    }),
  )
  expect(question.text).toBe(
    'Claude wants to run Bash:\nnpm test\nRun tests\n\nAlways allow adds: switches to acceptEdits mode, addDirectories',
  )
  const ruleless = formatPermissionQuestion(
    createPermissionEvent({
      permissionSuggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'WebSearch' }, { toolName: 'Read', ruleContent: '//tmp/**' }],
        },
      ],
    }),
  )
  expect(ruleless.text).toBe(
    'Claude wants to run Bash:\nnpm test\nRun tests\n\nAlways allow adds: WebSearch, Read(//tmp/**)',
  )
})

test('an oversized suggestion line drops always allow', () => {
  const rules = Array.from({ length: 200 }, (_, index) => ({
    toolName: 'Bash',
    ruleContent: `npm run script-number-${index}:*`,
  }))
  const question = formatPermissionQuestion(
    createPermissionEvent({ permissionSuggestions: [{ type: 'addRules', rules }] }),
  )
  expect(question).toEqual({
    text: 'Claude wants to run Bash:\nnpm test\nRun tests',
    options: SHORT_OPTIONS,
  })
  expect(question.text.length).toBeLessThanOrEqual(MAX_HOOK_TEXT_LENGTH)
})

test('long previews are cut before the command', () => {
  const command = 'a'.repeat(2900)
  const question = formatPermissionQuestion(
    createPermissionEvent({
      toolInput: { command, description: 'd'.repeat(500) },
      permissionSuggestions: [ADD_RULES],
    }),
  )
  expect(question).toEqual({
    text: `Claude wants to run Bash:\n${command}\n${'d'.repeat(35)}…\n\nAlways allow adds: Bash(npm test:*)`,
    options: FULL_OPTIONS,
  })
  expect(question.text.length).toBe(MAX_HOOK_TEXT_LENGTH)
})

test('a secondary with no room left is dropped', () => {
  const command = 'a'.repeat(2974)
  expect(
    formatPermissionQuestion(createPermissionEvent({ toolInput: { command, description: 'd' } })),
  ).toEqual({ text: `Claude wants to run Bash:\n${command}`, options: SHORT_OPTIONS })
})

test('a primary that fits without the suggestion line drops only always allow', () => {
  const command = 'a'.repeat(2500)
  const question = formatPermissionQuestion(
    createPermissionEvent({
      toolInput: { command, description: 'Run tests' },
      permissionSuggestions: [
        { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'r'.repeat(900) }] },
      ],
    }),
  )
  expect(question).toEqual({
    text: `Claude wants to run Bash:\n${command}\nRun tests`,
    options: SHORT_OPTIONS,
  })
})

test('a smaller maxLength cuts the question to it', () => {
  const question = formatPermissionQuestion(
    createPermissionEvent({ toolInput: { command: 'x'.repeat(5000) } }),
    400,
  )
  expect(question.text.length).toBeLessThanOrEqual(400)
  expect(question.options).toEqual([DENY_OPTION, ASK_IN_TERMINAL_OPTION])
})

test('a smaller maxLength cuts the notification to it', () => {
  const text = formatNotificationText(createNotificationEvent({ message: 'm'.repeat(5000) }), 400)
  expect(text.length).toBe(400)
})

test('a cut command offers only deny and ask in terminal', () => {
  const question = formatPermissionQuestion(
    createPermissionEvent({
      toolInput: { command: 'a'.repeat(5000), description: 'Run it' },
      permissionSuggestions: [ADD_RULES],
    }),
  )
  expect(question.options).toEqual([DENY_OPTION, ASK_IN_TERMINAL_OPTION])
  expect(question.text.startsWith('Claude wants to run Bash:\naaa')).toBe(true)
  expect(question.text.endsWith(`a…\n\n${TOO_LONG_LINE}`)).toBe(true)
  expect(question.text).not.toContain('Always allow adds')
  expect(question.text).not.toContain('Run it')
  expect(question.text.length).toBe(MAX_HOOK_TEXT_LENGTH)
})

test('a cut never leaves a lone surrogate', () => {
  const command = formatPermissionQuestion(
    createPermissionEvent({ toolInput: { command: `a${'😀'.repeat(3000)}` } }),
  )
  expect(command.text).not.toMatch(LONE_SURROGATE_PATTERN)
  expect(command.text.endsWith(`😀…\n\n${TOO_LONG_LINE}`)).toBe(true)
  const edit = textFor('Edit', { file_path: '/work/api/a.ts', new_string: '😀'.repeat(300) })
  expect(edit).not.toMatch(LONE_SURROGATE_PATTERN)
  expect(edit.endsWith('😀…')).toBe(true)
  const notification = formatNotificationText(
    createNotificationEvent({ title: undefined, message: '😀'.repeat(2000) }),
  )
  expect(notification).not.toMatch(LONE_SURROGATE_PATTERN)
})

test('a long tool name is capped in the first line', () => {
  const text = textFor('x'.repeat(300), { a: 1 })
  const [firstLine] = text.split('\n')
  expect(firstLine).toBe(`Claude wants to use ${'x'.repeat(MAX_HEADER_LENGTH - 21)}…`)
  expect(firstLine?.length).toBe(MAX_HEADER_LENGTH)
})

test('notification shows title and message', () => {
  expect(formatNotificationText(createNotificationEvent({}))).toBe(
    'Claude Code\n\nClaude is waiting for your input',
  )
})

test('notification without a distinct title shows the message', () => {
  expect(formatNotificationText(createNotificationEvent({ title: undefined }))).toBe(
    'Claude is waiting for your input',
  )
  expect(
    formatNotificationText(createNotificationEvent({ title: 'Claude is waiting for your input' })),
  ).toBe('Claude is waiting for your input')
})

test('notification from a subagent names the agent', () => {
  expect(formatNotificationText(createNotificationEvent({ agentType: 'Explore' }))).toBe(
    'Claude (subagent Explore):\nClaude Code\n\nClaude is waiting for your input',
  )
})

test('long notifications are cut to 3000', () => {
  expect(
    formatNotificationText(
      createNotificationEvent({ title: undefined, message: 'm'.repeat(5000) }),
    ),
  ).toBe(`${'m'.repeat(2999)}…`)
})

test('allow maps to an allow decision', () => {
  expect(decidePermission(EVENT, OFFERED, { answer: 'Allow', timedOut: false })).toEqual({
    kind: 'decided',
    output: {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    },
  })
})

test('always allow passes suggestions through unchanged', () => {
  const result = decidePermission(EVENT, OFFERED, { answer: 'Always allow', timedOut: false })
  expect(result).toEqual({
    kind: 'decided',
    output: {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedPermissions: [
            {
              type: 'addRules',
              rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
              behavior: 'allow',
              destination: 'localSettings',
              extra: { kept: true },
            },
          ],
        },
      },
    },
  })
})

test('deny carries the message and no interrupt', () => {
  expect(decidePermission(EVENT, OFFERED, { answer: 'Deny', timedOut: false })).toEqual({
    kind: 'decided',
    output: {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'the user denied this from jaypost' },
      },
    },
  })
})

test('ask in terminal decides nothing', () => {
  expect(decidePermission(EVENT, OFFERED, { answer: 'Ask in terminal', timedOut: false })).toEqual({
    kind: 'undecided',
  })
})

test('a timeout decides nothing whatever the answer', () => {
  expect(decidePermission(EVENT, OFFERED, { answer: 'Allow', timedOut: true })).toEqual({
    kind: 'undecided',
  })
})

test('an answer that was not offered is unknown', () => {
  expect(
    decidePermission(EVENT, ['Deny', 'Ask in terminal'], { answer: 'Allow', timedOut: false }),
  ).toEqual({ kind: 'unknownAnswer', answer: 'Allow' })
  expect(decidePermission(EVENT, OFFERED, { answer: 'Maybe', timedOut: false })).toEqual({
    kind: 'unknownAnswer',
    answer: 'Maybe',
  })
})

test('an offered answer that is not a known button is unknown', () => {
  expect(decidePermission(EVENT, ['Other'], { answer: 'Other', timedOut: false })).toEqual({
    kind: 'unknownAnswer',
    answer: 'Other',
  })
})
