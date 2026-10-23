import type { StatusInfo } from '../protocol/index.ts'
import { formatLegacyInstructions } from '../telegram/index.ts'

/**
 * Pairing code plus how to use it. Prefers the service's own instructions; old containers send only
 * `bot` and are always Telegram.
 */
export function formatPairingText(status: Extract<StatusInfo, { paired: false }>): string {
  const head = `Pairing code: ${status.code}`
  if (status.instructions) {
    return `${head}\n${status.instructions}`
  }
  if (status.bot) {
    return `${head}\n${formatLegacyInstructions(status.code, status.bot)}`
  }
  return head
}
