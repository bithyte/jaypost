import type { ClientToken } from '@jaypost/store'
import type { ServiceEndpoint } from '@jaypost/client'

/** One `permission_suggestions` entry; passed back unchanged, unknown fields included. */
export type PermissionSuggestion = {
  readonly type: string
  readonly rules?: readonly { readonly toolName: string; readonly ruleContent?: string }[]
  readonly mode?: string
  readonly [key: string]: unknown
}

export type PermissionRequestEvent = {
  readonly kind: 'PermissionRequest'
  readonly toolName: string
  readonly toolInput: Readonly<Record<string, unknown>>
  /** Empty when the event had none. */
  readonly permissionSuggestions: readonly PermissionSuggestion[]
  readonly mcpServer: string | undefined
  readonly agentType: string | undefined
  readonly cwd: string | undefined
}

export type NotificationEvent = {
  readonly kind: 'Notification'
  readonly message: string
  readonly title: string | undefined
  readonly notificationType: string | undefined
  readonly agentType: string | undefined
  readonly cwd: string | undefined
}

export type SessionStartEvent = {
  readonly kind: 'SessionStart'
  readonly source: string | undefined
  readonly cwd: string | undefined
}

export type HookEvent = PermissionRequestEvent | NotificationEvent | SessionStartEvent

export type HookParseResult =
  | { readonly kind: 'parsed'; readonly event: HookEvent }
  | { readonly kind: 'invalid'; readonly message: string }

/** A question ready for POST /request; `options` already reduced when the primary field was cut. */
export type HookQuestion = { readonly text: string; readonly options: readonly string[] }

export type PermissionDecision =
  | { readonly behavior: 'allow'; readonly updatedPermissions?: readonly PermissionSuggestion[] }
  | { readonly behavior: 'deny'; readonly message: string }

/** What the hook writes on stdout, as one JSON line. */
export type HookOutput = {
  readonly hookSpecificOutput: {
    readonly hookEventName: 'PermissionRequest'
    readonly decision: PermissionDecision
  }
}

export type DecisionResult =
  | { readonly kind: 'decided'; readonly output: HookOutput }
  | { readonly kind: 'undecided' }
  | { readonly kind: 'unknownAnswer'; readonly answer: string }

/** Parsed `hook` flags; absent fields mean the user didn't pass them. */
export type HookArgs = { readonly project?: string; readonly timeout?: number }

/** Everything `runHook` touches outside itself; aborting `signal` cancels the call silently. */
export type HookDeps = {
  readonly endpoint: ServiceEndpoint
  /** Found the same way as for `send` and `mcp`; `unusable` fails right after the input is parsed (SessionStart reports it instead). */
  readonly token: ClientToken
  readonly signal: AbortSignal
  /** All of stdin; rejects when `signal` aborts. */
  readonly readInput: () => Promise<string>
  readonly print: (text: string) => void
  readonly printError: (text: string) => void
  /** For `CLAUDE_PROJECT_DIR`. */
  readonly env: NodeJS.ProcessEnv
}
