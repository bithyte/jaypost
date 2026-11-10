import { expect, test } from 'vite-plus/test'
import { findEnvPort } from '../../src/config/paths.ts'
import {
  resolveInboxPath,
  resolveConfigDirectory,
  resolveConfigPath,
  resolveJaypostDirectory,
} from '../../src/config/index.ts'

test('resolveConfigPath defaults under jaypost/service', () => {
  expect(resolveConfigPath({ HOME: '/h' })).toBe('/h/.config/jaypost/service/config.json')
  expect(resolveConfigPath({ HOME: '/h', XDG_CONFIG_HOME: '/x' })).toBe(
    '/x/jaypost/service/config.json',
  )
  expect(resolveConfigPath({ HOME: '/h', JAYPOST_CONFIG: '/c/config.json' })).toBe('/c/config.json')
  expect(resolveConfigDirectory({ HOME: '/h', JAYPOST_CONFIG: '/c/config.json' })).toBe(
    '/h/.config/jaypost/service',
  )
})

test('resolveInboxPath and resolveJaypostDirectory ignore JAYPOST_CONFIG', () => {
  expect(resolveInboxPath({ HOME: '/h' })).toBe('/h/.config/jaypost/inbox.json')
  expect(resolveInboxPath({ HOME: '/h', XDG_CONFIG_HOME: '/x' })).toBe('/x/jaypost/inbox.json')
  expect(resolveJaypostDirectory({ HOME: '/h', JAYPOST_CONFIG: '/c/config.json' })).toBe(
    '/h/.config/jaypost',
  )
})

test('findEnvPort reads a JAYPOST_PORT in range', () => {
  expect(findEnvPort({ JAYPOST_PORT: '1' })).toBe(1)
  expect(findEnvPort({ JAYPOST_PORT: '65535' })).toBe(65_535)
  expect(findEnvPort({ JAYPOST_PORT: '000008080' })).toBe(8080)
})

test('findEnvPort ignores a missing or invalid JAYPOST_PORT', () => {
  for (const raw of [undefined, '', '0', '65536', '80a', '-1', '8.5']) {
    expect(findEnvPort({ JAYPOST_PORT: raw })).toBeUndefined()
  }
})
