import { expect, test } from 'vite-plus/test'
import {
  resolveBookPath,
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

test('resolveBookPath and resolveJaypostDirectory ignore JAYPOST_CONFIG', () => {
  expect(resolveBookPath({ HOME: '/h' })).toBe('/h/.config/jaypost/bots.json')
  expect(resolveBookPath({ HOME: '/h', XDG_CONFIG_HOME: '/x' })).toBe('/x/jaypost/bots.json')
  expect(resolveJaypostDirectory({ HOME: '/h', JAYPOST_CONFIG: '/c/config.json' })).toBe(
    '/h/.config/jaypost',
  )
})
