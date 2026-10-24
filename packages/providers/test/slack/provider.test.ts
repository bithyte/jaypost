import { expect, test } from 'vite-plus/test'
import { slackProvider } from '../../src/slack/index.ts'

const owner = slackProvider.settings.find((setting) => setting.owner)
const botToken = slackProvider.settings.find((setting) => setting.configKey === 'botToken')
const appToken = slackProvider.settings.find((setting) => setting.configKey === 'appToken')

test('identity and limits', () => {
  expect([slackProvider.name, slackProvider.label]).toEqual(['slack', 'Slack'])
  expect([
    slackProvider.maxTextLength,
    slackProvider.maxAttachmentBytes,
    slackProvider.maxOptionCount,
  ]).toEqual([3000, 10_485_760, 25])
})

test('owner id accepts slack user ids only', () => {
  expect(owner).toMatchObject({ envVar: 'JAYPOST_OWNER_ID', required: false })
  expect(owner?.prompt).toBeUndefined()
  expect(owner?.parse(' U012AB3CD ')).toBe('U012AB3CD')
  expect(owner?.parse('W012AB3CD')).toBe('W012AB3CD')
  expect(owner?.parse('u012ab3cd')).toBeUndefined()
  expect(owner?.parse('C012AB3CD')).toBeUndefined()
  expect(owner?.parse(12)).toBeUndefined()
})

test('both tokens are required secrets with their own prefix', () => {
  expect(botToken).toMatchObject({
    envVar: 'JAYPOST_BOT_TOKEN',
    secret: true,
    required: true,
    prompt: 'Bot token (xoxb-)',
  })
  expect(appToken).toMatchObject({
    envVar: 'JAYPOST_APP_TOKEN',
    secret: true,
    required: true,
    prompt: 'App-level token (xapp-)',
  })
  expect(botToken?.parse(' xoxb-1-abc ')).toBe('xoxb-1-abc')
  expect(botToken?.parse('xapp-1-abc')).toBeUndefined()
  expect(botToken?.parse('xoxb-')).toBeUndefined()
  expect(appToken?.parse('xapp-1-abc')).toBe('xapp-1-abc')
  expect(appToken?.parse('xoxb-1-abc')).toBeUndefined()
  expect(appToken?.parse(5)).toBeUndefined()
})

test('setup text is slack specific', () => {
  const { text } = slackProvider.setup
  expect(text.reusing('@jaypost')).toBe('Reusing the saved Slack tokens (@jaypost).')
  expect(text.resetOwnerWarning).toBe('This unlinks your Slack account.')
})
