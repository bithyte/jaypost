import { Caller } from '../client/index.ts'
import type { Done, Failure, Question } from '../client/index.ts'
import { askWithProgress } from './answer-wait.ts'
import type { TestDeps } from './types.ts'

const TEST_QUESTION: Question = {
  text: 'This is a test',
  options: ['Approve', 'Decline'],
  timeoutOption: 'Decline',
}

/**
 * Sends a test approval request and prints the answer. Returns 0 once answered, 1 on any failure
 * with the message on stderr.
 */
export async function runTest(deps: TestDeps): Promise<number> {
  const caller = new Caller({ port: deps.port, readToken: () => deps.token })
  const result = await ask(caller, deps)
  if (result.kind === 'failed') {
    deps.printError(result.message)
    return 1
  }
  deps.print(result.answer)
  return 0
}

function ask(caller: Caller, deps: TestDeps): Promise<Done | Failure> {
  if (deps.progress.mode !== 'live') {
    return caller.ask(TEST_QUESTION, { signal: deps.signal })
  }
  return askWithProgress(caller, TEST_QUESTION, {
    progress: deps.progress,
    providers: deps.providers,
    signal: deps.signal,
  })
}
