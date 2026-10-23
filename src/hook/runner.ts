import { DEFAULT_TIMEOUT_SECONDS } from '../approval/index.ts'
import { Caller } from '../client/index.ts'
import {
  ASK_IN_TERMINAL_OPTION,
  ASK_USER_QUESTION_TOOL,
  MAX_HOOK_TEXT_LENGTH,
} from './constants.ts'
import { decidePermission, formatNotificationText, formatPermissionQuestion } from './formatter.ts'
import { parseHookEvent } from './parser.ts'
import { resolveHookProject } from './project.ts'
import { checkService, findManualSetup } from './setup.ts'
import type {
  HookArgs,
  HookDeps,
  NotificationEvent,
  PermissionRequestEvent,
  SessionStartEvent,
} from './types.ts'

/** Handles one hook event from stdin. Returns 0 when handled, 1 on any failure (stderr says why). */
export async function runHook(args: HookArgs, deps: HookDeps): Promise<number> {
  let input: string
  try {
    input = await deps.readInput()
  } catch (error) {
    if (!deps.signal.aborted) {
      const message = error instanceof Error ? error.message : String(error)
      deps.printError(`jaypost: couldn't read the hook input: ${message}`)
    }
    return 1
  }
  const parsed = parseHookEvent(input)
  if (parsed.kind === 'invalid') {
    deps.printError(`jaypost: ${parsed.message}`)
    return 1
  }
  const event = parsed.event
  if (event.kind === 'SessionStart') {
    return checkSetup(event, deps)
  }
  if (deps.token.kind === 'unusable') {
    deps.printError(`jaypost: ${deps.token.message}`)
    return 1
  }
  const project = resolveHookProject(args.project, deps.env, event.cwd)
  // A plain allow doesn't answer AskUserQuestion, so the terminal keeps it (spec non-goal).
  if (event.kind === 'PermissionRequest' && event.toolName === ASK_USER_QUESTION_TOOL) {
    return 0
  }
  const caller = new Caller({ endpoint: deps.endpoint, readToken: () => deps.token })
  const maxLength = await resolveMaxLength(project, caller, deps)
  switch (event.kind) {
    case 'Notification':
      return notify(event, project, maxLength, caller, deps)
    case 'PermissionRequest':
      return askPermission(event, project, maxLength, args, caller, deps)
  }
}

/** SessionStart: prints one systemMessage listing what's wrong, nothing when all is well. Exits 0. */
async function checkSetup(event: SessionStartEvent, deps: HookDeps): Promise<number> {
  const caller = new Caller({ endpoint: deps.endpoint, readToken: () => deps.token })
  const lines = [await checkService(caller, deps)].filter((line) => line !== undefined)
  const manualPaths = findManualSetup(deps.env.HOME, deps.env.CLAUDE_PROJECT_DIR ?? event.cwd)
  if (manualPaths.length > 0) {
    lines.push(
      `jaypost is also set up by hand in ${manualPaths.join(', ')}. The plugin already adds its hooks and MCP server, so remove the jaypost entries there or prompts reach your phone twice.`,
    )
  }
  if (lines.length > 0 && !deps.signal.aborted) {
    deps.print(JSON.stringify({ systemMessage: lines.join('\n') }))
  }
  return 0
}

/**
 * The text cap: the service's limit less the `[project]` line it adds, at most
 * MAX_HOOK_TEXT_LENGTH. A failed /status call isn't reported; the request that follows is.
 */
async function resolveMaxLength(project: string, caller: Caller, deps: HookDeps): Promise<number> {
  const result = await caller.status({ signal: deps.signal })
  if (result.kind === 'status' && typeof result.status.maxTextLength === 'number') {
    return Math.min(MAX_HOOK_TEXT_LENGTH, result.status.maxTextLength - (project.length + 4))
  }
  return MAX_HOOK_TEXT_LENGTH
}

async function notify(
  event: NotificationEvent,
  project: string,
  maxLength: number,
  caller: Caller,
  deps: HookDeps,
): Promise<number> {
  const result = await caller.notify(
    { project, text: formatNotificationText(event, maxLength) },
    { signal: deps.signal },
  )
  if (result.kind === 'failed') {
    return reportFailure(result.message, deps)
  }
  return 0
}

async function askPermission(
  event: PermissionRequestEvent,
  project: string,
  maxLength: number,
  args: HookArgs,
  caller: Caller,
  deps: HookDeps,
): Promise<number> {
  const question = formatPermissionQuestion(event, maxLength)
  const result = await caller.ask(
    {
      project,
      text: question.text,
      options: question.options,
      timeoutOption: ASK_IN_TERMINAL_OPTION,
      timeout: args.timeout ?? DEFAULT_TIMEOUT_SECONDS,
    },
    { signal: deps.signal },
  )
  if (result.kind === 'failed') {
    return reportFailure(result.message, deps)
  }
  const decision = decidePermission(event, question.options, {
    answer: result.answer,
    timedOut: result.timedOut,
  })
  switch (decision.kind) {
    case 'decided':
      deps.print(JSON.stringify(decision.output))
      return 0
    case 'undecided':
      return 0
    case 'unknownAnswer':
      deps.printError(`jaypost: unexpected answer ${JSON.stringify(decision.answer)}`)
      return 1
  }
}

/** Killed hooks stay silent: the abort is ours, not a failure worth reporting. */
function reportFailure(message: string, deps: HookDeps): number {
  if (!deps.signal.aborted) {
    deps.printError(`jaypost: ${message}`)
  }
  return 1
}
