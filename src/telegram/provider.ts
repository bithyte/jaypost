import type { Provider, SettingValue } from '../provider/index.ts'
import { TELEGRAM_MAX_ATTACHMENT_BYTES, TELEGRAM_MAX_TEXT_LENGTH } from './constants.ts'
import { createTelegramRuntime } from './runtime.ts'
import { validateToken } from './setup.ts'

const INTEGER_PATTERN = /^-?\d+$/

function parseBotToken(raw: unknown): SettingValue | undefined {
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

function parseOwnerId(raw: unknown): SettingValue | undefined {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) ? raw : undefined
  }
  if (typeof raw === 'string' && INTEGER_PATTERN.test(raw.trim())) {
    const value = Number(raw.trim())
    return Number.isSafeInteger(value) ? value : undefined
  }
  return undefined
}

/** Telegram: settings and setup as data, plus the bot runtime the daemon drives. */
export const telegramProvider: Provider = {
  name: 'telegram',
  label: 'Telegram',
  maxTextLength: TELEGRAM_MAX_TEXT_LENGTH,
  maxAttachmentBytes: TELEGRAM_MAX_ATTACHMENT_BYTES,
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
        ? { ok: false, reason: 'Telegram rejected that token (or could not be reached)' }
        : { ok: true, displayName: `@${username}` }
    },
    text: {
      leftoverFound: 'Found a bot token kept from an earlier install.',
      reusing: (name) => `Reusing the saved bot token (${name}).`,
      rejected: 'Telegram rejected that token (or could not be reached). Try again.',
      resetOwnerWarning: 'This unlinks your Telegram account.',
    },
  },
  createRuntime: (settings, log) => createTelegramRuntime(settings, log),
}
