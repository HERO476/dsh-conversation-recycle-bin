/**
 * Recycle-bin retention policy.
 *
 * `trashRetentionDays` used to be informational only: it was validated, shown
 * in `state()` and then never read again, so an entry stayed on disk forever
 * and the documented "30 days" never happened. This module is the single
 * predicate behind the automatic sweep, kept pure so the rule can be tested
 * without a filesystem.
 *
 * Two deliberate refusals:
 *   - only `trashed` entries expire. `pending` / `failed` / `restoring` /
 *     `purging` are mid-transaction or unreadable states: their age says
 *     nothing about whether the transaction committed, so they are surfaced to
 *     the user for an explicit discard instead of being swept.
 *   - an entry whose `deletedAt` is missing, zero or not a finite number is
 *     never treated as "old". Guessing an age would silently destroy data that
 *     a corrupt or hand-edited manifest could not date.
 */

/** Milliseconds in one day; exported so the Client-facing math can reuse it. */
export const DAY_MS = 86_400_000

/**
 * Entries that are past the retention window, oldest first.
 *
 * @param {object[]} entries manifests from `trash.scanAll()`
 * @param {object} options
 * @param {number} options.retentionDays 0 (or negative/NaN) disables the sweep
 * @param {() => number|number} [options.now]
 * @param {number} [options.limit] cap per run so a huge bin cannot stall one sweep
 * @returns {object[]}
 */
export function selectExpired(entries, { retentionDays, now = Date.now, limit = 20 } = {}) {
  const days = Number(retentionDays)
  if (!Number.isFinite(days) || days <= 0) return []
  const at = typeof now === 'function' ? now() : Number(now)
  if (!Number.isFinite(at)) return []
  const cutoff = at - days * DAY_MS
  const expired = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.status !== 'trashed') continue
    if (typeof entry.trashId !== 'string' || entry.trashId === '') continue
    const deletedAt = entry.deletedAt
    if (!Number.isFinite(deletedAt) || deletedAt <= 0) continue
    if (deletedAt > cutoff) continue
    expired.push(entry)
  }
  expired.sort((left, right) => left.deletedAt - right.deletedAt)
  const max = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 20
  return expired.slice(0, max)
}

/**
 * Whole days left before an entry expires, for the Client's per-row hint.
 * `null` when retention is off or the entry cannot be dated.
 *
 * @param {object} entry
 * @param {object} options
 * @param {number} options.retentionDays
 * @param {() => number|number} [options.now]
 * @returns {number|null}
 */
export function daysUntilExpiry(entry, { retentionDays, now = Date.now } = {}) {
  const days = Number(retentionDays)
  if (!Number.isFinite(days) || days <= 0) return null
  const deletedAt = entry?.deletedAt
  if (!Number.isFinite(deletedAt) || deletedAt <= 0) return null
  const at = typeof now === 'function' ? now() : Number(now)
  if (!Number.isFinite(at)) return null
  const left = deletedAt + days * DAY_MS - at
  if (left <= 0) return 0
  return Math.ceil(left / DAY_MS)
}
