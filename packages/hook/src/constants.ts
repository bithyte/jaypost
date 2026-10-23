export const ALLOW_OPTION = 'Allow'
export const ALWAYS_ALLOW_OPTION = 'Always allow'
export const DENY_OPTION = 'Deny'
export const ASK_IN_TERMINAL_OPTION = 'Ask in terminal'
/** Reason Claude Code gets with a Deny, so it knows the user said no from their phone. */
export const DENY_MESSAGE = 'the user denied this from jaypost'
/** Ends a question whose primary field was cut; only Deny and Ask in terminal are offered. */
export const TOO_LONG_LINE = 'Too long to show in full; answer in the terminal to allow it.'
/** Cap on any hook-built text; a lower service limit lowers it. */
export const MAX_HOOK_TEXT_LENGTH = 3000
/** Characters of new text previewed for Edit, MultiEdit, Write and NotebookEdit. */
export const PREVIEW_LENGTH = 500
/** Cap on the "Claude wants to ..." line, so a long agent or MCP name can't crowd the body. */
export const MAX_HEADER_LENGTH = 200
/** Longer "Always allow adds" lines are dropped, and Always allow with them. */
export const MAX_SUGGESTION_LINE_LENGTH = 1000
/** Cap on the SessionStart /status call, so a hung service can't stall session startup. */
export const SETUP_STATUS_TIMEOUT_MS = 2000
/** Project name when no flag, `CLAUDE_PROJECT_DIR` or `cwd` gives one. */
export const DEFAULT_PROJECT = 'claude'
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion'
export const PREVIEW_LABEL = 'New text (preview):\n'
export const SUGGESTION_PREFIX = 'Always allow adds: '
export const MCP_TOOL_PREFIX = 'mcp__'
export const MCP_NAME_SEPARATOR = '__'
export const MULTI_EDIT_SEPARATOR = '\n---\n'
export const ELLIPSIS = '…'
/** A hand-written `jaypost hook` command, bare, a path or `npx -y jaypost@x`; not the plugin wrapper. */
export const MANUAL_HOOK_PATTERN = /(^|[\s/])jaypost(@\S+)? hook(\s|$)/
/** A hand-written `jaypost mcp` server command line (command and args joined by spaces). */
export const MANUAL_MCP_PATTERN = /(^|[\s/])jaypost(@\S+)? mcp(\s|$)/
