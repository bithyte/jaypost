// Packs the jaypost package from this checkout and runs `service install --tarball` with it, so the
// installed service runs the working tree instead of the npm release. Other arguments go to
// `service install` (`pnpm install:local quadlet --port 9000`). The tarball is deleted afterwards;
// every target copies or installs it before then.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = new URL('..', import.meta.url).pathname
const packDirectory = mkdtempSync(join(tmpdir(), 'jaypost-pack-'))
try {
  const pack = spawnSync('pnpm', ['pack', '--pack-destination', packDirectory], {
    cwd: join(root, 'apps', 'cli'),
    stdio: 'inherit',
  })
  if (pack.status !== 0) {
    throw new Error(`pnpm pack failed (exit ${pack.status})`)
  }
  const tarball = readdirSync(packDirectory).find((name) => name.endsWith('.tgz'))
  if (tarball === undefined) {
    throw new Error(`pnpm pack left no tarball in ${JSON.stringify(packDirectory)}`)
  }
  const install = spawnSync(
    process.execPath,
    [
      join(root, 'apps', 'cli', 'src', 'cli.ts'),
      'service',
      'install',
      ...process.argv.slice(2),
      '--tarball',
      join(packDirectory, tarball),
    ],
    { stdio: 'inherit' },
  )
  process.exitCode = install.status ?? 1
} finally {
  rmSync(packDirectory, { recursive: true, force: true })
}
