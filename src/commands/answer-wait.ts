import { CANCELLED_MESSAGE, FETCH_GRACE_MS } from '../client/index.ts'
import type { Caller, Done, Failure, Question } from '../client/index.ts'
import { formatDuration } from '../progress/index.ts'
import type { Progress } from '../progress/index.ts'
import type { Provider } from '../provider/index.ts'

/** What `askWithProgress` draws on and reads the time from. */
export type AnswerWaitDeps = {
  readonly progress: Progress
  /** Names the provider in the "Sent to ..." line. */
  readonly providers: readonly Provider[]
  /** Aborting it withdraws the question from the service. */
  readonly signal: AbortSignal
  /** Monotonic clock in ms; defaults to `performance.now`. */
  readonly now?: () => number
  /**
   * Wall clock in ms, read once to turn the service's expiry into a deadline; defaults to
   * `Date.now`.
   */
  readonly wallNow?: () => number
}

const CANCELLED: Failure = { kind: 'failed', reason: 'cancelled', message: CANCELLED_MESSAGE }

const WITHDRAWN_TITLE = 'Cancelled, the question was withdrawn'

/**
 * The title of the countdown line: time left and the answer used when it runs out.
 */
export function formatWaitTitle(remainingMs: number, timeoutOption: string): string {
  return `Waiting for your answer ${formatDuration(remainingMs)} left, then ${timeoutOption}`
}

/**
 * The provider label for the daemon's `/status` provider name; undefined when the call fails or
 * the name is unknown. Never throws.
 */
export async function findProviderLabel(
  caller: Caller,
  providers: readonly Provider[],
  signal: AbortSignal,
): Promise<string | undefined> {
  const result = await caller.status({ signal })
  if (result.kind === 'failed') {
    return undefined
  }
  const name = result.status.provider
  return providers.find((provider) => provider.name === name)?.label
}

/**
 * Asks in the background and draws "Sent to ..." then a live countdown while the owner answers.
 * Aborting `signal` withdraws the question from the service (also when it fires while the question
 * is still being sent) and returns the `cancelled` failure. Never throws.
 */
export async function askWithProgress(
  caller: Caller,
  question: Question,
  deps: AnswerWaitDeps,
): Promise<Done | Failure> {
  const { progress, signal } = deps
  const now = deps.now ?? (() => performance.now())
  const wallNow = deps.wallNow ?? Date.now
  const sending = progress.start('Sending')
  const label = await findProviderLabel(caller, deps.providers, signal)
  if (signal.aborted) {
    sending.cancel('Cancelled')
    return CANCELLED
  }
  // The send itself isn't abortable: an abort in flight would drop the id and orphan the question.
  const started = await caller.askInBackground(question, { signal: new AbortController().signal })
  if (started.kind === 'failed') {
    sending.fail()
    return started
  }
  const sentAt = now()
  if (signal.aborted) {
    await withdraw(caller, started.id)
    sending.cancel(WITHDRAWN_TITLE)
    return CANCELLED
  }
  sending.succeed(label === undefined ? 'Sent' : `Sent to ${label}`)
  const deadline = sentAt + (Date.parse(started.expiresAt) - wallNow())
  const waiting = progress.start(() => formatWaitTitle(deadline - now(), question.timeoutOption))
  const state = await caller.waitFor(started.id, { signal })
  switch (state.kind) {
    case 'done':
      waiting.succeed(
        state.timedOut
          ? `Timed out, answered ${state.answer}`
          : `Answered after ${formatDuration(now() - sentAt)}`,
      )
      return { kind: 'done', answer: state.answer, timedOut: state.timedOut }
    case 'cancelled':
      waiting.fail()
      return CANCELLED
    case 'pending':
      // waitFor without a deadline only returns pending when the service is misbehaving.
      waiting.fail()
      return { kind: 'failed', reason: 'unexpected', message: 'question still pending' }
    case 'failed':
      if (state.reason === 'cancelled') {
        await withdraw(caller, started.id)
        waiting.cancel(WITHDRAWN_TITLE)
        return state
      }
      waiting.fail()
      return state
  }
}

async function withdraw(caller: Caller, id: string): Promise<void> {
  // A fresh signal: the caller's is already aborted. Failure is ignored, the service times it out.
  await caller.cancel(id, { signal: new AbortController().signal, timeoutMs: FETCH_GRACE_MS })
}
