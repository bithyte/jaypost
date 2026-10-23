import { SHOW_CURSOR } from '../progress/constants.ts'

/**
 * Runs `run` with an abort controller that fires on any of `signals`. A signal in `reraised`
 * is sent to the process again once `run` settles, so the exit status is the default for it.
 * The handlers are removed before that, and also when `run` throws. A second signal while
 * `run` is still winding down gives up on it: the cursor is restored and the signal is
 * re-raised at once, so a hung step can't trap the user.
 */
export async function runWithSignals(
  run: (controller: AbortController) => Promise<number>,
  signals: readonly NodeJS.Signals[] = ['SIGINT'],
  reraised: readonly NodeJS.Signals[] = [],
): Promise<number> {
  const controller = new AbortController()
  let received: NodeJS.Signals | undefined
  const removeHandlers = () => {
    for (const signal of signals) {
      process.off(signal, onSignal)
    }
  }
  function onSignal(signal: NodeJS.Signals): void {
    if (received !== undefined) {
      removeHandlers()
      try {
        process.stderr.write(SHOW_CURSOR)
      } catch {
        // stderr may be gone (closed terminal); the signal below still has to go out.
      }
      process.kill(process.pid, signal)
      return
    }
    received = signal
    controller.abort()
  }
  for (const signal of signals) {
    process.on(signal, onSignal)
  }
  let code: number
  try {
    code = await run(controller)
  } finally {
    removeHandlers()
  }
  if (received !== undefined && reraised.includes(received)) {
    process.kill(process.pid, received)
  }
  return code
}
