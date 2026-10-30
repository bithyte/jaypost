import { expect, test } from 'vite-plus/test'
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
