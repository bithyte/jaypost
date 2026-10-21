import type { ClientToken } from '../auth/index.ts'
import { Caller } from '../client/index.ts'
import { readInstall } from '../install/index.ts'

/** Port from install.json when present, else the fallback. Sends the token when one is found. */
export async function runTest(
  fallbackPort: number,
  installFile: string | undefined,
  token: ClientToken,
): Promise<number> {
  const port = (installFile ? readInstall(installFile)?.port : undefined) ?? fallbackPort
  const result = await new Caller({ port, readToken: () => token }).ask(
    { text: 'This is a test', options: ['Approve', 'Decline'], timeoutOption: 'Decline' },
    { signal: new AbortController().signal },
  )
  if (result.kind === 'failed') {
    console.error(result.message)
    return 1
  }
  console.log(result.answer)
  return 0
}
