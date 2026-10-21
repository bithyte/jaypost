import { expect, test } from 'vite-plus/test'
import { DistChecker } from '../../site/src/dist-check/index.ts'

const BASE = '/jaypost'

test('accepts urls under the base and external or fragment urls', () => {
  const html = [
    '<link href="/jaypost/favicon.svg">',
    '<script src="/jaypost/_astro/x.js"></script>',
    '<a href="https://github.com/bithyte/jaypost">repo</a>',
    '<a href="#install">install</a>',
  ].join('\n')
  expect(DistChecker.findProblems([{ path: 'index.html', html }], BASE)).toEqual([])
})

test('flags root-relative urls outside the base', () => {
  expect(
    DistChecker.findProblems([{ path: 'index.html', html: '<link href="/favicon.svg">' }], BASE),
  ).toEqual([{ path: 'index.html', problem: 'url "/favicon.svg" is outside base "/jaypost"' }])
})

test('flags em-dashes in page text', () => {
  expect(DistChecker.findProblems([{ path: 'index.html', html: '<p>a — b</p>' }], BASE)).toEqual([
    { path: 'index.html', problem: 'em-dash in page text' },
  ])
})

test('returns nothing for no pages', () => {
  expect(DistChecker.findProblems([], BASE)).toEqual([])
})
