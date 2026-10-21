/** GitHub API endpoint for the latest published release. */
export const RELEASES_API_URL = 'https://api.github.com/repos/bithyte/jaypost/releases/latest'
/** npm registry endpoint for the latest published version. */
export const NPM_LATEST_URL = 'https://registry.npmjs.org/jaypost/latest'
/** Release asset listing the sha256 of every other asset. */
export const CHECKSUMS_ASSET = 'SHA256SUMS'
/** Limit for lookups that return small JSON bodies. */
export const FETCH_TIMEOUT_MS = 30_000
/** Limit for downloading a binary. */
export const DOWNLOAD_TIMEOUT_MS = 600_000
/** Matches a plain `X.Y.Z` version. */
export const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/
/** Matches one `sha256sum` line: hex digest, separator, optional `*` binary marker, file name. */
export const CHECKSUM_LINE_PATTERN = /^([0-9a-fA-F]{64}) [ *](.+)$/
/** Platforms that ship a binary. */
export const SUPPORTED_PLATFORMS: readonly string[] = ['linux', 'darwin']
/** Architectures that ship a binary. */
export const SUPPORTED_ARCHITECTURES: readonly string[] = ['x64', 'arm64']
