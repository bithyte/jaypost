import { addAbortSignal } from 'node:stream'
import type { Readable } from 'node:stream'
import { text } from 'node:stream/consumers'

/** All of `stream` as text; rejects (and destroys the stream) as soon as `signal` aborts. */
export function readHookInput(stream: Readable, signal: AbortSignal): Promise<string> {
  return text(addAbortSignal(signal, stream))
}
