import type { MessageFormat } from '@jaypost/core'
import type { CallerOptions } from '@jaypost/client'
import type { OpenQuestions } from './questions.ts'

/** What `runMcp` needs: where the service is, and the version to report to MCP clients. */
export type McpOptions = CallerOptions & {
  readonly version: string
}

/** The version `createMcpServer` reports to MCP clients, plus optional tuning. */
export type McpServerOptions = {
  readonly version: string
  readonly progressIntervalMs?: number
  /** Where background questions are recorded for the shutdown cancel; default a fresh set. */
  readonly openQuestions?: OpenQuestions
}

/** A background question as `list_questions` shows it; `expiresAt` is when its timeout fires. */
export type OpenQuestion = {
  readonly id: string
  readonly project: string
  readonly text: string
  readonly expiresAt: string
}

/** The `attachment` input of the ask and notify tools: a file path or literal text. */
export type AttachmentArgument =
  | { readonly path: string; readonly name?: string | undefined }
  | { readonly text: string; readonly name?: string | undefined }

/** Arguments of the two ask tools, as the MCP SDK hands them over. */
export type AskArguments = {
  readonly project_name: string
  readonly text: string
  readonly format?: MessageFormat | undefined
  readonly options?: readonly string[] | undefined
  readonly allow_text?: boolean | undefined
  readonly timeout_option: string
  readonly timeout_seconds?: number | undefined
  readonly attachment?: AttachmentArgument | undefined
}
