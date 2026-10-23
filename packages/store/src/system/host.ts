import net from 'node:net'
import { LINGER_OFF_PATTERN, LINGER_ON_PATTERN } from './constants.ts'
import type { Exec } from './types.ts'

/** True when 127.0.0.1:`port` can be bound; any bind error counts as in use. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

/**
 * Enables systemd linger for `user` so the service survives logout. Never throws; prints the manual
 * command if it can't.
 */
export async function ensureLinger(
  exec: Exec,
  user: string,
  print: (text: string) => void,
): Promise<void> {
  const printFallback = () =>
    print(`Run "loginctl enable-linger ${user}" so it keeps running after logout.`)
  try {
    const show = await exec('loginctl', ['show-user', user, '-p', 'Linger'])
    if (show.code === 0 && LINGER_ON_PATTERN.test(show.stdout)) {
      return
    }
    if (show.code === 0 && !LINGER_OFF_PATTERN.test(show.stdout)) {
      return
    }
    const result = await exec('loginctl', ['enable-linger', user])
    if (result.code !== 0) {
      printFallback()
    }
  } catch {
    printFallback()
  }
}
