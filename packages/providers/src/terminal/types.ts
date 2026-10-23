import type { Readable, Writable } from 'node:stream'

/** Where the terminal provider reads answers and prints questions. */
export type TerminalIo = {
  readonly input: Readable
  readonly output: Writable
}

/** What `sendRequest` returns; `id` tells a previous run's question apart from a new one. */
export type TerminalReference = {
  readonly number: number
  readonly id: string
}

export type OpenQuestion = {
  readonly id: string
  readonly options: readonly string[]
  readonly allowText: boolean
}
