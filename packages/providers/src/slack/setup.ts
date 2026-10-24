import { createSlackClient } from './client.ts'
import { TOKEN_CHECK_TIMEOUT_MS } from './constants.ts'
import type { SlackIdentity } from './types.ts'

/** What Slack says about both tokens. Never exposes a token or error text beyond Slack's code. */
export async function validateTokens(
  botToken: string,
  appToken: string,
  apiRoot?: string,
): Promise<SlackIdentity> {
  const client = createSlackClient(botToken, appToken, {
    timeoutMs: TOKEN_CHECK_TIMEOUT_MS,
    ...(apiRoot === undefined ? {} : { apiRoot }),
  })
  return client.getIdentity()
}
