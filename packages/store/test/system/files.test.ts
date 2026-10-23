import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vite-plus/test'
import { isMissingFileError, writeFileAtomic } from '../../src/system/index.ts'

function createTempDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'files-test-'))
}

test('writeFileAtomic creates parent directories and writes the content with the given mode', () => {
  const root = createTempDirectory()
  const path = join(root, 'nested', 'deeper', 'secret.json')
  writeFileAtomic(path, 'hello\n', 0o600)
  expect(readFileSync(path, 'utf8')).toBe('hello\n')
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test('replacing a file gives it a new inode and leaves no temp file behind', () => {
  const root = createTempDirectory()
  const path = join(root, 'secret.json')
  writeFileAtomic(path, 'first', 0o600)
  const inodeBefore = statSync(path).ino
  writeFileAtomic(path, 'second', 0o600)
  expect(statSync(path).ino).not.toBe(inodeBefore)
  expect(readFileSync(path, 'utf8')).toBe('second')
  expect(readdirSync(root)).toEqual(['secret.json'])
})

test('writing through a symlink keeps the link and updates its target', () => {
  const root = createTempDirectory()
  const target = join(root, 'real.json')
  const link = join(root, 'link.json')
  writeFileSync(target, 'old')
  symlinkSync(target, link)
  writeFileAtomic(link, 'new', 0o600)
  expect(lstatSync(link).isSymbolicLink()).toBe(true)
  expect(readFileSync(target, 'utf8')).toBe('new')
  expect(readdirSync(root).toSorted()).toEqual(['link.json', 'real.json'])
})

test('a failed rename throws, keeps the old target and removes the temp file', () => {
  const root = createTempDirectory()
  const path = join(root, 'target')
  mkdirSync(path)
  writeFileSync(join(path, 'marker'), 'keep')
  expect(() => writeFileAtomic(path, 'new', 0o600)).toThrow()
  expect(statSync(path).isDirectory()).toBe(true)
  expect(readFileSync(join(path, 'marker'), 'utf8')).toBe('keep')
  expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
})

test('isMissingFileError is true only for ENOENT', () => {
  const root = createTempDirectory()
  const readError = (path: string): unknown => {
    try {
      readFileSync(path, 'utf8')
    } catch (error) {
      return error
    }
    throw new Error('expected the read to fail')
  }
  expect(isMissingFileError(readError(join(root, 'missing')))).toBe(true)
  expect(isMissingFileError(readError(root))).toBe(false)
  expect(isMissingFileError(new Error('ENOENT'))).toBe(false)
  expect(isMissingFileError('ENOENT')).toBe(false)
})
