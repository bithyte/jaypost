import { MAX_ATTACHMENT_BYTES } from '../approval/index.ts'
import type { Provider } from '../provider/index.ts'
import { TERMINAL_MAX_TEXT_LENGTH } from './constants.ts'
import { createTerminalRuntime } from './runtime.ts'

/**
 * Asks in the service's own terminal, for local development (`pnpm dev`). Not offered by `init`;
 * only `PROVIDER=terminal` picks it.
 */
export const terminalProvider: Provider = {
  name: 'terminal',
  label: 'Terminal',
  maxTextLength: TERMINAL_MAX_TEXT_LENGTH,
  maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
  settings: [],
  setup: {
    checkCredentials: () => Promise.resolve({ ok: true, displayName: 'terminal' }),
    text: {
      leftoverFound: 'Found settings kept from an earlier install.',
      reusing: () => 'Reusing the terminal.',
      rejected: 'The terminal provider has nothing to check.',
    },
  },
  createRuntime: () => createTerminalRuntime({ input: process.stdin, output: process.stdout }),
}
