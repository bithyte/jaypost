import { expect, test } from 'vite-plus/test'
import { collectSettings, hasRequiredSecrets, listSecretValues } from '@jaypost/core'
import { ntfyProvider, parseServer, parseToken, parseTopic } from '../../src/ntfy/index.ts'

test('parseServer keeps http and https urls without trailing slashes', () => {
  expect(parseServer('https://ntfy.sh')).toBe('https://ntfy.sh')
  expect(parseServer(' https://ntfy.example.com/ ')).toBe('https://ntfy.example.com')
  expect(parseServer('http://10.0.0.2:8080/ntfy//')).toBe('http://10.0.0.2:8080/ntfy')
})

test('parseServer refuses anything else', () => {
  expect(parseServer('ntfy.sh')).toBeUndefined()
  expect(parseServer('ftp://ntfy.sh')).toBeUndefined()
  expect(parseServer('https://user:pass@ntfy.sh')).toBeUndefined()
  expect(parseServer('https://ntfy.sh/?auth=x')).toBeUndefined()
  expect(parseServer(42)).toBeUndefined()
})

test('parseTopic accepts what ntfy accepts, leaving room for the reply suffix', () => {
  expect(parseTopic(' my_topic-1 ')).toBe('my_topic-1')
  expect(parseTopic('a'.repeat(56))).toBe('a'.repeat(56))
  expect(parseTopic('a'.repeat(57))).toBeUndefined()
  expect(parseTopic('has space')).toBeUndefined()
  expect(parseTopic('')).toBeUndefined()
})

test('parseToken trims and refuses empty', () => {
  expect(parseToken(' tk_abc ')).toBe('tk_abc')
  expect(parseToken('  ')).toBeUndefined()
  expect(parseToken(undefined)).toBeUndefined()
})

test('the topic and token are secrets; only the topic is required', () => {
  const settings = collectSettings(ntfyProvider, (setting) =>
    setting.configKey === 'ntfyTopic' ? 'jaypost-0123456789abcdef' : undefined,
  )
  expect(settings).toEqual({ ntfyTopic: 'jaypost-0123456789abcdef' })
  expect(hasRequiredSecrets(ntfyProvider, settings)).toBe(true)
  expect(
    listSecretValues(ntfyProvider, { ...settings, ntfyServer: 'https://ntfy.sh', ntfyToken: 'tk' }),
  ).toEqual(['jaypost-0123456789abcdef', 'tk'])
})
