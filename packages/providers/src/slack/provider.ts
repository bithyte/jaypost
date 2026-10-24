import type { Provider, SettingValue } from '@jaypost/core'
import {
  SLACK_MAX_ATTACHMENT_BYTES,
  SLACK_MAX_OPTION_COUNT,
  SLACK_MAX_TEXT_LENGTH,
  USER_ID_PATTERN,
} from './constants.ts'
import { createSlackRuntime } from './runtime.ts'
import { validateTokens } from './setup.ts'

function parseToken(prefix: string): (raw: unknown) => SettingValue | undefined {
  return (raw) => {
    if (typeof raw !== 'string') {
      return undefined
    }
    const trimmed = raw.trim()
    return trimmed.startsWith(prefix) && trimmed.length > prefix.length ? trimmed : undefined
  }
}

function parseOwnerId(raw: unknown): SettingValue | undefined {
  if (typeof raw !== 'string') {
    return undefined
  }
  const trimmed = raw.trim()
  return USER_ID_PATTERN.test(trimmed) ? trimmed : undefined
}

/** Slack: settings and setup as data, plus the Socket Mode runtime the daemon drives. */
export const slackProvider: Provider = {
  name: 'slack',
  label: 'Slack',
  maxTextLength: SLACK_MAX_TEXT_LENGTH,
  maxAttachmentBytes: SLACK_MAX_ATTACHMENT_BYTES,
  maxOptionCount: SLACK_MAX_OPTION_COUNT,
  settings: [
    {
      configKey: 'botToken',
      envVar: 'JAYPOST_BOT_TOKEN',
      description: 'bot token',
      secret: true,
      owner: false,
      required: true,
      prompt: 'Bot token (xoxb-)',
      parse: parseToken('xoxb-'),
    },
    {
      configKey: 'appToken',
      envVar: 'JAYPOST_APP_TOKEN',
      description: 'app-level token',
      secret: true,
      owner: false,
      required: true,
      prompt: 'App-level token (xapp-)',
      parse: parseToken('xapp-'),
    },
    {
      configKey: 'ownerId',
      envVar: 'JAYPOST_OWNER_ID',
      description: 'owner id',
      secret: false,
      owner: true,
      required: false,
      parse: parseOwnerId,
    },
  ],
  setup: {
    checkCredentials: async (settings) => {
      const identity = await validateTokens(String(settings.botToken), String(settings.appToken))
      return identity.kind === 'ok' && identity.botName !== ''
        ? { ok: true, displayName: `@${identity.botName}` }
        : { ok: false, reason: 'Slack rejected the tokens (or could not be reached)' }
    },
    text: {
      leftoverFound: 'Found Slack tokens kept from an earlier install.',
      reusing: (name) => `Reusing the saved Slack tokens (${name}).`,
      rejected:
        'Slack rejected those tokens, the app lacks scopes from the manifest, or Slack could not be reached. Try again.',
      resetOwnerWarning: 'This unlinks your Slack account.',
    },
  },
  createRuntime: (settings, log) => createSlackRuntime(settings, log),
}
