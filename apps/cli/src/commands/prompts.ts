import { confirm, isCancel, password, select, text } from '@clack/prompts'
import type { Prompts, SelectOption } from './types.ts'

/**
 * Thrown by the prompts on Ctrl-C, abort, or when stdin isn't a terminal; callers treat it as a
 * user cancel.
 */
export class PromptAborted extends Error {
  constructor() {
    super('prompt aborted')
    this.name = 'PromptAborted'
  }
}

// Clack never settles on a closed or piped stdin, so refuse up front.
function requireTty(): void {
  if (!process.stdin.isTTY) {
    throw new PromptAborted()
  }
}

function requireAnswer<T>(value: T): Exclude<T, symbol> {
  if (isCancel(value)) {
    throw new PromptAborted()
  }
  return value as Exclude<T, symbol>
}

/**
 * Clack-backed prompts. Each rejects with PromptAborted on Ctrl-C, when `signal` aborts, or when
 * stdin isn't a terminal.
 */
export function createClackPrompts(signal?: AbortSignal): Prompts {
  return {
    confirm: async (message, initialValue) => {
      requireTty()
      return requireAnswer(await confirm({ message, initialValue, signal }))
    },
    password: async (message) => {
      requireTty()
      return requireAnswer(await password({ message, signal })).trim()
    },
    text: async (message) => {
      requireTty()
      return requireAnswer(await text({ message, signal })).trim()
    },
    select: async <T extends string>(
      message: string,
      options: readonly SelectOption<T>[],
      initialValue: T,
    ) => {
      requireTty()
      // select<string>: clack's Option<T> is a conditional type TS can't check against a generic T.
      return requireAnswer(
        await select<string>({
          message,
          initialValue,
          signal,
          options: options.map((option) => ({
            value: option.value,
            label: option.disabled
              ? `${option.label} (unavailable: ${option.disabled})`
              : option.label,
            disabled: option.disabled !== undefined,
          })),
        }),
      ) as T
    },
  }
}
