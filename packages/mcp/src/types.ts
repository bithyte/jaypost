import type { MessageFormat } from '@jaypost/core'
import type { OpenQuestions } from './questions.ts'

/** Tuning for `createMcpServer`; every field is optional. */
export type McpServerOptions = {
  readonly progressIntervalMs?: number
  /** Where background questions are recorded for the shutdown cancel; default a fresh set. */
  readonly openQuestions?: OpenQuestions
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
