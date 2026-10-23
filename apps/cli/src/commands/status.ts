import type { ClientToken } from '@jaypost/store'
import { describeUnauthorized } from '@jaypost/client'
import { findExistingInstall } from '@jaypost/install'
import { formatPairingText } from './pairing-text.ts'
import type { StatusDeps } from './types.ts'

function describeTokenSource(token: ClientToken, tokenFile: string): string {
  switch (token.kind) {
    case 'none':
      return 'none'
    case 'token':
      return token.source === 'env' ? 'from JAYPOST_TOKEN' : `from ${tokenFile}`
    case 'unusable':
      return `unusable (${token.message})`
  }
}

/**
 * Prints install, running and pairing state. Returns 0 only when installed and running; 1
 * otherwise, including an unusable or rejected token.
 */
export async function runStatus(deps: StatusDeps): Promise<number> {
  const { print } = deps
  const existing = findExistingInstall(deps.paths, deps.targets)
  if (!existing) {
    print('Not installed. Run "jaypost init".')
    return 1
  }
  const { record } = existing
  let running = false
  try {
    running = await deps.targets[record.target].isRunning(record)
  } catch {
    running = false
  }
  print(`Target:  ${record.target}`)
  print(`Version: ${record.version}`)
  print(`Port:    ${record.port}`)
  print(`Token:   ${describeTokenSource(deps.token, deps.tokenFile)}`)
  print(`Running: ${running ? 'yes' : 'no'}`)
  if (!running) {
    print(deps.targets[record.target].logsHint(record))
    return 1
  }
  if (deps.token.kind === 'unusable') {
    print('Pairing: unknown (no usable token)')
    return 1
  }
  const fetched = await deps.fetchStatus(
    record.port,
    deps.token.kind === 'token' ? deps.token.token : undefined,
  )
  switch (fetched.kind) {
    case 'unreachable':
      print('Pairing: unknown (the service did not answer on /status yet)')
      return 0
    case 'unauthorized':
      print(`Pairing: unknown (the service rejected the token)
${describeUnauthorized(deps.token.kind === 'token')}`)
      return 1
    case 'answered':
      if (fetched.status.paired) {
        print('Pairing: paired')
      } else {
        print(`Pairing: not paired
${formatPairingText(fetched.status)}`)
      }
      return 0
  }
}
