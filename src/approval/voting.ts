import { CANCELLED_RESULT, CANCELLED_ROUND, CANCELLED_VOTE, TIMED_OUT_ROUND } from './constants.ts'
import { SendError } from './service.ts'
import type { ApprovalService } from './service.ts'
import { decideVote } from './vote.ts'
import type {
  ApprovalRequest,
  RequestResult,
  RoundEnd,
  Vote,
  VoteCounts,
  VoteResult,
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
 * aborted `signal` resolves as cancelled and asks nothing more.
 */
export async function askWithRetries(
  service: ApprovalService,
  request: ApprovalRequest,
  retryCount: number,
  signal: AbortSignal,
): Promise<RequestResult> {
  for (let round = 0; ; round += 1) {
    if (signal.aborted) {
      return CANCELLED_RESULT
    }
    const isLast = round >= retryCount
    const result = await service.request({ ...request, reaskOnTimeout: !isLast }, signal)
    if (isLast || result.kind === 'cancelled' || !result.outcome.timedOut) {
      return result
    }
  }
}

/**
 * Asks every voter in parallel, one message each, for up to `retryCount + 1` rounds; each round
 * asks only voters who haven't voted. Once decided, every open message is closed with the vote's
 * answer. Rounds running out reject, counting missing votes as rejections. Throws
 * `VoterSendError` when a send fails, after cancelling the messages that were sent. An aborted
 * `signal` cancels every open message and resolves as cancelled.
 */
export async function runVote(
  service: ApprovalService,
  vote: Vote,
  signal: AbortSignal,
): Promise<VoteResult> {
  const answers = new Map<string, string>()
  const roundCount = vote.retryCount + 1
  for (let round = 1; round <= roundCount; round += 1) {
    if (signal.aborted) {
      return CANCELLED_VOTE
    }
    const asked = vote.voters.filter((voter) => !answers.has(voter))
    const end = await runRound(service, vote, asked, round === roundCount, answers, signal)
    if (end.kind === 'cancelled') {
      return CANCELLED_VOTE
    }
    if (end.kind === 'decided') {
      return toVoteResult(vote, answers, end.approved, round, false)
    }
  }
  return toVoteResult(vote, answers, false, roundCount, true)
}

/** Sends one round to `asked` and records their votes in `answers` as they arrive. */
async function runRound(
  service: ApprovalService,
  vote: Vote,
  asked: readonly string[],
  isLast: boolean,
  answers: Map<string, string>,
  signal: AbortSignal,
): Promise<RoundEnd> {
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
    return await collectRound(service, vote, questions, answers)
  } finally {
    signal.removeEventListener('abort', abortAll)
  }
}

/**
 * Records each answer as it arrives until the vote is decided or every message settled. Results
 * that arrive after the decision (the closed messages) are never counted.
 */
async function collectRound(
  service: ApprovalService,
  vote: Vote,
  questions: readonly VoterQuestion[],
  answers: Map<string, string>,
): Promise<RoundEnd> {
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
    const decision = decideVote(vote.rule, countVotes(vote, answers))
    if (decision !== 'undecided') {
      const approved = decision === 'approved'
      const answer = toVoteAnswer(vote.request, approved)
      for (const question of questions) {
        if (waiting.has(question.voter)) {
          service.close(question.id, answer)
        }
      }
      // So every closed message is finalized before the caller exits.
      await Promise.all(waiting.values())
      return { kind: 'decided', approved }
    }
  }
  return isCancelled ? CANCELLED_ROUND : TIMED_OUT_ROUND
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
    votes: vote.voters.map((voter) => ({ voter, answer: answers.get(voter) })),
    roundCount,
    timedOut,
  }
}
