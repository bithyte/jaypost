import { appendText } from '../format/index.ts'
import { CANCELLED_RESULT, CANCELLED_ROUND, CANCELLED_VOTE, TIMED_OUT_ROUND } from './constants.ts'
import { formatVoteProgress } from './formatter.ts'
import { SendError } from './service.ts'
import type { ApprovalService } from './service.ts'
import { decideVote } from './vote.ts'
import type {
  ApprovalRequest,
  AskProgress,
  RetryResult,
  RoundEnd,
  Vote,
  VoteCounts,
  VoteReport,
  VoteResult,
  VoteRule,
  VoteService,
  VoteState,
  VoterAnswer,
  VoterQuestion,
} from './types.ts'

/**
 * Sending to `voter` failed. The message names only the voter, never the cause, since a provider
 * error can hold the bot token; the original error is in `cause`.
 */
export class VoterSendError extends SendError {
  readonly voter: string

  constructor(voter: string, options?: ErrorOptions) {
    super(`failed to send message to ${voter}`, options)
    this.voter = voter
  }
}

/**
 * Asks `request` up to `retryCount + 1` times, asking again only after a timeout; every round but
 * the last ends its message as re-asked. Throws `SendError` like `ApprovalService.request`. An
 * aborted `signal` resolves as cancelled and asks nothing more. `onProgress` gets `sent` once each
 * round's message is out.
 */
export async function askWithRetries(
  service: Pick<ApprovalService, 'send'>,
  request: ApprovalRequest,
  retryCount: number,
  signal: AbortSignal,
  onProgress?: (event: AskProgress) => void,
): Promise<RetryResult> {
  for (let round = 1; ; round += 1) {
    if (signal.aborted) {
      return CANCELLED_RESULT
    }
    const isLast = round > retryCount
    const sent = await service.send({ ...request, reaskOnTimeout: !isLast }, signal)
    onProgress?.({
      kind: 'sent',
      round,
      roundCount: retryCount + 1,
      timeoutSeconds: request.timeoutSeconds,
    })
    const result = await sent.result
    if (result.kind === 'cancelled') {
      return result
    }
    if (isLast || !result.outcome.timedOut) {
      return { ...result, roundCount: round }
    }
  }
}

/**
 * Asks every voter in parallel, one message each, for up to `retryCount + 1` rounds; each round
 * asks only voters who haven't voted. Each vote that doesn't decide shows the tally under every
 * voter's latest message. Once decided, every open message is closed with the vote's answer and
 * every answered voter's message shows the complete tally.
 * Rounds running out reject, counting missing votes as rejections. Throws `VoterSendError` when a
 * send fails, after cancelling the messages that were sent. An aborted `signal` cancels every open
 * message and resolves as cancelled. Settles only once every update it sent has landed.
 * `onProgress` gets `sent` once every send of a round is out and `voted` after each recorded vote.
 */
export async function runVote(
  service: VoteService,
  vote: Vote,
  signal: AbortSignal,
  onProgress?: (event: AskProgress) => void,
): Promise<VoteResult> {
  const state: VoteState = { answers: new Map(), latest: new Map(), updates: [] }
  try {
    return await runRounds(service, vote, state, signal, onProgress)
  } finally {
    // So no update is still on its way when the caller exits.
    await Promise.all(state.updates)
  }
}

async function runRounds(
  service: VoteService,
  vote: Vote,
  state: VoteState,
  signal: AbortSignal,
  onProgress: ((event: AskProgress) => void) | undefined,
): Promise<VoteResult> {
  const roundCount = vote.retryCount + 1
  for (let round = 1; round <= roundCount; round += 1) {
    if (signal.aborted) {
      return CANCELLED_VOTE
    }
    const asked = vote.voters.filter((voter) => !state.answers.has(voter))
    const end = await runRound(
      service,
      vote,
      asked,
      { round, roundCount },
      state,
      signal,
      onProgress,
    )
    if (end.kind === 'cancelled') {
      return CANCELLED_VOTE
    }
    if (end.kind === 'decided') {
      return toVoteResult(vote, state.answers, end.approved, round, false)
    }
  }
  return toVoteResult(vote, state.answers, false, roundCount, true)
}

type RoundPosition = { readonly round: number; readonly roundCount: number }

/** Sends one round to `asked` and records their votes in `state` as they arrive. */
async function runRound(
  service: VoteService,
  vote: Vote,
  asked: readonly string[],
  position: RoundPosition,
  state: VoteState,
  signal: AbortSignal,
  onProgress: ((event: AskProgress) => void) | undefined,
): Promise<RoundEnd> {
  const isLast = position.round === position.roundCount
  const controllers = asked.map(() => new AbortController())
  const abortAll = () => {
    for (const controller of controllers) {
      controller.abort()
    }
  }
  signal.addEventListener('abort', abortAll, { once: true })
  try {
    const sends = await Promise.allSettled(
      asked.map((voter, index) =>
        service
          .send(
            { ...vote.request, recipient: voter, reaskOnTimeout: !isLast },
            controllers[index]?.signal,
          )
          .then(
            (sent): VoterQuestion => ({ ...sent, voter }),
            (cause: unknown) => {
              throw new VoterSendError(voter, { cause })
            },
          ),
      ),
    )
    const questions = sends.flatMap((send) => (send.status === 'fulfilled' ? [send.value] : []))
    const failure = sends.find((send) => send.status === 'rejected')
    if (failure !== undefined) {
      abortAll()
      await Promise.all(questions.map((question) => question.result))
      throw failure.reason
    }
    for (const question of questions) {
      state.latest.set(question.voter, question)
    }
    onProgress?.({
      kind: 'sent',
      ...position,
      timeoutSeconds: vote.request.timeoutSeconds,
    })
    return await collectRound(service, vote, questions, state, position, onProgress)
  } finally {
    signal.removeEventListener('abort', abortAll)
  }
}

/**
 * Records each answer as it arrives until the vote is decided or every message settled. Results
 * that arrive after the decision (the closed messages) are never counted.
 */
async function collectRound(
  service: VoteService,
  vote: Vote,
  questions: readonly VoterQuestion[],
  state: VoteState,
  position: RoundPosition,
  onProgress: ((event: AskProgress) => void) | undefined,
): Promise<RoundEnd> {
  const { answers } = state
  const waiting = new Map(
    questions.map((question) => [
      question.voter,
      question.result.then((result) => ({ voter: question.voter, result })),
    ]),
  )
  let isCancelled = false
  while (waiting.size > 0) {
    const { voter, result } = await Promise.race(waiting.values())
    waiting.delete(voter)
    if (result.kind === 'cancelled') {
      isCancelled = true
      continue
    }
    if (result.outcome.timedOut) {
      continue
    }
    answers.set(voter, result.outcome.answer)
    onProgress?.({
      kind: 'voted',
      ...position,
      votedCount: answers.size,
      voterCount: vote.voters.length,
    })
    const decision = decideVote(vote.rule, countVotes(vote, answers))
    if (decision !== 'undecided') {
      const approved = decision === 'approved'
      const answer = toVoteAnswer(vote.request, approved)
      for (const question of questions) {
        if (waiting.has(question.voter)) {
          service.close(question.id, answer)
        }
      }
      // No message is open now: answered voters, the deciding one too, get the complete tally.
      state.updates.push(...updateProgress(service, vote, state, new Map()))
      // So every closed message is finalized before the caller exits.
      await Promise.all(waiting.values())
      return { kind: 'decided', approved }
    }
    state.updates.push(...updateProgress(service, vote, state, waiting))
  }
  return isCancelled ? CANCELLED_ROUND : TIMED_OUT_ROUND
}

/**
 * Shows the tally under each voter's latest message: an open one keeps its question and buttons,
 * an answered one its final text. Messages that timed out or were cancelled are left alone.
 */
function updateProgress(
  service: VoteService,
  vote: Vote,
  state: VoteState,
  waiting: ReadonlyMap<string, unknown>,
): Promise<void>[] {
  const progress = `\n\n${formatVoteProgress(toVoterAnswers(vote, state.answers))}`
  return vote.voters.flatMap((voter) => {
    const question = state.latest.get(voter)
    if (question === undefined) {
      return []
    }
    if (waiting.has(voter)) {
      const buttons = { id: question.id, options: vote.request.options }
      return [service.update(question, appendText(question.message, progress), buttons)]
    }
    const finalText = state.answers.has(voter) ? question.finalText() : undefined
    if (finalText === undefined) {
      return []
    }
    return [service.update(question, appendText(finalText, progress), undefined)]
  })
}

function countVotes(vote: Vote, answers: ReadonlyMap<string, string>): VoteCounts {
  const values = [...answers.values()]
  const approveCount = values.filter((answer) => answer === toVoteAnswer(vote.request, true)).length
  return {
    voterCount: vote.voters.length,
    approveCount,
    rejectCount: values.length - approveCount,
  }
}

function toVoteAnswer(request: ApprovalRequest, approved: boolean): string {
  return approved ? request.options[0] : request.options[1]
}

function toVoterAnswers(vote: Vote, answers: ReadonlyMap<string, string>): VoterAnswer[] {
  return vote.voters.map((voter) => ({ voter, answer: answers.get(voter) }))
}

function toVoteResult(
  vote: Vote,
  answers: ReadonlyMap<string, string>,
  approved: boolean,
  roundCount: number,
  timedOut: boolean,
): VoteResult {
  return {
    kind: 'decided',
    approved,
    answer: toVoteAnswer(vote.request, approved),
    votes: toVoterAnswers(vote, answers),
    roundCount,
    timedOut,
  }
}

/** The JSON report of a decided vote under `rule`. */
export function toVoteReport(
  result: Extract<VoteResult, { readonly kind: 'decided' }>,
  rule: VoteRule,
): VoteReport {
  return {
    answer: result.answer,
    timedOut: result.timedOut,
    approved: result.approved,
    require: rule,
    votes: Object.fromEntries(result.votes.map((vote) => [vote.voter, vote.answer ?? null])),
    rounds: result.roundCount,
  }
}
