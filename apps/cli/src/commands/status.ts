import { describeEndpoint, describeUnauthorized, isLoopbackEndpoint } from '@jaypost/client'
import type { StatusInfo } from '@jaypost/protocol'
import { formatPairingText } from './pairing-text.ts'
import type { StatusDeps } from './types.ts'

const NO_BOT_MESSAGE = 'no bot to send to'

/** The key and contact lines, and the bot's error when it failed; older services send neither. */
function printKey(status: StatusInfo, print: (text: string) => void): void {
  if (status.key !== undefined && status.contact !== undefined) {
    print(`Key:     ${status.key} (contact ${status.contact})`)
  }
  if (status.state === 'failed') {
    print(`Bot:     failed (${status.error ?? 'no reason given'})`)
  }
}

/**
 * Prints the bot (alias or "env" and where it is), the install lines when it is the service on
 * this machine, then the key and contact from /status. Returns 0 only when /status answered; 1
 * otherwise, including no bot, a service that isn't running, or an unusable or rejected key. The
 * key itself is never printed.
 */
export async function runStatus(deps: StatusDeps): Promise<number> {
  const { print, resolved, install } = deps
  if (resolved.endpoint.kind === 'invalid') {
    const isNoBot = install === undefined && resolved.endpoint.message.startsWith(NO_BOT_MESSAGE)
    print(
      isNoBot
        ? 'No bot. Run "jaypost service install" or "jaypost inbox join".'
        : resolved.endpoint.message,
    )
    return 1
  }
  const { url } = resolved.endpoint
  print(`Bot:     ${resolved.alias ?? 'env'} (${describeEndpoint(url)})`)
  if (install !== undefined && isLoopbackEndpoint(url)) {
    const { record, target } = install
    let running = false
    try {
      running = await target.isRunning(record)
    } catch {
      running = false
    }
    print(`Target:  ${record.target}`)
    print(`Version: ${record.version}`)
    print(`Port:    ${record.port}`)
    print(`Running: ${running ? 'yes' : 'no'}`)
    if (!running) {
      print(target.logsHint(record))
      return 1
    }
  }
  const { token } = resolved
  if (token.kind === 'unusable') {
    print(`Pairing: unknown (no usable token: ${token.message})`)
    return 1
  }
  const fetched = await deps.fetchStatus(url, token.kind === 'token' ? token.token : undefined)
  switch (fetched.kind) {
    case 'unreachable':
      print('Pairing: unknown (the service did not answer on /status yet)')
      return 1
    case 'unauthorized':
      print(`Pairing: unknown (the service rejected the token)
${describeUnauthorized(token.kind === 'token')}`)
      return 1
    case 'answered':
      printKey(fetched.status, print)
      if (fetched.status.paired) {
        print('Pairing: paired')
      } else {
        print(`Pairing: not paired
${formatPairingText(fetched.status)}`)
      }
      return 0
  }
}
