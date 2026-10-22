import { readdirSync, readFileSync } from 'node:fs'
import { expect, test } from 'vite-plus/test'
import { SNIPPETS, SnippetChecker } from '../../site/src/snippets/index.ts'

test('every site snippet appears in the readme or docs', () => {
  const docsUrl = new URL('../../docs/', import.meta.url)
  const urls = [
    new URL('../../README.md', import.meta.url),
    ...readdirSync(docsUrl)
      .filter((name) => name.endsWith('.md'))
      .map((name) => new URL(name, docsUrl)),
  ]
  const docs = urls.map((url) => readFileSync(url, 'utf8')).join('\n')
  expect(SnippetChecker.findMissing(docs, SNIPPETS)).toEqual([])
})

test('reports snippets missing from the docs', () => {
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
