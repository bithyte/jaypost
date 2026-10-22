import { z } from 'zod'
import type { HookEvent, HookParseResult } from './types.ts'

const BASE_SCHEMA = z.looseObject({ hook_event_name: z.string() })

const SUGGESTION_SCHEMA = z.looseObject({
  type: z.string(),
  rules: z
    .array(z.looseObject({ toolName: z.string(), ruleContent: z.string().optional() }))
    .optional(),
  mode: z.string().optional(),
})

const PERMISSION_SCHEMA = z.looseObject({
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()),
  permission_suggestions: z.array(SUGGESTION_SCHEMA).optional(),
  mcp_server: z.string().optional(),
  agent_type: z.string().optional(),
  cwd: z.string().optional(),
})

const NOTIFICATION_SCHEMA = z.looseObject({
  message: z.string(),
  title: z.string().optional(),
  notification_type: z.string().optional(),
  agent_type: z.string().optional(),
  cwd: z.string().optional(),
})

const SESSION_START_SCHEMA = z.looseObject({
  source: z.string().optional(),
  cwd: z.string().optional(),
})

function invalid(error: z.ZodError): HookParseResult {
  const issue = error.issues[0]
  if (issue === undefined) {
    return { kind: 'invalid', message: 'invalid hook input: unknown problem' }
  }
  const detail =
    issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`
  return { kind: 'invalid', message: `invalid hook input: ${detail}` }
}

function parsed(event: HookEvent): HookParseResult {
  return { kind: 'parsed', event }
}

/** Parses the JSON Claude Code writes to a hook's stdin. Never throws. */
export function parseHookEvent(raw: string): HookParseResult {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { kind: 'invalid', message: 'hook input is not valid JSON' }
  }
  const base = BASE_SCHEMA.safeParse(json)
  if (!base.success) {
    return invalid(base.error)
  }
  switch (base.data.hook_event_name) {
    case 'PermissionRequest': {
      const result = PERMISSION_SCHEMA.safeParse(json)
      if (!result.success) {
        return invalid(result.error)
      }
      const data = result.data
      return parsed({
        kind: 'PermissionRequest',
        toolName: data.tool_name,
        toolInput: data.tool_input,
        permissionSuggestions: data.permission_suggestions ?? [],
        mcpServer: data.mcp_server,
        agentType: data.agent_type,
        cwd: data.cwd,
      })
    }
    case 'Notification': {
      const result = NOTIFICATION_SCHEMA.safeParse(json)
      if (!result.success) {
        return invalid(result.error)
      }
      const data = result.data
      return parsed({
        kind: 'Notification',
        message: data.message,
        title: data.title,
        notificationType: data.notification_type,
        agentType: data.agent_type,
        cwd: data.cwd,
      })
    }
    case 'SessionStart': {
      const result = SESSION_START_SCHEMA.safeParse(json)
      if (!result.success) {
        return invalid(result.error)
      }
      return parsed({ kind: 'SessionStart', source: result.data.source, cwd: result.data.cwd })
    }
    default:
      return {
        kind: 'invalid',
        message: `unsupported hook event ${JSON.stringify(base.data.hook_event_name)}`,
      }
  }
}
