import type { Provider } from '@jaypost/core'
import { NTFY_MAX_OPTION_COUNT, NTFY_MAX_TEXT_LENGTH } from './constants.ts'
import { checkNtfyAccess, createNtfyRuntime } from './runtime.ts'
import { parseServer, parseToken, parseTopic } from './settings.ts'

/**
 * ntfy: no bot and no pairing. The topic (or the access token, on a server that checks one) is
 * the secret; whoever can publish to the reply topic can answer.
 */
export const ntfyProvider: Provider = {
  name: 'ntfy',
  label: 'ntfy',
  maxTextLength: NTFY_MAX_TEXT_LENGTH,
  maxOptionCount: NTFY_MAX_OPTION_COUNT,
  settings: [
    {
      configKey: 'ntfyServer',
      envVar: 'JAYPOST_NTFY_SERVER',
      description: 'ntfy server',
      secret: false,
      owner: false,
      required: false,
      prompt: 'ntfy server (empty for https://ntfy.sh)',
      parse: parseServer,
    },
    {
      configKey: 'ntfyTopic',
      envVar: 'JAYPOST_NTFY_TOPIC',
      description: 'ntfy topic',
      secret: true,
      owner: false,
      required: true,
      prompt: 'Topic you subscribed to in the ntfy app (a long random name)',
      parse: parseTopic,
    },
    {
      configKey: 'ntfyToken',
      envVar: 'JAYPOST_NTFY_TOKEN',
      description: 'ntfy access token',
      secret: true,
      owner: false,
      required: false,
      prompt: 'Access token (empty for none)',
      parse: parseToken,
    },
  ],
  setup: {
    checkCredentials: (settings) => checkNtfyAccess(settings),
    text: {
      checked: 'ntfy topic',
      leftoverFound: 'Found an ntfy topic kept from an earlier install.',
      reusing: (name) => `Reusing the saved ntfy topic (${name}).`,
      rejected:
        'ntfy refused that topic or token, or could not be reached. Without a token the topic needs at least 16 characters. Try again.',
    },
  },
  createRuntime: (settings, log) => createNtfyRuntime(settings, log),
}
