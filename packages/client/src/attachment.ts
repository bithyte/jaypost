import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { MAX_ATTACHMENT_BYTES } from '@jaypost/core'
import { ATTACHMENT_NOT_SUPPORTED_MESSAGE, ATTACHMENT_TOO_OLD_MESSAGE } from './constants.ts'
import type { AttachmentBody, AttachmentResult, AttachmentSource, Failure } from './types.ts'

type Read =
  | {
      readonly kind: 'read'
      readonly body: AttachmentBody
      readonly byteLength: number
    }
  | Failure

/** An attachment read locally and not yet checked against the service's limit. */
export type ReadAttachment = {
  readonly kind: 'read'
  readonly body: AttachmentBody
  readonly byteLength: number
  readonly label: string
}

/**
 * Reads the attachment locally. Never throws; doesn't log names or content. An abort while
 * reading fails with reason `cancelled`.
 */
export async function readAttachment(
  source: AttachmentSource,
  signal: AbortSignal,
): Promise<ReadAttachment | Failure> {
  const label = describeSource(source)
  const read = await readSource(source, label, signal)
  if (read.kind === 'failed') {
    return signal.aborted ? { ...read, reason: 'cancelled' } : read
  }
  return { ...read, label }
}

/** Checks a read attachment against the service's limit; `undefined` means an old service. */
export function checkAttachmentLimit(
  read: ReadAttachment,
  maxAttachmentBytes: number | undefined,
): AttachmentResult {
  if (maxAttachmentBytes === undefined) {
    return { kind: 'failed', reason: 'tooOld', message: ATTACHMENT_TOO_OLD_MESSAGE }
  }
  if (maxAttachmentBytes === 0) {
    return { kind: 'failed', reason: 'notSupported', message: ATTACHMENT_NOT_SUPPORTED_MESSAGE }
  }
  if (read.byteLength > maxAttachmentBytes) {
    return {
      kind: 'failed',
      reason: 'attachment',
      message: describeOver(read.label, maxAttachmentBytes),
    }
  }
  return { kind: 'ok', attachment: read.body }
}

function describeSource(source: AttachmentSource): string {
  if ('stream' in source) {
    return 'attachment from stdin'
  }
  if ('path' in source) {
    return `attachment ${JSON.stringify(source.path)}`
  }
  return `attachment ${JSON.stringify(source.name)}`
}

function describeOver(label: string, limit: number): string {
  return `${label} is over ${limit} bytes`
}

function describeReadFailure(label: string, error: unknown): string {
  return `couldn't read ${label}: ${error instanceof Error ? error.message : String(error)}`
}

function readSource(source: AttachmentSource, label: string, signal: AbortSignal): Promise<Read> {
  if ('stream' in source) {
    return readStream(source.stream, source.name, label, signal)
  }
  if ('path' in source) {
    return readPath(source.path, source.name, label)
  }
  if ('text' in source) {
    return Promise.resolve({
      kind: 'read',
      body: { name: source.name, text: source.text },
      byteLength: Buffer.byteLength(source.text),
    })
  }
  return Promise.resolve({
    kind: 'read',
    body: {
      name: source.name,
      data: Buffer.from(source.data).toString('base64'),
    },
    byteLength: source.data.byteLength,
  })
}

async function readPath(path: string, name: string | undefined, label: string): Promise<Read> {
  const absolute = resolve(path)
  let collected: Collected
  try {
    const info = await stat(absolute)
    if (!info.isFile()) {
      return { kind: 'failed', reason: 'attachment', message: `${label} is not a file` }
    }
    if (info.size > MAX_ATTACHMENT_BYTES) {
      return {
        kind: 'failed',
        reason: 'attachment',
        message: describeOver(label, MAX_ATTACHMENT_BYTES),
      }
    }
    // Capped read: the file may grow, or report size 0 like /proc files do.
    const file = createReadStream(absolute)
    try {
      collected = await collect(file)
    } finally {
      file.destroy()
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { kind: 'failed', reason: 'attachment', message: `${label} not found` }
    }
    return { kind: 'failed', reason: 'attachment', message: describeReadFailure(label, error) }
  }
  if (collected.kind === 'over') {
    return {
      kind: 'failed',
      reason: 'attachment',
      message: describeOver(label, MAX_ATTACHMENT_BYTES),
    }
  }
  return {
    kind: 'read',
    body: {
      name: name ?? basename(absolute),
      data: Buffer.concat(collected.chunks).toString('base64'),
    },
    byteLength: collected.byteLength,
  }
}

async function readStream(
  stream: AsyncIterable<Uint8Array | string>,
  name: string,
  label: string,
  signal: AbortSignal,
): Promise<Read> {
  let collected: Collected
  try {
    collected = await collect(stream, signal)
  } catch (error) {
    return { kind: 'failed', reason: 'attachment', message: describeReadFailure(label, error) }
  }
  if (collected.kind === 'over') {
    return {
      kind: 'failed',
      reason: 'attachment',
      message: describeOver(label, MAX_ATTACHMENT_BYTES),
    }
  }
  return {
    kind: 'read',
    body: { name, data: Buffer.concat(collected.chunks).toString('base64') },
    byteLength: collected.byteLength,
  }
}

type Collected =
  | {
      readonly kind: 'collected'
      readonly chunks: readonly Buffer[]
      readonly byteLength: number
    }
  | { readonly kind: 'over' }

// Stops at the first byte past the cap, or when `signal` aborts (a stalled source never yields).
async function collect(
  source: AsyncIterable<Uint8Array | string>,
  signal?: AbortSignal,
): Promise<Collected> {
  signal?.throwIfAborted()
  const iterator = source[Symbol.asyncIterator]()
  const aborted = new Promise<never>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    })
  })
  // Without this, a rejection after the loop has finished would be unhandled.
  aborted.catch(() => {})
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const step = await Promise.race([iterator.next(), aborted])
      if (step.done === true) {
        return { kind: 'collected', chunks, byteLength: total }
      }
      const buffer = Buffer.from(step.value)
      total += buffer.byteLength
      if (total > MAX_ATTACHMENT_BYTES) {
        return { kind: 'over' }
      }
      chunks.push(buffer)
    }
  } finally {
    // Not awaited: a stalled source would never finish returning.
    void iterator.return?.()?.catch?.(() => {})
  }
}
