import { expect, test } from 'vite-plus/test'
import { resolveHookProject } from '../src/index.ts'

test('prefers the flag', () => {
  expect(resolveHookProject('web', { CLAUDE_PROJECT_DIR: '/p/api' }, '/c/other')).toBe('web')
})

test('falls back to the basename of CLAUDE_PROJECT_DIR', () => {
  expect(resolveHookProject(undefined, { CLAUDE_PROJECT_DIR: '/p/api' }, '/c/other')).toBe('api')
})

test('falls back to the basename of cwd', () => {
  expect(resolveHookProject(undefined, {}, '/c/other')).toBe('other')
})

test('falls back to claude when nothing else is set', () => {
  expect(resolveHookProject(undefined, {}, undefined)).toBe('claude')
})

test('skips a root directory and falls through to claude', () => {
  expect(resolveHookProject(undefined, { CLAUDE_PROJECT_DIR: '/' }, '/')).toBe('claude')
})

test('skips a blank flag and blank env value', () => {
  expect(resolveHookProject('   ', { CLAUDE_PROJECT_DIR: '  ' }, '/c/other')).toBe('other')
})

test('ignores a trailing slash', () => {
  expect(resolveHookProject(undefined, { CLAUDE_PROJECT_DIR: '/p/api/' }, undefined)).toBe('api')
})

test('skips a blank cwd and falls through to claude', () => {
  expect(resolveHookProject(undefined, {}, '   ')).toBe('claude')
})

test('truncates long names to 100 characters', () => {
  const longName = 'x'.repeat(150)
  expect(resolveHookProject(longName, {}, undefined)).toHaveLength(100)
  expect(
    resolveHookProject(undefined, { CLAUDE_PROJECT_DIR: `/p/${longName}` }, undefined),
  ).toHaveLength(100)
})
