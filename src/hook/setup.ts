import type { Caller } from '../client/index.ts'
import { SETUP_STATUS_TIMEOUT_MS } from './constants.ts'
import type { HookDeps } from './types.ts'

/**
 * Asks the service for /status and describes what stops permission prompts from reaching the
 * phone: not running, a token it can't use, or no phone paired. `undefined` means all is well.
 * A killed hook (`deps.signal` aborted) gets `undefined` too, so the caller can stay silent.
 * Never throws.
 */
export async function checkService(caller: Caller, deps: HookDeps): Promise<string | undefined> {
  const result = await caller.status({ signal: deps.signal, timeoutMs: SETUP_STATUS_TIMEOUT_MS })
  if (result.kind === 'status') {
    return result.status.paired
      ? undefined
      : "jaypost isn't paired with your phone yet, so permission prompts stay in the terminal. Run `jaypost init` to pair."
  }
  if (deps.signal.aborted) {
    return undefined
  }
  switch (result.reason) {
    case 'unreachable':
    case 'cancelled':
    case 'httpTimeout':
      return `jaypost isn't running on 127.0.0.1:${deps.port}, so permission prompts stay in the terminal. Run \`jaypost init\` to set it up, or \`jaypost status\` to check an existing install.`
    case 'unusableToken':
    case 'unauthorized':
      return `jaypost can't use its API token (${result.message}), so permission prompts stay in the terminal. Run \`jaypost init\`, or set JAYPOST_TOKEN in a container.`
    default:
      return `jaypost setup check failed (${result.message}), so permission prompts may stay in the terminal.`
  }
}
