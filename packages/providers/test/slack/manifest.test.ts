import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vite-plus/test'
import { REQUIRED_SCOPES, SLASH_COMMAND } from '../../src/slack/index.ts'

const DOCS = join(import.meta.dirname, '..', '..', '..', '..', 'docs')
const MANIFEST_TEXT = readFileSync(join(DOCS, 'slack-app-manifest.json'), 'utf8')
const MANIFEST: unknown = JSON.parse(MANIFEST_TEXT)
const CREATE_LINK_PATTERN = /\(https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=([^)\s]+)\)/

test('the manifest grants the scopes, event and slash command the provider needs', () => {
  expect(MANIFEST).toMatchObject({
    features: {
      app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      slash_commands: [{ command: SLASH_COMMAND }],
    },
    oauth_config: { scopes: { bot: REQUIRED_SCOPES } },
    settings: {
      event_subscriptions: { bot_events: ['message.im'] },
      interactivity: { is_enabled: true },
      socket_mode_enabled: true,
    },
  })
})

test('the create link in the pairing docs carries the manifest file', () => {
  const encoded = CREATE_LINK_PATTERN.exec(readFileSync(join(DOCS, 'pairing.md'), 'utf8'))?.[1]
  expect(encoded).toBeDefined()
  expect(JSON.parse(decodeURIComponent(encoded ?? ''))).toEqual(MANIFEST)
})
