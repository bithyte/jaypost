import { isAbsolute, relative } from 'node:path'
import type { Answer } from '@jaypost/client'
import {
  ALLOW_OPTION,
  ALWAYS_ALLOW_OPTION,
  ASK_IN_TERMINAL_OPTION,
  DENY_MESSAGE,
  DENY_OPTION,
  ELLIPSIS,
  MAX_HEADER_LENGTH,
  MAX_HOOK_TEXT_LENGTH,
  MAX_SUGGESTION_LINE_LENGTH,
  MCP_NAME_SEPARATOR,
  MCP_TOOL_PREFIX,
  MULTI_EDIT_SEPARATOR,
  PREVIEW_LABEL,
  PREVIEW_LENGTH,
  SUGGESTION_PREFIX,
  TOO_LONG_LINE,
} from './constants.ts'
import type {
  DecisionResult,
  HookQuestion,
  NotificationEvent,
  PermissionDecision,
  PermissionRequestEvent,
  PermissionSuggestion,
} from './types.ts'

/** The thing being approved, then the context that may be cut or dropped first. */
type ToolBody = { readonly primary: string; readonly secondaries: readonly string[] }

type McpName = { readonly server: string; readonly tool: string }

/**
 * Builds the chat question for a permission request, within `maxLength`. When the primary field
 * has to be cut, only Deny and Ask in terminal are offered. Never throws.
 */
export function formatPermissionQuestion(
  event: PermissionRequestEvent,
  maxLength: number = MAX_HOOK_TEXT_LENGTH,
): HookQuestion {
  const header = cut(
    `${describeActor(event.agentType)} ${describeAction(event)}:`,
    MAX_HEADER_LENGTH,
  )
  const body = describeBody(event)
  const suggestionLine = describeSuggestions(event.permissionSuggestions)
  if (suggestionLine !== undefined) {
    const withSuggestion = fitLayout(
      header,
      body,
      `\n\n${suggestionLine}`,
      [ALLOW_OPTION, ALWAYS_ALLOW_OPTION, DENY_OPTION, ASK_IN_TERMINAL_OPTION],
      maxLength,
    )
    if (withSuggestion !== undefined) {
      return withSuggestion
    }
  }
  // Without the line the owner can't see what Always allow grants, so it goes too; Allow stays.
  const withoutSuggestion = fitLayout(
    header,
    body,
    '',
    [ALLOW_OPTION, DENY_OPTION, ASK_IN_TERMINAL_OPTION],
    maxLength,
  )
  if (withoutSuggestion !== undefined) {
    return withoutSuggestion
  }
  const tooLongPart = `\n\n${TOO_LONG_LINE}`
  const primary = cut(body.primary, maxLength - header.length - 1 - tooLongPart.length)
  return {
    text: `${header}\n${primary}${tooLongPart}`,
    options: [DENY_OPTION, ASK_IN_TERMINAL_OPTION],
  }
}

/** Builds the chat text for a notification, within `maxLength`. Never throws. */
export function formatNotificationText(
  event: NotificationEvent,
  maxLength: number = MAX_HOOK_TEXT_LENGTH,
): string {
  const hasDistinctTitle =
    event.title !== undefined && event.title !== '' && event.title !== event.message
  const body = hasDistinctTitle ? `${event.title}\n\n${event.message}` : event.message
  const text = hasAgent(event.agentType) ? `${describeActor(event.agentType)}:\n${body}` : body
  return cut(text, maxLength)
}

/** Never throws. `offered` is the options sent; an answer outside them is `unknownAnswer`. */
export function decidePermission(
  event: PermissionRequestEvent,
  offered: readonly string[],
  outcome: Answer,
): DecisionResult {
  if (outcome.timedOut) {
    return { kind: 'undecided' }
  }
  if (!offered.includes(outcome.answer)) {
    return { kind: 'unknownAnswer', answer: outcome.answer }
  }
  switch (outcome.answer) {
    case ALLOW_OPTION:
      return decided({ behavior: 'allow' })
    case ALWAYS_ALLOW_OPTION:
      return decided({ behavior: 'allow', updatedPermissions: event.permissionSuggestions })
    case DENY_OPTION:
      return decided({ behavior: 'deny', message: DENY_MESSAGE })
    case ASK_IN_TERMINAL_OPTION:
      return { kind: 'undecided' }
    default:
      return { kind: 'unknownAnswer', answer: outcome.answer }
  }
}

function decided(decision: PermissionDecision): DecisionResult {
  return {
    kind: 'decided',
    output: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } },
  }
}

/** Cuts to `max` characters with an ellipsis, never splitting a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }
  const head = text.slice(0, max - 1)
  const last = head.charCodeAt(head.length - 1)
  // A lone high surrogate makes the text invalid UTF-16, which chat apps reject.
  const isHighSurrogate = last >= 0xd800 && last <= 0xdbff
  return `${isHighSurrogate ? head.slice(0, -1) : head}${ELLIPSIS}`
}

/** Lays out the question with the primary whole; undefined when the primary doesn't fit. */
function fitLayout(
  header: string,
  body: ToolBody,
  suggestionPart: string,
  options: readonly string[],
  maxLength: number,
): HookQuestion | undefined {
  const full = `${[header, body.primary, ...body.secondaries].join('\n')}${suggestionPart}`
  if (full.length <= maxLength) {
    return { text: full, options }
  }
  const room = maxLength - header.length - 1 - suggestionPart.length
  if (body.primary.length > room) {
    return undefined
  }
  const secondaries = fitSecondaries(body.secondaries, room - body.primary.length)
  return { text: `${[header, body.primary, ...secondaries].join('\n')}${suggestionPart}`, options }
}

function fitSecondaries(secondaries: readonly string[], room: number): readonly string[] {
  const kept: string[] = []
  let left = room
  for (const secondary of secondaries) {
    // One character goes to the newline; a lone ellipsis isn't worth showing.
    const available = left - 1
    if (available < 2) {
      continue
    }
    const piece = cut(secondary, available)
    kept.push(piece)
    left -= 1 + piece.length
  }
  return kept
}

function hasAgent(agentType: string | undefined): agentType is string {
  return agentType !== undefined && agentType !== ''
}

function describeActor(agentType: string | undefined): string {
  return hasAgent(agentType) ? `Claude (subagent ${agentType})` : 'Claude'
}

function describeAction(event: PermissionRequestEvent): string {
  if (event.toolName === 'Bash') {
    return 'wants to run Bash'
  }
  const mcpName = parseMcpName(event.toolName, event.mcpServer)
  if (mcpName !== undefined) {
    return `wants to use ${mcpName.tool} (MCP server ${mcpName.server})`
  }
  return `wants to use ${event.toolName}`
}

function parseMcpName(toolName: string, mcpServer: string | undefined): McpName | undefined {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) {
    return undefined
  }
  const rest = toolName.slice(MCP_TOOL_PREFIX.length)
  const serverPrefix = `${mcpServer}${MCP_NAME_SEPARATOR}`
  if (mcpServer !== undefined && mcpServer !== '' && rest.startsWith(serverPrefix)) {
    const tool = rest.slice(serverPrefix.length)
    return tool === '' ? undefined : { server: mcpServer, tool }
  }
  const index = rest.indexOf(MCP_NAME_SEPARATOR)
  const tool = rest.slice(index + MCP_NAME_SEPARATOR.length)
  if (index <= 0 || tool === '') {
    return undefined
  }
  return { server: mcpServer || rest.slice(0, index), tool }
}

function describeBody(event: PermissionRequestEvent): ToolBody {
  const input = event.toolInput
  switch (event.toolName) {
    case 'Bash':
      return withPrimary(input, input.command, [input.description])
    case 'Edit':
      return withPrimary(input, displayPath(input.file_path, event.cwd), [
        preview(input.new_string),
      ])
    case 'MultiEdit':
      return withPrimary(input, displayPath(input.file_path, event.cwd), [
        preview(joinNewStrings(input.edits)),
      ])
    case 'Write':
      return withPrimary(input, displayPath(input.file_path, event.cwd), [preview(input.content)])
    case 'NotebookEdit':
      return withPrimary(input, displayPath(input.notebook_path, event.cwd), [
        preview(input.new_source),
      ])
    case 'Read':
      return withPrimary(input, displayPath(input.file_path, event.cwd), [])
    case 'Glob':
    case 'Grep':
      return withPrimary(input, describePattern(input.pattern, input.path, event.cwd), [])
    case 'WebFetch':
      return withPrimary(input, input.url, [])
    case 'WebSearch':
      return withPrimary(input, input.query, [])
    case 'ExitPlanMode':
      return withPrimary(input, input.plan, [])
    default:
      return toJsonBody(input)
  }
}

/** Falls back to the input JSON when the primary field is missing or not a string. */
function withPrimary(
  input: Readonly<Record<string, unknown>>,
  primary: unknown,
  secondaries: readonly unknown[],
): ToolBody {
  if (typeof primary !== 'string') {
    return toJsonBody(input)
  }
  return {
    primary,
    secondaries: secondaries.flatMap((secondary) =>
      typeof secondary === 'string' && secondary !== '' ? [secondary] : [],
    ),
  }
}

function toJsonBody(input: Readonly<Record<string, unknown>>): ToolBody {
  return { primary: JSON.stringify(input, null, 2), secondaries: [] }
}

function preview(text: unknown): string | undefined {
  return typeof text === 'string' ? `${PREVIEW_LABEL}${cut(text, PREVIEW_LENGTH)}` : undefined
}

function joinNewStrings(edits: unknown): string | undefined {
  if (!Array.isArray(edits)) {
    return undefined
  }
  const newStrings = edits.flatMap((edit: unknown) =>
    typeof edit === 'object' &&
    edit !== null &&
    'new_string' in edit &&
    typeof edit.new_string === 'string'
      ? [edit.new_string]
      : [],
  )
  return newStrings.length === 0 ? undefined : newStrings.join(MULTI_EDIT_SEPARATOR)
}

function describePattern(pattern: unknown, path: unknown, cwd: string | undefined): unknown {
  if (typeof pattern !== 'string' || typeof path !== 'string') {
    return pattern
  }
  return `${pattern} in ${displayPath(path, cwd)}`
}

/** Shows a path relative to `cwd` when it's inside it; anything else passes through. */
function displayPath(path: unknown, cwd: string | undefined): unknown {
  if (typeof path !== 'string' || cwd === undefined || !isAbsolute(path)) {
    return path
  }
  const relativePath = relative(cwd, path)
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return path
  }
  return relativePath
}

/** Returns undefined when there's nothing to show or the line would eat the budget. */
function describeSuggestions(suggestions: readonly PermissionSuggestion[]): string | undefined {
  if (suggestions.length === 0) {
    return undefined
  }
  const line = `${SUGGESTION_PREFIX}${suggestions.flatMap(describeSuggestion).join(', ')}`
  return line.length > MAX_SUGGESTION_LINE_LENGTH ? undefined : line
}

function describeSuggestion(suggestion: PermissionSuggestion): readonly string[] {
  switch (suggestion.type) {
    case 'addRules':
      if (suggestion.rules === undefined || suggestion.rules.length === 0) {
        return [suggestion.type]
      }
      return suggestion.rules.map((rule) =>
        rule.ruleContent === undefined ? rule.toolName : `${rule.toolName}(${rule.ruleContent})`,
      )
    case 'setMode':
      return suggestion.mode === undefined
        ? [suggestion.type]
        : [`switches to ${suggestion.mode} mode`]
    default:
      return [suggestion.type]
  }
}
