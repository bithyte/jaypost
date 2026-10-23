import {
  CHECKSUM_LINE_PATTERN,
  SEMVER_PATTERN,
  SUPPORTED_ARCHITECTURES,
  SUPPORTED_PLATFORMS,
} from './constants.ts'

function parseSemver(version: string): readonly number[] | undefined {
  const match = SEMVER_PATTERN.exec(version)
  if (!match) {
    return undefined
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Negative, 0 or positive like a sort comparator. A string that isn't `X.Y.Z` is older than any
 * `X.Y.Z`, and two such strings compare equal. Never throws.
 */
export function compareVersions(left: string, right: string): number {
  const leftParts = parseSemver(left)
  const rightParts = parseSemver(right)
  if (!leftParts || !rightParts) {
    return Number(leftParts !== undefined) - Number(rightParts !== undefined)
  }
  for (const [index, leftPart] of leftParts.entries()) {
    const difference = leftPart - (rightParts[index] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

/** Release asset name for a Node platform and arch, or undefined when no binary ships for it. */
export function formatAssetName(platform: string, arch: string): string | undefined {
  if (!SUPPORTED_PLATFORMS.includes(platform) || !SUPPORTED_ARCHITECTURES.includes(arch)) {
    return undefined
  }
  return `jaypost-${platform}-${arch}.gz`
}

/** Parses `sha256sum` output into file name to lowercase hex; skips lines that don't match. */
export function parseChecksums(text: string): ReadonlyMap<string, string> {
  const checksums = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = CHECKSUM_LINE_PATTERN.exec(line.trim())
    if (match?.[1] && match[2]) {
      checksums.set(match[2], match[1].toLowerCase())
    }
  }
  return checksums
}
