import type { ClientToken } from '../auth/index.ts'
import { postApi, prepareAttachment, requestApi, toSendTimeoutMs } from '../client/index.ts'
import type { AttachmentBody, AttachmentSource } from '../client/index.ts'
import type { SendDeps, SendNotifyArgs, SendRequestArgs } from './types.ts'

/**
 * Asks on Telegram and prints the answer (or `{ answer, timedOut }` with `json`). Returns 0 once
 * answered or timed out, 1 on any failure, with the reason on stderr.
 */
export async function runSendRequest(args: SendRequestArgs, deps: SendDeps): Promise<number> {
  if (deps.token.kind === 'unusable') {
    deps.printError(`jaypost: ${deps.token.message}`)
    return 1
  }
  const attachment = await prepare(args.attachment, deps)
  if (attachment.kind === 'failed') {
    return 1
  }
  const result = await requestApi(
    deps.port,
    {
      text: args.text,
      ...(args.options === undefined ? {} : { options: args.options }),
      ...(args.allowText === undefined ? {} : { allowText: args.allowText }),
      timeoutOption: args.timeoutOption,
      ...(args.timeout === undefined ? {} : { timeout: args.timeout }),
      ...(args.project === undefined ? {} : { project: args.project }),
      ...(args.format === undefined ? {} : { format: args.format }),
      ...attachment.body,
    },
    { signal: deps.signal, ...toTokenOption(deps.token) },
  )
  if (result.kind === 'failed') {
    deps.printError(`jaypost: ${result.message}`)
    return 1
  }
  const { answer, timedOut } = result.outcome
  deps.print(args.json ? JSON.stringify({ answer, timedOut }) : answer)
  return 0
}

/** Sends a notification; prints nothing on success. Returns 0 once sent, 1 on any failure. */
export async function runSendNotify(args: SendNotifyArgs, deps: SendDeps): Promise<number> {
  if (deps.token.kind === 'unusable') {
    deps.printError(`jaypost: ${deps.token.message}`)
    return 1
  }
  const attachment = await prepare(args.attachment, deps)
  if (attachment.kind === 'failed') {
    return 1
  }
  const result = await postApi(
    deps.port,
    '/notify',
    {
      text: args.text,
      ...(args.project === undefined ? {} : { project: args.project }),
      ...(args.format === undefined ? {} : { format: args.format }),
      ...attachment.body,
    },
    {
      signal: deps.signal,
      timeoutMs: toSendTimeoutMs(args.attachment !== undefined),
      ...toTokenOption(deps.token),
    },
  )
  if (result.kind === 'failed') {
    deps.printError(`jaypost: ${result.message}`)
    return 1
  }
  return 0
}

type Prepared =
  | { readonly kind: 'ready'; readonly body: { readonly attachment?: AttachmentBody } }
  | { readonly kind: 'failed' }

async function prepare(source: AttachmentSource | undefined, deps: SendDeps): Promise<Prepared> {
  if (source === undefined) {
    return { kind: 'ready', body: {} }
  }
  const result = await prepareAttachment(deps.port, source, {
    signal: deps.signal,
    ...toTokenOption(deps.token),
  })
  if (result.kind === 'failed') {
    deps.printError(`jaypost: ${result.message}`)
    return { kind: 'failed' }
  }
  return { kind: 'ready', body: { attachment: result.attachment } }
}

function toTokenOption(token: ClientToken): { readonly token?: string } {
  return token.kind === 'token' ? { token: token.token } : {}
}
