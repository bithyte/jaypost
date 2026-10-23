import { expect, test } from 'vite-plus/test'
import { MAX_ATTACHMENT_BYTES } from '@jaypost/core'
import { loadConfig } from '@jaypost/store'
import { PROVIDERS, SERVICE_PROVIDERS } from '../../src/registry/index.ts'
import { terminalProvider } from '../../src/terminal/index.ts'

test('identity and limits', () => {
  expect([terminalProvider.name, terminalProvider.label]).toEqual(['terminal', 'Terminal'])
  expect(terminalProvider.maxAttachmentBytes).toBe(MAX_ATTACHMENT_BYTES)
})

test('needs no settings, so no token and no pairing', () => {
  expect(terminalProvider.settings).toEqual([])
})

test('init does not offer it', () => {
  expect(PROVIDERS.map((provider) => provider.name)).not.toContain('terminal')
})

test('the service loads it from JAYPOST_PROVIDER=terminal with no config file', () => {
  const config = loadConfig(
    {
      JAYPOST_PROVIDER: 'terminal',
      JAYPOST_CONFIG: '/nonexistent/config.json',
    },
    SERVICE_PROVIDERS,
  )
  expect(config.provider).toBe(terminalProvider)
  expect(config.settings).toEqual({})
})
