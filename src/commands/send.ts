import { Caller } from '../client/index.ts'
import type { Question } from '../client/index.ts'
import type { SendDeps, SendNotifyArgs, SendRequestArgs } from './types.ts'

/**
 * Asks on Telegram and prints the answer (or `{ answer, timedOut }` with `json`). Returns 0 once
 * answered or timed out, 1 on any failure, with the reason on stderr.
 */
export async function runSendRequest(args: SendRequestArgs, deps: SendDeps): Promise<number> {
  const result = await toCaller(deps).ask(toQuestion(args), { signal: deps.signal })
  if (result.kind === 'failed') {
    deps.printError(`jaypost: ${result.message}`)
    return 1
  }
  const { answer, timedOut } = result
  deps.print(args.json ? JSON.stringify({ answer, timedOut }) : answer)
  return 0
}

/** Sends a notification; prints nothing on success. Returns 0 once sent, 1 on any failure. */
export async function runSendNotify(args: SendNotifyArgs, deps: SendDeps): Promise<number> {
  const result = await toCaller(deps).notify(
    {
      text: args.text,
      ...(args.project === undefined ? {} : { project: args.project }),
      ...(args.format === undefined ? {} : { format: args.format }),
      ...(args.attachment === undefined ? {} : { attachment: args.attachment }),
    },
    { signal: deps.signal },
  )
  if (result.kind === 'failed') {
    deps.printError(`jaypost: ${result.message}`)
    return 1
  }
  return 0
}

function toCaller(deps: SendDeps): Caller {
  return new Caller({ port: deps.port, readToken: () => deps.token })
}

function toQuestion(args: SendRequestArgs): Question {
  return {
    text: args.text,
    ...(args.options === undefined ? {} : { options: args.options }),
    ...(args.allowText === undefined ? {} : { allowText: args.allowText }),
    timeoutOption: args.timeoutOption,
    ...(args.timeout === undefined ? {} : { timeout: args.timeout }),
    ...(args.project === undefined ? {} : { project: args.project }),
    ...(args.format === undefined ? {} : { format: args.format }),
    ...(args.attachment === undefined ? {} : { attachment: args.attachment }),
  }
}
