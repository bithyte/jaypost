import { format } from 'node:util'
import type { ApprovalRequest, AskProgress, VoteResult } from '../approval/index.ts'
import { parseApprovalRequest, SendError, toVoteReport, VoterSendError } from '../approval/index.ts'
import {
  ATTACHMENT_NOT_SUPPORTED_MESSAGE,
  readAttachment,
  toAskBody,
  toNotifyBody,
} from '../client/index.ts'
import type { AttachmentBody, AttachmentSource } from '../client/index.ts'
import { formatMaskCommands, loadDirectConfig, openDirectSession } from '../direct/index.ts'
import type { DirectConfig, DirectSession } from '../direct/index.ts'
import { parseNotifyRequest } from '../notify/index.ts'
import { formatDuration } from '../progress/index.ts'
import type { ProgressStep } from '../progress/index.ts'
import { resolveMaxAttachmentBytes, resolveVoters } from '../provider/index.ts'
import { formatWaitTitle } from './answer-wait.ts'
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
 * timeout, 1 on any failure or a cancel, with the reason on stderr. With voters or a rule it runs
 * a vote instead, one message per voter, and returns 0 when approved, `DECLINED_EXIT_CODE` when
 * rejected (running out of rounds included), 1 on failure or a cancel.
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
  const wait = startAskWait(deps, provider.label, undefined, args.timeoutOption)
  const result = await withSession(prepared.config, deps, (session) =>
    session.request(parsed.value, deps.signal, args.retryCount, wait?.onProgress),
  )
  if (result.kind === 'failed') {
    wait?.step().fail()
    deps.printError(`jaypost: ${result.message}`)
    return 1
  }
  switch (result.value.kind) {
    case 'cancelled':
      wait?.step().cancel('Cancelled')
      deps.printError(`jaypost: ${DIRECT_CANCELLED_MESSAGE}`)
      return 1
    case 'completed': {
      const { outcome } = result.value
      wait
        ?.step()
        .succeed(
          outcome.timedOut
            ? `Timed out, answered ${outcome.answer}`
            : `Answered after ${formatDuration(wait.elapsedMs())}`,
        )
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
  const rawVoters = args.voters ?? []
  // On stderr because the Action's run.sh and `$(...)` capture stdout only; the runner processes
  // workflow commands on both streams.
  for (const line of formatMaskCommands(rawVoters, deps.env)) {
    deps.printError(line)
  }
  // loadDirectConfig requires the owner, so `noOwner` can't happen.
  const resolved = resolveVoters(config.provider, config.settings, args.voters)
  if (resolved.kind === 'noOwner') {
    throw new Error('direct config has no owner')
  }
  if (resolved.kind === 'invalid') {
    deps.printError(`jaypost: invalid user id ${JSON.stringify(resolved.voter)}`)
    return 1
  }
  const { voters } = resolved
  // Only the voters given are masked; the owner id is already a whole secret.
  const rawIds = new Set(rawVoters.map((voter) => voter.trim()))
  const extraIds = args.voters === undefined ? [] : voters.filter((voter) => !rawIds.has(voter))
  for (const line of formatMaskCommands(extraIds, deps.env)) {
    deps.printError(line)
  }
  const rule = args.rule ?? 'all'
  const wait = startAskWait(deps, config.provider.label, voters.length, args.timeoutOption)
  const result = await withSession(config, deps, (session) =>
    session.vote(
      { request, voters, rule, retryCount: args.retryCount ?? 0 },
      deps.signal,
      wait?.onProgress,
    ),
  )
  if (result.kind === 'failed') {
    wait?.step().fail()
    deps.printError(`jaypost: ${result.message}`)
    return 1
  }
  if (result.value.kind === 'cancelled') {
    wait?.step().cancel('Cancelled')
    deps.printError(`jaypost: ${DIRECT_CANCELLED_MESSAGE}`)
    return 1
  }
  wait?.step().succeed(describeVoteEnd(result.value))
  deps.print(formatVoteResult(toVoteReport(result.value, rule), args.json))
  return result.value.approved ? 0 : DECLINED_EXIT_CODE
}

type AskWait = {
  readonly onProgress: (event: AskProgress) => void
  /** The step running now: "Sending", or the latest wait. */
  readonly step: () => ProgressStep
  /** Time since the first round was sent. */
  readonly elapsedMs: () => number
}

/**
 * The title of a vote's countdown line: the round (unless there is only one), the votes in and
 * the time left.
 */
export function formatRoundTitle(
  event: {
    readonly round: number
    readonly roundCount: number
    readonly votedCount: number
    readonly voterCount: number
  },
  remainingMs: number,
): string {
  const prefix = event.roundCount === 1 ? '' : `Round ${event.round} of ${event.roundCount}: `
  return `${prefix}${event.votedCount} of ${event.voterCount} voted, ${formatDuration(remainingMs)} left`
}

/**
 * Starts "Sending" and returns the callback that moves the line along as rounds go out and votes
 * come in; undefined off a live terminal. `voterCount` is undefined for a single question.
 */
function startAskWait(
  deps: DirectSendDeps,
  label: string,
  voterCount: number | undefined,
  timeoutOption: string,
): AskWait | undefined {
  const { progress } = deps
  if (progress.mode !== 'live') {
    return undefined
  }
  const now = deps.now ?? (() => performance.now())
  let step = progress.start('Sending')
  let firstSentAt: number | undefined
  let deadline = 0
  let position = { round: 1, roundCount: 1, votedCount: 0 }
  const title = (): string =>
    voterCount === undefined
      ? formatWaitTitle(deadline - now(), timeoutOption)
      : formatRoundTitle({ ...position, voterCount }, deadline - now())
  const onProgress = (event: AskProgress): void => {
    if (event.kind === 'voted') {
      position = { ...position, votedCount: event.votedCount }
      return
    }
    const sentAt = now()
    firstSentAt ??= sentAt
    deadline = sentAt + event.timeoutSeconds * 1000
    position = { ...position, round: event.round, roundCount: event.roundCount }
    step.succeed(
      event.round === 1
        ? `Sent to ${label}`
        : `No answer, asking again (round ${event.round} of ${event.roundCount})`,
    )
    step = progress.start(title)
  }
  return {
    onProgress,
    step: () => step,
    elapsedMs: () => now() - (firstSentAt ?? now()),
  }
}

function describeVoteEnd(result: Extract<VoteResult, { readonly kind: 'decided' }>): string {
  if (!result.approved) {
    return 'Rejected'
  }
  const votedCount = result.votes.filter((vote) => vote.answer !== undefined).length
  return `Approved, ${votedCount} of ${result.votes.length} voted`
}

/**
 * Sends a notification through the provider in-process, configured from env only; stdout stays
 * empty and a terminal gets a "Sent to ..." line on stderr. Returns 0 once the provider accepts
 * it, 1 on any failure.
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
  if (deps.progress.mode === 'live') {
    deps.progress.done(`Sent to ${provider.label}`)
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
  // On a live terminal raw stderr lines would land inside the countdown, so they become notes.
  const isLive = deps.progress.mode === 'live'
  const printLog = isLive ? deps.progress.note : deps.printError
  const logError = isLive
    ? (message: string, error: unknown) => deps.progress.note(format(message, error))
    : undefined
  let session: DirectSession
  try {
    session = await openDirectSession(config, (line) => printLog(`jaypost: ${line}`), logError)
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
