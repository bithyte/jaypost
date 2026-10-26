import { setTimeout as delay } from 'node:timers/promises'
import { DEFAULT_TIMEOUT_SECONDS } from '@jaypost/core'
import { Caller, FETCH_GRACE_MS } from '@jaypost/client'
import {
  ASK_IN_TERMINAL_OPTION,
  ASK_USER_QUESTION_TOOL,
  DEFAULT_STOP_TIMEOUT_SECONDS,
  DONE_OPTION,
  IDLE_PROMPT_DELETE_AFTER_SECONDS,
  IDLE_PROMPT_NOTIFICATION,
  MAX_HOOK_TEXT_LENGTH,
  REPLY_PREFIX,
  REWAKE_EXIT_CODE,
  SESSION_ID_PATTERN,
  STOP_DELAY_MS,
  STOP_POLL_MS,
} from './constants.ts'
import {
  decidePermission,
  formatNotificationText,
  formatPermissionQuestion,
  formatStopQuestion,
} from './formatter.ts'
import { isCurrentStopMarker, removeStopMarker, writeStopMarker } from './marker.ts'
import { parseHookEvent } from './parser.ts'
import { resolveHookProject } from './project.ts'
import { checkService, findManualSetup } from './setup.ts'
import type {
  HookArgs,
  HookDeps,
  NotificationEvent,
  PermissionRequestEvent,
  SessionMovedOnEvent,
  SessionStartEvent,
  StopEvent,
} from './types.ts'

/**
 * Handles one hook event from stdin. Returns 0 when handled, 1 on any failure (stderr says why),
 * and 2 when a Stop gets a typed reply, which is printed for Claude Code's `asyncRewake` to read.
 */
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
  if (event.kind === 'UserPromptSubmit' || event.kind === 'SessionEnd') {
    return clearStop(event, deps)
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
  if (event.kind === 'Stop') {
    return askNextPrompt(event, project, args, caller, deps)
  }
  const maxLength = await resolveMaxLength(project, caller, deps.signal)
  switch (event.kind) {
    case 'Notification':
      return notify(event, project, maxLength, caller, deps)
    case 'PermissionRequest':
      return askPermission(event, project, maxLength, args, caller, deps)
  }
}

/** A prompt typed in the terminal or the session's end: drops the marker, so a waiting Stop hook cancels its question. */
function clearStop(event: SessionMovedOnEvent, deps: HookDeps): number {
  if (SESSION_ID_PATTERN.test(event.sessionId)) {
    removeStopMarker(deps.stopDirectory, event.sessionId)
  }
  return 0
}

/**
 * Stop: after a short delay, asks for the next prompt and waits for it. A typed reply is printed
 * and exits 2 to wake Claude; Done, a timeout, or the session moving on exit 0. The marker file
 * is how the session moving on reaches this process, which Claude Code runs in the background.
 */
async function askNextPrompt(
  event: StopEvent,
  project: string,
  args: HookArgs,
  caller: Caller,
  deps: HookDeps,
): Promise<number> {
  if (!SESSION_ID_PATTERN.test(event.sessionId)) {
    deps.printError(`jaypost: session id ${JSON.stringify(event.sessionId)} isn't usable`)
    return 1
  }
  let token: string
  try {
    token = writeStopMarker(deps.stopDirectory, event.sessionId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    deps.printError(`jaypost: couldn't write the stop marker: ${message}`)
    return 1
  }
  const movedOn = new AbortController()
  const watch = setInterval(() => {
    if (!isCurrentStopMarker(deps.stopDirectory, event.sessionId, token)) {
      movedOn.abort()
    }
  }, deps.stopPollMs ?? STOP_POLL_MS)
  try {
    return await waitForNextPrompt(
      event,
      project,
      args,
      caller,
      AbortSignal.any([deps.signal, movedOn.signal]),
      deps,
    )
  } finally {
    clearInterval(watch)
    removeStopMarker(deps.stopDirectory, event.sessionId, token)
  }
}

/** Aborting `signal` (killed, or the session moved on) cancels the question and exits 0. */
async function waitForNextPrompt(
  event: StopEvent,
  project: string,
  args: HookArgs,
  caller: Caller,
  signal: AbortSignal,
  deps: HookDeps,
): Promise<number> {
  try {
    await delay(deps.stopDelayMs ?? STOP_DELAY_MS, undefined, { signal })
  } catch {
    // Only an abort rejects it: nothing was sent yet, so there's nothing to cancel.
    return 0
  }
  const maxLength = await resolveMaxLength(project, caller, signal)
  const question = formatStopQuestion(event, maxLength)
  const started = await caller.askInBackground(
    {
      project,
      text: question.text,
      options: question.options,
      allowText: true,
      timeoutOption: DONE_OPTION,
      timeout: args.timeout ?? DEFAULT_STOP_TIMEOUT_SECONDS,
    },
    // Not `signal`: an abort mid-call could leave a sent question whose id never comes back, so
    // nothing could cancel it. The call is short; the abort is handled once the id is known.
    { signal: new AbortController().signal },
  )
  if (started.kind === 'failed') {
    return signal.aborted ? 0 : reportFailure(started.message, deps)
  }
  if (signal.aborted) {
    await caller.cancel(started.id, { signal: AbortSignal.timeout(FETCH_GRACE_MS) })
    return 0
  }
  const state = await caller.waitFor(started.id, { signal })
  if (signal.aborted) {
    await caller.cancel(started.id, { signal: AbortSignal.timeout(FETCH_GRACE_MS) })
    return 0
  }
  switch (state.kind) {
    case 'failed':
      return reportFailure(state.message, deps)
    case 'pending':
    case 'cancelled':
      return 0
    case 'done':
      if (state.timedOut || state.answer === DONE_OPTION) {
        return 0
      }
      deps.print(`${REPLY_PREFIX}${state.answer}`)
      return REWAKE_EXIT_CODE
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
async function resolveMaxLength(
  project: string,
  caller: Caller,
  signal: AbortSignal,
): Promise<number> {
  const result = await caller.status({ signal })
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
    {
      project,
      text: formatNotificationText(event, maxLength),
      ...(event.notificationType === IDLE_PROMPT_NOTIFICATION
        ? { deleteAfter: IDLE_PROMPT_DELETE_AFTER_SECONDS }
        : {}),
    },
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
