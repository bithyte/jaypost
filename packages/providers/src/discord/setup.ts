import { createDiscordClient } from './client.ts'
import { TOKEN_CHECK_TIMEOUT_MS } from './constants.ts'

/** Returns the bot username, or undefined on any failure. Never exposes the token or error text. */
export async function validateToken(token: string, apiRoot?: string): Promise<string | undefined> {
  const client = createDiscordClient(token, {
    timeoutMs: TOKEN_CHECK_TIMEOUT_MS,
    ...(apiRoot === undefined ? {} : { apiRoot }),
  })
  const identity = await client.getIdentity()
  return identity.kind === 'ok' ? identity.username || undefined : undefined
}
