import { expect, test } from 'vite-plus/test'
import { compareVersions, formatAssetName, parseChecksums } from '../../src/update/index.ts'

test('compares release versions numerically', () => {
  expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
  expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  expect(compareVersions('1.2.3', '1.3.0')).toBeLessThan(0)
})

test('treats a legacy version as older than any release', () => {
  expect(compareVersions('legacy', '0.0.1')).toBeLessThan(0)
  expect(compareVersions('0.0.1', 'legacy')).toBeGreaterThan(0)
  expect(compareVersions('legacy', 'unknown')).toBe(0)
})

test('names assets for supported platforms only', () => {
  expect(formatAssetName('linux', 'x64')).toBe('jaypost-linux-x64.gz')
  expect(formatAssetName('darwin', 'arm64')).toBe('jaypost-darwin-arm64.gz')
  expect(formatAssetName('win32', 'x64')).toBeUndefined()
  expect(formatAssetName('linux', 'ia32')).toBeUndefined()
})

test('parses sha256sum output', () => {
  expect(parseChecksums(`${'a'.repeat(64)}  jaypost-linux-x64.gz\n`)).toEqual(
    new Map([['jaypost-linux-x64.gz', 'a'.repeat(64)]]),
  )
})

test('parses binary-mode lines, uppercase hex, and skips junk', () => {
  const text = `${'A'.repeat(64)} *file.gz\nnot a checksum line\n\n`
  expect(parseChecksums(text)).toEqual(new Map([['file.gz', 'a'.repeat(64)]]))
})
