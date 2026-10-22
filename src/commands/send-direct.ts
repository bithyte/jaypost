import type { ApprovalRequest } from '../approval/index.ts'
import { parseApprovalRequest, SendError, VoterSendError } from '../approval/index.ts'
import {
  ATTACHMENT_NOT_SUPPORTED_MESSAGE,
  readAttachment,
  toAskBody,
  toNotifyBody,
} from '../client/index.ts'
import type { AttachmentBody, AttachmentSource } from '../client/index.ts'
import { loadDirectConfig, openDirectSession } from '../direct/index.ts'
import type { DirectConfig, DirectSession } from '../direct/index.ts'
import { parseNotifyRequest } from '../notify/index.ts'
import { findOwnerSetting, resolveMaxAttachmentBytes } from '../provider/index.ts'
import {
  DECLINED_EXIT_CODE,
  DIRECT_CANCELLED_MESSAGE,
  DIRECT_SEND_FAILED_MESSAGE,
} from './constants.ts'
import { formatAnswer, formatVoteResult, toMessage, toQuestion } from './send.ts'
import type { DirectSendDeps, SendNotifyArgs, SendRequestArgs } from './types.ts'

type Prepared =
  | {
      readonly kind: 'ready'
      readonly config: DirectConfig
      readonly attachment: AttachmentBody | undefined
    }
  | { readonly kind: 'failed'; readonly message: string }

type SessionResult<T> =
  | { readonly kind: 'done'; readonly value: T }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * Asks through the provider in-process, configured from env only, and prints the answer like
 * `runSendRequest`. Returns 0 for any other answer, `DECLINED_EXIT_CODE` for the `-d` answer or a
 * timeout, 1 on any failure or a cancel, with the reason on stderr.
 */
export async function runDirectSendRequest(
  args: SendRequestArgs,
  deps: DirectSendDeps,
): Promise<number> {
  const prepared = await prepare(args.attachment, deps)
  if (prepared.kind === 'failed') {
    deps.printError(`jaypost: ${prepared.message}`)
    return 1
  }
  const { provider } = prepared.config
  const parsed = parseApprovalRequest(
    toAskBody(toQuestion(args), prepared.attachment),
    provider.maxTextLength,
    resolveMaxAttachmentBytes(provider),
    provider.maxOptionCount,
  )
  if (!parsed.ok) {
    deps.printError(`jaypost: ${parsed.error}`)
    return 1
  }
  if (args.voters !== undefined || args.rule !== undefined) {
    return runDirectVote(args, parsed.value, prepared.config, deps)
  }
  const result = await withSession(prepared.config, deps, (session) =>
    session.request(parsed.value, deps.signal, args.retryCount),
  )
  if (result.kind === 'failed') {
    deps.printError(`jaypost: ${result.message}`)
    return 1
  }
  switch (result.value.kind) {
    case 'cancelled':
      deps.printError(`jaypost: ${DIRECT_CANCELLED_MESSAGE}`)
      return 1
    case 'completed': {
      const { outcome } = result.value
      deps.print(formatAnswer(outcome.answer, outcome.timedOut, args.json))
      return outcome.timedOut || outcome.answer === args.timeoutOption ? DECLINED_EXIT_CODE : 0
    }
  }
}

/** Runs the vote `args` asks for: voters default to the owner, the rule to `all`. */
async function runDirectVote(
  args: SendRequestArgs,
  request: ApprovalRequest,
  config: DirectConfig,
  deps: DirectSendDeps,
): Promise<number> {
  const voters = args.voters === undefined ? [ownerVoter(config)] : [...new Set(args.voters)]
  const parse = findOwnerSetting(config.provider)?.parse
  for (const voter of voters) {
    if (parse !== undefined && parse(voter) === undefined) {
      deps.printError(`jaypost: invalid user id ${JSON.stringify(voter)}`)
      return 1
    }
  }
  const rule = args.rule ?? 'all'
  const result = await withSession(config, deps, (session) =>
    session.vote({ request, voters, rule, retryCount: args.retryCount ?? 0 }, deps.signal),
  )
  if (result.kind === 'failed') {
    deps.printError(`jaypost: ${result.message}`)
    return 1
  }
  if (result.value.kind === 'cancelled') {
    deps.printError(`jaypost: ${DIRECT_CANCELLED_MESSAGE}`)
    return 1
  }
  deps.print(formatVoteResult(result.value, rule, args.json))
  return result.value.approved ? 0 : DECLINED_EXIT_CODE
}

/** The owner's id as a string; `loadDirectConfig` guarantees the setting is present. */
function ownerVoter(config: DirectConfig): string {
  const key = findOwnerSetting(config.provider)?.configKey
  const value = key === undefined ? undefined : config.settings[key]
  if (value === undefined) {
    throw new Error('direct config has no owner')
  }
  return String(value)
}

/**
 * Sends a notification through the provider in-process, configured from env only; prints nothing
 * on success. Returns 0 once the provider accepts it, 1 on any failure.
 */
export async function runDirectSendNotify(
  args: SendNotifyArgs,
  deps: DirectSendDeps,
): Promise<number> {
  const prepared = await prepare(args.attachment, deps)
  if (prepared.kind === 'failed') {
    deps.printError(`jaypost: ${prepared.message}`)
    return 1
  }
  const { provider } = prepared.config
  const parsed = parseNotifyRequest(
    toNotifyBody(toMessage(args), prepared.attachment),
    provider.maxTextLength,
    resolveMaxAttachmentBytes(provider),
  )
  if (!parsed.ok) {
    deps.printError(`jaypost: ${parsed.error}`)
    return 1
  }
  const result = await withSession(prepared.config, deps, (session) => session.notify(parsed.value))
  if (result.kind === 'failed') {
    deps.printError(`jaypost: ${result.message}`)
    return 1
  }
  return 0
}

/** Loads the env config, then reads the attachment; nothing reaches the provider yet. */
async function prepare(
  source: AttachmentSource | undefined,
  deps: DirectSendDeps,
): Promise<Prepared> {
  let config: DirectConfig
  try {
    config = loadDirectConfig(deps.env, deps.providers)
  } catch (error) {
    return { kind: 'failed', message: describeError(error) }
  }
  if (source === undefined) {
    return { kind: 'ready', config, attachment: undefined }
  }
  if (resolveMaxAttachmentBytes(config.provider) === 0) {
    return { kind: 'failed', message: ATTACHMENT_NOT_SUPPORTED_MESSAGE }
  }
  const read = await readAttachment(source, deps.signal)
  if (read.kind === 'failed') {
    return read
  }
  return { kind: 'ready', config, attachment: read.body }
}

/** Opens a session, runs `use` and always stops the runtime; failures come back as messages. */
async function withSession<T>(
  config: DirectConfig,
  deps: DirectSendDeps,
  use: (session: DirectSession) => Promise<T>,
): Promise<SessionResult<T>> {
  let session: DirectSession
  try {
    session = await openDirectSession(config, (line) => deps.printError(`jaypost: ${line}`))
  } catch (error) {
    return { kind: 'failed', message: describeError(error) }
  }
  try {
    return { kind: 'done', value: await use(session) }
  } catch (error) {
    return { kind: 'failed', message: describeError(error) }
  } finally {
    await session.stop()
  }
}

// A SendError's cause can hold provider internals, even the token; the server hides it too.
function describeError(error: unknown): string {
  if (error instanceof VoterSendError) {
    return `${DIRECT_SEND_FAILED_MESSAGE} to ${error.voter}`
  }
  if (error instanceof SendError) {
    return DIRECT_SEND_FAILED_MESSAGE
  }
  return error instanceof Error ? error.message : String(error)
}
