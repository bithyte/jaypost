import type { Provider, SettingValue } from '../provider/index.ts'
import {
  DISCORD_MAX_ATTACHMENT_BYTES,
  DISCORD_MAX_OPTION_COUNT,
  DISCORD_MAX_TEXT_LENGTH,
  SNOWFLAKE_PATTERN,
} from './constants.ts'
import { createDiscordRuntime } from './runtime.ts'
import { validateToken } from './setup.ts'

function parseBotToken(raw: unknown): SettingValue | undefined {
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

function parseOwnerId(raw: unknown): SettingValue | undefined {
  if (typeof raw !== 'string') {
    return undefined
  }
  const trimmed = raw.trim()
  return SNOWFLAKE_PATTERN.test(trimmed) ? trimmed : undefined
}

/** Discord: settings and setup as data, plus the bot runtime the daemon drives. */
export const discordProvider: Provider = {
  name: 'discord',
  label: 'Discord',
  maxTextLength: DISCORD_MAX_TEXT_LENGTH,
  maxAttachmentBytes: DISCORD_MAX_ATTACHMENT_BYTES,
  maxOptionCount: DISCORD_MAX_OPTION_COUNT,
  settings: [
    {
      configKey: 'botToken',
      envVar: 'JAYPOST_BOT_TOKEN',
      description: 'bot token',
      secret: true,
      owner: false,
      required: true,
      prompt: 'Bot token',
      parse: parseBotToken,
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
      const username = await validateToken(String(settings.botToken))
      return username === undefined
        ? { ok: false, reason: 'Discord rejected that token (or could not be reached)' }
        : { ok: true, displayName: `@${username}` }
    },
    text: {
      leftoverFound: 'Found a bot token kept from an earlier install.',
      reusing: (name) => `Reusing the saved bot token (${name}).`,
      rejected: 'Discord rejected that token (or could not be reached). Try again.',
      resetOwnerWarning: 'This unlinks your Discord account.',
    },
  },
  createRuntime: (settings, log) => createDiscordRuntime(settings, log),
}
