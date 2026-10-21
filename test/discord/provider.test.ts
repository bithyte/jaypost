import { expect, test } from 'vite-plus/test'
import { discordProvider } from '../../src/discord/index.ts'

const owner = discordProvider.settings.find((setting) => setting.owner)
const token = discordProvider.settings.find((setting) => setting.configKey === 'botToken')

test('identity and limits', () => {
  expect([discordProvider.name, discordProvider.label]).toEqual(['discord', 'Discord'])
  expect([
    discordProvider.maxTextLength,
    discordProvider.maxAttachmentBytes,
    discordProvider.maxOptionCount,
  ]).toEqual([1800, 10_485_760, 25])
})

test('owner id accepts snowflake strings only', () => {
  expect(owner?.envVar).toBe('OWNER_ID')
  expect(owner?.required).toBe(false)
  expect(owner?.prompt).toBeUndefined()
  expect(owner?.parse(' 123456789012345678 ')).toBe('123456789012345678')
  expect(owner?.parse('12345')).toBeUndefined()
  expect(owner?.parse('123456789012345678901')).toBeUndefined()
  expect(owner?.parse(123456789012345680)).toBeUndefined()
  expect(owner?.parse('-123456789012345678')).toBeUndefined()
})

test('bot token is a required secret that parses non-empty strings', () => {
  expect(token).toMatchObject({
    envVar: 'BOT_TOKEN',
    secret: true,
    required: true,
    prompt: 'Bot token',
    owner: false,
  })
  expect(token?.parse('abc')).toBe('abc')
  expect(token?.parse('')).toBeUndefined()
  expect(token?.parse(5)).toBeUndefined()
})

test('setup text is discord specific', () => {
  const { text } = discordProvider.setup
  expect(text.reusing('@bot')).toBe('Reusing the saved bot token (@bot).')
  expect(text.resetOwnerWarning).toBe('This unlinks your Discord account.')
  expect(text.rejected).toBe('Discord rejected that token (or could not be reached). Try again.')
})
