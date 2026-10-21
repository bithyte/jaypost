import { readFileSync } from 'node:fs'
import { expect, test } from 'vite-plus/test'
import { SNIPPETS, SnippetChecker } from '../../site/src/snippets/index.ts'

test('every site snippet appears in the readme', () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
  expect(SnippetChecker.findMissing(readme, SNIPPETS)).toEqual([])
})

test('reports snippets missing from the readme', () => {
  expect(SnippetChecker.findMissing('run a\n', { a: 'run a', b: 'run b' })).toEqual(['b'])
})

test('ignores whitespace differences', () => {
  expect(
    SnippetChecker.findMissing('curl -X POST \\\n    -d x', { c: 'curl -X POST \\\n  -d x' }),
  ).toEqual([])
})

test('returns nothing for no snippets', () => {
  expect(SnippetChecker.findMissing('', {})).toEqual([])
})
