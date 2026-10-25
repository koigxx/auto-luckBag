/** Display only: all timing comes from the main process, never a renderer clock. */
export function timeProgress(start?: number | null, end?: number | null, remaining?: number | null): number | null {
  if (start == null || end == null || remaining == null ||
    ![start, end, remaining].every(Number.isFinite) || end <= start) return null
  return Math.round(Math.min(100, Math.max(0, 100 - remaining * 100000 / (end - start))))
}
export function returnProgress(candidate: {
  verifiedAt?: number; startAt?: number; entryRemainingSeconds?: number | null
}): number | null {
  const { verifiedAt, startAt, entryRemainingSeconds } = candidate
  return timeProgress(verifiedAt, startAt, entryRemainingSeconds)
}
