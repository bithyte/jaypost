import { createHash } from 'node:crypto'
import { chmod, rename, rm, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import type { Exec } from '@jaypost/store'
import { CHECKSUMS_ASSET, DOWNLOAD_TIMEOUT_MS } from './constants.ts'
import type { LatestRelease } from './types.ts'
import { parseChecksums } from './version.ts'

/** Inputs for `replaceBinary`; `exec` runs the downloaded binary to check its version. */
export type ReplaceBinaryOptions = {
  readonly release: LatestRelease
  readonly assetName: string
  /** Node's `process.platform`; darwin binaries are code-signed before they run. */
  readonly platform: string
  readonly destination: string
  readonly exec: Exec
  readonly signal?: AbortSignal
}

async function download(url: string, signal: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`download of ${url} failed: HTTP ${response.status}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

function requireAssetUrl(release: LatestRelease, name: string): string {
  const url = release.assets[name]
  if (url === undefined) {
    throw new Error(`no ${name} on release ${release.version} yet`)
  }
  return url
}

/** macOS kills unsigned binaries on arm64: keep a valid signature, else sign ad hoc. */
async function ensureSigned(exec: Exec, path: string, assetName: string): Promise<void> {
  if ((await exec('codesign', ['--verify', path])).code === 0) {
    return
  }
  const signed = await exec('codesign', ['--sign', '-', '--force', path])
  if (signed.code !== 0) {
    throw new Error(`couldn't sign downloaded ${assetName}: ${signed.stderr.trim()}`)
  }
}

/**
 * Downloads `assetName` from the release, checks its sha256 against `SHA256SUMS`, gunzips it next
 * to `destination`, requires it to report the release version, then renames it over `destination`.
 * Throws on any failure; the destination is untouched and no temp file is left behind.
 */
export async function replaceBinary(options: ReplaceBinaryOptions): Promise<void> {
  const { release, assetName, platform, destination, exec } = options
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const assetUrl = requireAssetUrl(release, assetName)
  const checksumsUrl = requireAssetUrl(release, CHECKSUMS_ASSET)
  const checksums = parseChecksums((await download(checksumsUrl, signal)).toString('utf8'))
  const expected = checksums.get(assetName)
  if (expected === undefined) {
    throw new Error(`no checksum for ${assetName} in ${CHECKSUMS_ASSET}`)
  }
  const compressed = await download(assetUrl, signal)
  const actual = createHash('sha256').update(compressed).digest('hex')
  if (actual !== expected) {
    throw new Error(`checksum of ${assetName} doesn't match ${CHECKSUMS_ASSET}`)
  }
  const temp = `${destination}.${process.pid}.tmp`
  try {
    await writeFile(temp, gunzipSync(compressed))
    // chmod after writing: the umask can strip bits at creation.
    await chmod(temp, 0o755)
    if (platform === 'darwin') {
      await ensureSigned(exec, temp, assetName)
    }
    const result = await exec(temp, ['--version'])
    const reported = result.stdout.trim()
    if (result.code !== 0 || reported !== release.version) {
      throw new Error(
        `downloaded ${assetName} reports version ${JSON.stringify(reported)}, expected ${release.version}`,
      )
    }
    signal.throwIfAborted()
    await rename(temp, destination)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}
