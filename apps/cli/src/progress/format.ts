const SECONDS_PER_HOUR = 3600

const SECONDS_PER_MINUTE = 60

/** `m:ss`, or `h:mm:ss` from one hour up; floors partial seconds and clamps negatives to zero. */
export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR)
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)
  const seconds = String(totalSeconds % SECONDS_PER_MINUTE).padStart(2, '0')
  if (hours === 0) {
    return `${minutes}:${seconds}`
  }
  return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
}
