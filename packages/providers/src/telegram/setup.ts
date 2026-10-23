import { Api } from 'grammy'
import { TOKEN_CHECK_TIMEOUT_SECONDS } from './constants.ts'

/** Returns the bot username, or undefined on any failure. Never exposes the token or error text. */
export async function validateToken(token: string, apiRoot?: string): Promise<string | undefined> {
  try {
    // No global fetch here: Node's fetch rejects grammY's polyfilled AbortSignal on every call.
    const botUser = await new Api(token, {
      timeoutSeconds: TOKEN_CHECK_TIMEOUT_SECONDS,
      ...(apiRoot === undefined ? {} : { apiRoot }),
    }).getMe()
    return botUser.username || undefined
  } catch {
    return undefined
  }
}
