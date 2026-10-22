import type { ClientToken } from '../auth/index.ts'
import { postApi, prepareAttachment, requestApi, toSendTimeoutMs } from '../client/index.ts'
import type { Answer, AskBody, AttachmentBody, AttachmentSource } from '../client/index.ts'
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
  const result = await requestApi(deps.port, toAskBody(args, attachment.attachment), {
    signal: deps.signal,
    ...toTokenOption(deps.token),
  })
  if (result.kind === 'failed') {
    deps.printError(`jaypost: ${result.message}`)
    return 1
  }
  deps.print(formatAnswer(result.outcome, args.json))
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
  const result = await postApi(deps.port, '/notify', toNotifyBody(args, attachment.attachment), {
    signal: deps.signal,
    timeoutMs: toSendTimeoutMs(args.attachment !== undefined),
    ...toTokenOption(deps.token),
  })
  if (result.kind === 'failed') {
    deps.printError(`jaypost: ${result.message}`)
    return 1
  }
  return 0
}

/** The `/request` body for `args`, shared by the service and direct paths. */
export function toAskBody(args: SendRequestArgs, attachment: AttachmentBody | undefined): AskBody {
  return {
    text: args.text,
    ...(args.options === undefined ? {} : { options: args.options }),
    ...(args.allowText === undefined ? {} : { allowText: args.allowText }),
    timeoutOption: args.timeoutOption,
    ...(args.timeout === undefined ? {} : { timeout: args.timeout }),
    ...(args.project === undefined ? {} : { project: args.project }),
    ...(args.format === undefined ? {} : { format: args.format }),
    ...(attachment === undefined ? {} : { attachment }),
  }
}

/** The `/notify` body for `args`, shared by the service and direct paths. */
export function toNotifyBody(args: SendNotifyArgs, attachment: AttachmentBody | undefined) {
  return {
    text: args.text,
    ...(args.project === undefined ? {} : { project: args.project }),
    ...(args.format === undefined ? {} : { format: args.format }),
    ...(attachment === undefined ? {} : { attachment }),
  }
}

/** The line `send request` prints: the bare answer, or `{ answer, timedOut }` with `json`. */
export function formatAnswer(outcome: Answer, json: boolean | undefined): string {
  const { answer, timedOut } = outcome
  return json === true ? JSON.stringify({ answer, timedOut }) : answer
}

type Prepared =
  | { readonly kind: 'ready'; readonly attachment: AttachmentBody | undefined }
  | { readonly kind: 'failed' }

async function prepare(source: AttachmentSource | undefined, deps: SendDeps): Promise<Prepared> {
  if (source === undefined) {
    return { kind: 'ready', attachment: undefined }
  }
  const result = await prepareAttachment(deps.port, source, {
    signal: deps.signal,
    ...toTokenOption(deps.token),
  })
  if (result.kind === 'failed') {
    deps.printError(`jaypost: ${result.message}`)
    return { kind: 'failed' }
  }
  return { kind: 'ready', attachment: result.attachment }
}

function toTokenOption(token: ClientToken): { readonly token?: string } {
  return token.kind === 'token' ? { token: token.token } : {}
}
