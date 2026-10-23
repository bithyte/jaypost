import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vite-plus/test'

const CLI_DIRECTORY = new URL('..', import.meta.url).pathname
const VP = join(CLI_DIRECTORY, '..', '..', 'node_modules', '.bin', 'vp')

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('cjs build exposes the client to require()', () => {
  // Under node_modules so the bundle's external dependencies (zod) resolve, as in an installed package.
  const directory = mkdtempSync(join(CLI_DIRECTORY, 'node_modules', '.jaypost-pack-'))
  directories.push(directory)
  const result = spawnSync(VP, ['pack', '--out-dir', directory], {
    cwd: CLI_DIRECTORY,
    encoding: 'utf8',
  })
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(join(directory, 'index.d.cts'))).toBe(true)
  expect(readFileSync(join(directory, 'index.cjs'), 'utf8')).not.toMatch(
    /grammy|@clack|commander|fastify|@discordjs|discord-api-types/,
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

test('pnpm pack names the tarball and the command jaypost and ships the root files', () => {
  // prepack copies them in; --ignore-scripts skips it, along with the build
  const copy = spawnSync(VP, ['run', 'copy-root-files'], { cwd: CLI_DIRECTORY, encoding: 'utf8' })
  expect(copy.status, copy.stderr).toBe(0)
  const result = spawnSync(VP, ['pm', 'pack', '--json', '--', '--dry-run', '--ignore-scripts'], {
    cwd: CLI_DIRECTORY,
    encoding: 'utf8',
  })
  expect(result.status, result.stderr).toBe(0)
  const packed = JSON.parse(result.stdout) as {
    version: string
    filename: string
    files: { path: string }[]
  }
  expect(packed?.filename).toBe(`jaypost-${packed?.version}.tgz`)
  expect(packed.files.map((file) => file.path)).toEqual(
    expect.arrayContaining(['install.sh', 'README.md', 'LICENSE']),
  )
  const manifest = JSON.parse(readFileSync(join(CLI_DIRECTORY, 'package.json'), 'utf8')) as {
    bin: unknown
  }
  expect(manifest.bin).toEqual({ jaypost: 'dist/cli.js' })
}, 30_000)
