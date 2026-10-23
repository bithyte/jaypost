/**
 * Runs `run` with an abort controller that fires on any of `signals`. A signal in `reraised`
 * is sent to the process again once `run` settles, so the exit status is the default for it.
 * The handlers are removed before that, and also when `run` throws.
 */
export async function runWithSignals(
  run: (controller: AbortController) => Promise<number>,
  signals: readonly NodeJS.Signals[] = ['SIGINT'],
  reraised: readonly NodeJS.Signals[] = [],
): Promise<number> {
  const controller = new AbortController()
  let received: NodeJS.Signals | undefined
  const onSignal = (signal: NodeJS.Signals) => {
    received ??= signal
    controller.abort()
  }
  for (const signal of signals) {
    process.on(signal, onSignal)
  }
  let code: number
  try {
    code = await run(controller)
  } finally {
    for (const signal of signals) {
      process.off(signal, onSignal)
    }
  }
  if (received !== undefined && reraised.includes(received)) {
    process.kill(process.pid, received)
  }
  return code
}
