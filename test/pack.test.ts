import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vite-plus/test'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('cjs build exposes the client to require()', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jaypost-pack-'))
  directories.push(directory)
  const result = spawnSync(join('node_modules', '.bin', 'vp'), ['pack', '--out-dir', directory], {
    encoding: 'utf8',
  })
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(join(directory, 'index.d.cts'))).toBe(true)
  expect(readFileSync(join(directory, 'index.cjs'), 'utf8')).not.toMatch(
    /grammy|@clack|commander|fastify/,
  )
  const library = createRequire(import.meta.url)(join(directory, 'index.cjs'))
  expect(Object.keys(library).toSorted()).toEqual([
    'Client',
    'JaypostError',
    'escapeMarkdown',
    'formatCodeBlock',
  ])
  expect(new library.Client({ port: 9 })).toBeInstanceOf(library.Client)
  expect(new library.JaypostError('boom')).toBeInstanceOf(Error)
}, 30_000)

test('npm pack names the tarball and the command jaypost', () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    encoding: 'utf8',
  })
  expect(result.status, result.stderr).toBe(0)
  const [packed] = JSON.parse(result.stdout) as { version: string; filename: string }[]
  expect(packed?.filename).toBe(`jaypost-${packed?.version}.tgz`)
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { bin: unknown }
  expect(manifest.bin).toEqual({ jaypost: 'dist/cli.js' })
}, 30_000)
