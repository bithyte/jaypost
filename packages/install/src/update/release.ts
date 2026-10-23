import { z } from 'zod'
import { FETCH_TIMEOUT_MS } from './constants.ts'
import type { LatestRelease } from './types.ts'

const releaseSchema = z.object({
  tag_name: z.string().min(1),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })),
})

const npmSchema = z.object({ version: z.string().min(1) })

async function fetchJson(url: string, label: string, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!response.ok) {
    throw new Error(`${label} lookup failed: HTTP ${response.status}`)
  }
  return response.json()
}

/** Fetches the latest GitHub release. Throws on HTTP errors and unexpected bodies. */
export async function fetchLatestRelease(
  url: string,
  signal?: AbortSignal,
): Promise<LatestRelease> {
  const release = releaseSchema.parse(await fetchJson(url, 'GitHub release', signal))
  return {
    version: release.tag_name.replace(/^v/, ''),
    assets: Object.fromEntries(
      release.assets.map((asset) => [asset.name, asset.browser_download_url]),
    ),
  }
}

/** Fetches the latest version published on npm. Throws on HTTP errors and unexpected bodies. */
export async function fetchLatestNpmVersion(url: string, signal?: AbortSignal): Promise<string> {
  return npmSchema.parse(await fetchJson(url, 'npm', signal)).version
}
