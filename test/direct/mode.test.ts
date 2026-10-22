import { expect, test } from 'vite-plus/test'
import { resolveSendMode } from '../../src/direct/index.ts'

test('mode defaults to service and reads direct', () => {
  expect(resolveSendMode({})).toEqual({ kind: 'service' })
  expect(resolveSendMode({ JAYPOST_MODE: '' })).toEqual({ kind: 'service' })
  expect(resolveSendMode({ JAYPOST_MODE: 'service' })).toEqual({ kind: 'service' })
  expect(resolveSendMode({ JAYPOST_MODE: 'direct' })).toEqual({ kind: 'direct' })
})

test('any other mode is invalid', () => {
  expect(resolveSendMode({ JAYPOST_MODE: 'Direct' })).toEqual({ kind: 'invalid', value: 'Direct' })
})
