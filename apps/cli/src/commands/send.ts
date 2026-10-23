import type { VoteReport } from '@jaypost/core'
import { Caller } from '@jaypost/client'
import type { Done, Failure, Message, Question } from '@jaypost/client'
import { askWithProgress, findProviderLabel } from './answer-wait.ts'
import { DECLINED_EXIT_CODE } from './constants.ts'
import type { SendDeps, SendNotifyArgs, SendRequestArgs } from './types.ts'

/**
 * Asks on Telegram and prints the answer (or `{ answer, timedOut }` with `json`). Returns 0 once
 * answered or timed out, 1 on any failure, with the reason on stderr. With voters or a rule it
 * runs a vote through the service instead, and returns 0 when approved, `DECLINED_EXIT_CODE` when
 * rejected (running out of rounds included), 1 on failure.
 */
export async function runSendRequest(args: SendRequestArgs, deps: SendDeps): Promise<number> {
  if (args.voters !== undefined || args.rule !== undefined) {
    return runSendVote(args, deps)
  }
  const result = await askQuestion(args, deps)
  if (result.kind === 'failed') {
    deps.printError(`jaypost: ${result.message}`)
    return 1
  }
  deps.print(formatAnswer(result.answer, result.timedOut, args.json))
  return 0
}

async function runSendVote(args: SendRequestArgs, deps: SendDeps): Promise<number> {
  const ballot = {
    ...(args.voters === undefined ? {} : { voters: args.voters }),
    ...(args.rule === undefined ? {} : { rule: args.rule }),
  }
  const result = await toCaller(deps).vote(toQuestion(args), ballot, { signal: deps.signal })
  if (result.kind === 'failed') {
    deps.printError(`jaypost: ${result.message}`)
    return 1
  }
  deps.print(formatVoteResult(result.report, args.json))
  return result.report.approved ? 0 : DECLINED_EXIT_CODE
}

/**
 * Sends a notification; stdout stays empty. In a terminal it confirms on stderr through
 * `deps.progress`. Returns 0 once sent, 1 on any failure.
 */
export async function runSendNotify(args: SendNotifyArgs, deps: SendDeps): Promise<number> {
  const caller = toCaller(deps)
  const result = await caller.notify(toMessage(args), { signal: deps.signal })
  if (result.kind === 'failed') {
    deps.printError(`jaypost: ${result.message}`)
    return 1
  }
  if (deps.progress.mode === 'live') {
    const label = await findProviderLabel(caller, deps.providers, deps.signal)
    deps.progress.done(label === undefined ? 'Sent' : `Sent to ${label}`)
  }
  return 0
}

function askQuestion(args: SendRequestArgs, deps: SendDeps): Promise<Done | Failure> {
  const caller = toCaller(deps)
  const question = toQuestion(args)
  if (deps.progress.mode !== 'live') {
    return caller.ask(question, { signal: deps.signal })
  }
  return askWithProgress(caller, question, {
    progress: deps.progress,
    providers: deps.providers,
    signal: deps.signal,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.wallNow === undefined ? {} : { wallNow: deps.wallNow }),
  })
}

function toCaller(deps: SendDeps): Caller {
  return new Caller({ endpoint: deps.endpoint, readToken: () => deps.token })
}

/** The question `request` asks, from its parsed arguments. */
export function toQuestion(args: SendRequestArgs): Question {
  return {
    text: args.text,
    ...(args.options === undefined ? {} : { options: args.options }),
    ...(args.allowText === undefined ? {} : { allowText: args.allowText }),
    timeoutOption: args.timeoutOption,
    ...(args.timeout === undefined ? {} : { timeout: args.timeout }),
    ...(args.project === undefined ? {} : { project: args.project }),
    ...(args.format === undefined ? {} : { format: args.format }),
    ...(args.attachment === undefined ? {} : { attachment: args.attachment }),
    ...(args.retryCount === undefined ? {} : { retry: args.retryCount }),
  }
}

/** The notification `notify` sends, from its parsed arguments. */
export function toMessage(args: SendNotifyArgs): Message {
  return {
    text: args.text,
    ...(args.project === undefined ? {} : { project: args.project }),
    ...(args.format === undefined ? {} : { format: args.format }),
    ...(args.attachment === undefined ? {} : { attachment: args.attachment }),
  }
}

/** The answer line `request` prints: the bare answer, or `{ answer, timedOut }` with `json`. */
export function formatAnswer(answer: string, timedOut: boolean, json: boolean | undefined): string {
  return json === true ? JSON.stringify({ answer, timedOut }) : answer
}

/** The line a decided vote prints: the bare answer, or with `json` the whole report. */
export function formatVoteResult(report: VoteReport, json: boolean | undefined): string {
  return json === true ? JSON.stringify(report) : report.answer
}
