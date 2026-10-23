/** Latest GitHub release: version without the leading `v`, asset name to download URL. */
export type LatestRelease = {
  readonly version: string
  readonly assets: Readonly<Record<string, string>>
}
