import { Caller } from '@jaypost/client'
import type { Message } from '@jaypost/client'
import { findProviderLabel } from './answer-wait.ts'
import type { PingDeps } from './types.ts'

const PING_MESSAGE: Message = { text: 'Ping from jaypost' }

/**
 * Sends a test notification. Returns 0 once sent, 1 on any failure with the message on stderr.
 */
export async function runPing(deps: PingDeps): Promise<number> {
  const caller = new Caller({ endpoint: deps.endpoint, readToken: () => deps.token })
  const result = await caller.notify(PING_MESSAGE, { signal: deps.signal })
  if (result.kind === 'failed') {
    deps.printError(result.message)
    return 1
  }
  if (deps.progress.mode !== 'live') {
    deps.print('Sent. Check your chat app.')
    return 0
  }
  const label = await findProviderLabel(caller, deps.providers, deps.signal)
  deps.progress.done(label === undefined ? 'Sent' : `Sent to ${label}`)
  return 0
}
