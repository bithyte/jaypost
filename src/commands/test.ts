import type { ClientToken } from '../auth/index.ts'
import { describeUnauthorized } from '../client/index.ts'
import { readInstall } from '../install/index.ts'

/** Port from install.json when present, else the fallback. Sends the token when one is found. */
export async function runTest(
  fallbackPort: number,
  installFile: string | undefined,
  token: ClientToken,
): Promise<number> {
  if (token.kind === 'unusable') {
    console.error(token.message)
    return 1
  }
  const port = (installFile ? readInstall(installFile)?.port : undefined) ?? fallbackPort
  try {
    const response = await fetch(`http://127.0.0.1:${port}/request`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token.kind === 'token' ? { authorization: `Bearer ${token.token}` } : {}),
      },
      body: JSON.stringify({
        text: 'This is a test',
        options: ['Approve', 'Decline'],
        timeoutOption: 'Decline',
      }),
    })
    if (response.status === 401) {
      console.error(describeUnauthorized(token.kind === 'token'))
      return 1
    }
    console.log(response.status, await response.text())
    return response.status === 200 ? 0 : 1
  } catch (error) {
    console.error(
      `could not reach the service on port ${port} (is it running? try jaypost status): ${error instanceof Error ? error.message : String(error)}`,
    )
    return 1
  }
}
