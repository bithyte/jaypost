// Copies package.json's version into claude-plugin/.claude-plugin/plugin.json. Only the version
// line is replaced, so the formatted file stays as it was. `--root <dir>` overrides the repo root.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const VERSION_LINE_PATTERN = /^(\s*"version": ")[^"]*(")/m

const { values } = parseArgs({ options: { root: { type: 'string' } } })
const root = values.root ?? new URL('..', import.meta.url).pathname
const manifestPath = join(root, 'claude-plugin', '.claude-plugin', 'plugin.json')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string
}
const manifest = readFileSync(manifestPath, 'utf8')
if (!VERSION_LINE_PATTERN.test(manifest)) {
  throw new Error(`plugin manifest ${JSON.stringify(manifestPath)} has no version line`)
}
writeFileSync(manifestPath, manifest.replace(VERSION_LINE_PATTERN, `$1${version}$2`))
