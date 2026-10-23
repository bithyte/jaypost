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
/** Tapped, or answered on timeout, to let a finished session stop. */
export const DONE_OPTION = 'Done'
/** Default wait for a reply to a Stop question; `--timeout` overrides it. */
export const DEFAULT_STOP_TIMEOUT_SECONDS = 3600
/** Matches idle_prompt's minute, so a prompt typed at the desk sends nothing to the phone. */
export const STOP_DELAY_MS = 60_000
export const STOP_POLL_MS = 1000
export const STOP_HEADER = 'Claude finished'
export const STOP_FOOTER = 'Reply with the next prompt, or tap Done.'
/** Starts what Claude reads when a phone reply wakes it. */
export const REPLY_PREFIX = 'The user replied from their phone with the next prompt:\n\n'
/** Exit code that makes an `asyncRewake` hook wake Claude with its output. */
export const REWAKE_EXIT_CODE = 2
/** Claude Code session ids are UUIDs; anything else can't name a marker file. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
/** Folder under the jaypost config directory that holds the Stop markers. */
export const STOP_DIRECTORY_NAME = 'stop'
