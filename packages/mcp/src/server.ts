import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_OPTION_LENGTH,
  MAX_PROJECT_LENGTH,
  MAX_TIMEOUT_SECONDS,
  MESSAGE_FORMATS,
} from '@jaypost/core'
import { Caller, DEFAULT_ATTACHMENT_NAME } from '@jaypost/client'
import type { AttachmentSource, Question, QuestionState } from '@jaypost/client'
import {
  CANCELLED_QUESTION_TEXT,
  PROGRESS_INTERVAL_MS,
  PROGRESS_MESSAGE,
  STILL_WAITING_TEXT,
} from './constants.ts'
import { OpenQuestions } from './questions.ts'
import type { AskArguments, AttachmentArgument, McpOptions, McpServerOptions } from './types.ts'

const INSTRUCTIONS = [
  "jaypost reaches the user on their phone (Telegram or Discord). Use it when they're away from",
  'the terminal: they asked to be pinged or asked on their phone, or the session runs unattended.',
  'Need a decision before you go on: ask_user.',
  'Need a decision later and have other work first: ask_user_async, then wait_for_answer.',
  'Finished, blocked, or something they should know with no answer needed: notify_user.',
  'Make timeout_option the safe choice, the one that changes nothing.',
  'Use the project or repo directory name as project_name, the same in every call.',
].join(' ')

const ATTACH_SENTENCE =
  'Optionally attach a file (path) or long text (over the text limit, see GET /status maxTextLength; such as a diff or log) to show the user as a document with the message.'

const ASK_DESCRIPTION = [
  'Ask the user a question on their phone and wait for their answer.',
  'Use short button labels.',
  'Set allow_text to also let the user type a free-form answer (for questions like which branch or what name); options can then be empty.',
  'Blocks until the user answers or the timeout passes;',
  'on timeout it returns timeout_option, so make that the safe choice.',
  `Default wait ${DEFAULT_TIMEOUT_SECONDS} s, max ${MAX_TIMEOUT_SECONDS} s (24 h).`,
  'For commands and diffs, set format to "markdown" and put them in a fenced code block.',
  ATTACH_SENTENCE,
].join(' ')

const ASK_ASYNC_DESCRIPTION = [
  'Ask the user a question on their phone and return at once with a request_id;',
  'call wait_for_answer with it when you need the answer.',
  'Use this when you have other work to do before you need the answer, or when a long blocking',
  'call is not possible; otherwise use ask_user.',
  'On timeout the answer is timeout_option, so make that the safe choice.',
  `Default timeout ${DEFAULT_TIMEOUT_SECONDS} s, max ${MAX_TIMEOUT_SECONDS} s (24 h).`,
  'Questions still open when this session ends are cancelled.',
  'For commands and diffs, set format to "markdown" and put them in a fenced code block.',
  ATTACH_SENTENCE,
].join(' ')

const WAIT_DESCRIPTION = [
  'Wait for the answer to a question asked with ask_user_async.',
  'Without wait_seconds it waits until the user answers or the question times out;',
  'wait_seconds 0 checks once. Results stay readable for 24 h after the question settles.',
  'Cancelling this call stops waiting but leaves the question open.',
].join(' ')

const NOTIFY_DESCRIPTION = [
  "Tell the user something they don't need to answer, for example that a task finished",
  "or that you're stuck and need help. Returns once sent; doesn't wait for the user.",
  'For commands and diffs, set format to "markdown" and put them in a fenced code block.',
  ATTACH_SENTENCE,
].join(' ')

const projectNameSchema = z
  .string()
  .min(1)
  .max(MAX_PROJECT_LENGTH)
  .describe('Short name of the project you are working in, shown as [name] above the message')

const textSchema = z
  .string()
  .min(1)
  .describe('Message to show the user; see format for commands and diffs')

const FORMAT_DESCRIPTION =
  'markdown shows **bold**, *italic*, `inline code` and fenced ``` blocks; put commands and diffs in a fenced block (```diff, ```sh) so the user sees them exactly'

const formatSchema = z.enum(MESSAGE_FORMATS).optional().describe(FORMAT_DESCRIPTION)

const attachmentSchema = z
  .union([
    z.strictObject({
      path: z
        .string()
        .min(1)
        .describe('File to attach, read by the MCP server. Absolute, or relative to its cwd'),
      name: attachmentNameSchema(),
    }),
    z.strictObject({
      text: z.string().min(1).describe('Text to attach, e.g. a diff you already have in context'),
      name: attachmentNameSchema(),
    }),
  ])
  .optional()
  .describe('One file or text shown as a document above the message; give path or text, not both')

function attachmentNameSchema() {
  return z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe(
      `File name shown in the chat app; use a real extension (.diff, .log) since the app uses it. Default the path's basename, or ${DEFAULT_ATTACHMENT_NAME}`,
    )
}

const askInputSchema = {
  project_name: projectNameSchema,
  text: textSchema,
  format: formatSchema,
  options: z
    .array(z.string().min(1).max(MAX_OPTION_LENGTH))
    .optional()
    .describe('Button labels, unique. May be omitted or empty with allow_text'),
  allow_text: z
    .boolean()
    .optional()
    .describe('Let the user type an answer by replying. Default false'),
  timeout_option: z
    .string()
    .describe(
      'Answer returned if the user does not answer in time; one of options, or with allow_text any short answer (max 64 chars)',
    ),
  timeout_seconds: z
    .number()
    .positive()
    .optional()
    .describe(
      `Seconds to wait for an answer; default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS} (24 h); longer values are capped`,
    ),
  attachment: attachmentSchema,
}

/**
 * MCP server with ask_user, ask_user_async, wait_for_answer and notify_user; aborting `signal`
 * cancels every call. Background questions it asks go into `options.openQuestions`.
 */
export function createMcpServer(
  caller: Caller,
  signal: AbortSignal,
  options: McpServerOptions,
): McpServer {
  const progressIntervalMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS
  const openQuestions = options.openQuestions ?? new OpenQuestions()
  const server = new McpServer(
    { name: 'jaypost', version: options.version },
    { instructions: INSTRUCTIONS },
  )
  server.registerTool(
    'ask_user',
    {
      description: ASK_DESCRIPTION,
      inputSchema: askInputSchema,
      outputSchema: { answer: z.string(), timed_out: z.boolean() },
    },
    async (args, extra): Promise<CallToolResult> => {
      const stopProgress = startProgress(
        extra,
        Math.min(args.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS),
        progressIntervalMs,
      )
      const result = await caller
        .ask(toQuestion(args), { signal: AbortSignal.any([extra.signal, signal]) })
        .finally(stopProgress)
      if (result.kind === 'failed') {
        return toErrorResult(result.message)
      }
      return {
        content: [{ type: 'text', text: formatAnswer(result.answer, result.timedOut) }],
        structuredContent: { answer: result.answer, timed_out: result.timedOut },
      }
    },
  )
  server.registerTool(
    'ask_user_async',
    {
      description: ASK_ASYNC_DESCRIPTION,
      inputSchema: askInputSchema,
      outputSchema: { request_id: z.string(), expires_at: z.string() },
    },
    async (args, extra): Promise<CallToolResult> => {
      const result = await caller.askInBackground(toQuestion(args), {
        signal: AbortSignal.any([extra.signal, signal]),
      })
      if (result.kind === 'failed') {
        return toErrorResult(result.message)
      }
      const { id, expiresAt } = result
      openQuestions.add(id)
      return {
        content: [
          {
            type: 'text',
            text: `Asked. Call wait_for_answer with request_id ${id} when you need the answer (expires ${expiresAt}).`,
          },
        ],
        structuredContent: { request_id: id, expires_at: expiresAt },
      }
    },
  )
  server.registerTool(
    'wait_for_answer',
    {
      description: WAIT_DESCRIPTION,
      inputSchema: {
        request_id: z.string().min(1).describe('The request_id from ask_user_async'),
        wait_seconds: z
          .number()
          .min(0)
          .optional()
          .describe(
            `Seconds to wait at most; omit to wait until the question settles, 0 checks once; max ${MAX_TIMEOUT_SECONDS} (24 h), longer values are capped`,
          ),
      },
      outputSchema: {
        state: z.enum(['pending', 'done', 'cancelled']),
        answer: z.string().optional(),
        timed_out: z.boolean().optional(),
      },
    },
    async (args, extra): Promise<CallToolResult> => {
      const waitSeconds =
        args.wait_seconds === undefined
          ? undefined
          : Math.min(args.wait_seconds, MAX_TIMEOUT_SECONDS)
      const stopProgress = startProgress(extra, waitSeconds, progressIntervalMs)
      const result = await caller
        .waitFor(args.request_id, {
          signal: AbortSignal.any([extra.signal, signal]),
          ...(waitSeconds === undefined ? {} : { waitSeconds }),
        })
        .finally(stopProgress)
      if (result.kind === 'failed') {
        if (result.reason === 'unknownRequest') {
          openQuestions.settle(args.request_id)
        }
        return toErrorResult(result.message)
      }
      if (result.kind !== 'pending') {
        openQuestions.settle(args.request_id)
      }
      return toWaitResult(result)
    },
  )
  server.registerTool(
    'notify_user',
    {
      description: NOTIFY_DESCRIPTION,
      inputSchema: {
        project_name: projectNameSchema,
        text: textSchema,
        format: formatSchema,
        attachment: attachmentSchema,
      },
    },
    async (args, extra): Promise<CallToolResult> => {
      const result = await caller.notify(
        {
          project: args.project_name,
          text: args.text,
          ...(args.format === undefined ? {} : { format: args.format }),
          ...(args.attachment === undefined
            ? {}
            : { attachment: toAttachmentSource(args.attachment) }),
        },
        { signal: AbortSignal.any([extra.signal, signal]) },
      )
      if (result.kind === 'failed') {
        return toErrorResult(result.message)
      }
      return { content: [{ type: 'text', text: 'sent' }] }
    },
  )
  return server
}

/**
 * Serves MCP on stdin/stdout until stdin ends or closes, then cancels in-flight calls, cancels the
 * background questions it asked that haven't settled (best effort, bounded by
 * `CANCEL_TIMEOUT_MS`), and closes. Resolves 0. Writes nothing to stdout but JSON-RPC.
 */
export async function runMcp(options: McpOptions): Promise<number> {
  const { version, ...callerOptions } = options
  const caller = new Caller(callerOptions)
  const controller = new AbortController()
  const openQuestions = new OpenQuestions()
  const server = createMcpServer(caller, controller.signal, { version, openQuestions })
  // The SDK transport doesn't notice the end of stdin by itself.
  const stdinDone = new Promise<void>((resolve) => {
    process.stdin.once('end', resolve)
    process.stdin.once('close', resolve)
  })
  await server.connect(new StdioServerTransport())
  await stdinDone
  controller.abort()
  await openQuestions.cancelAll(caller)
  await server.close()
  return 0
}

// Keeps the client's idle timeout from firing; does nothing without a progress token.
function startProgress(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  totalSeconds: number | undefined,
  intervalMs: number,
): () => void {
  const progressToken = extra._meta?.progressToken
  if (progressToken === undefined) {
    return () => {}
  }
  const startedAt = performance.now()
  const timer = setInterval(() => {
    extra
      .sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: Math.floor((performance.now() - startedAt) / 1000),
          ...(totalSeconds === undefined ? {} : { total: totalSeconds }),
          message: PROGRESS_MESSAGE,
        },
      })
      .catch(() => {
        // The connection is closing; the call is being cancelled anyway.
      })
  }, intervalMs)
  return () => clearInterval(timer)
}

function toWaitResult(state: Exclude<QuestionState, { kind: 'failed' }>): CallToolResult {
  switch (state.kind) {
    case 'pending':
      return {
        content: [{ type: 'text', text: STILL_WAITING_TEXT }],
        structuredContent: { state: 'pending' },
      }
    case 'done':
      return {
        content: [{ type: 'text', text: formatAnswer(state.answer, state.timedOut) }],
        structuredContent: { state: 'done', answer: state.answer, timed_out: state.timedOut },
      }
    case 'cancelled':
      return {
        content: [{ type: 'text', text: CANCELLED_QUESTION_TEXT }],
        structuredContent: { state: 'cancelled' },
      }
  }
}

function toAttachmentSource(attachment: AttachmentArgument): AttachmentSource {
  if ('path' in attachment) {
    return attachment.name === undefined
      ? { path: attachment.path }
      : { path: attachment.path, name: attachment.name }
  }
  return { name: attachment.name ?? DEFAULT_ATTACHMENT_NAME, text: attachment.text }
}

function toQuestion(args: AskArguments): Question {
  return {
    project: args.project_name,
    text: args.text,
    ...(args.format === undefined ? {} : { format: args.format }),
    ...(args.options === undefined ? {} : { options: args.options }),
    ...(args.allow_text === undefined ? {} : { allowText: args.allow_text }),
    timeoutOption: args.timeout_option,
    ...(args.timeout_seconds === undefined ? {} : { timeout: args.timeout_seconds }),
    ...(args.attachment === undefined ? {} : { attachment: toAttachmentSource(args.attachment) }),
  }
}

function formatAnswer(answer: string, timedOut: boolean): string {
  return timedOut ? `${answer} (timed out, no answer from the user)` : answer
}

function toErrorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}
