/**
 * Sliding-window rate limiter for conversation deletions.
 *
 * Why a sliding window and not a token bucket: the requirement is "N deletions
 * per minute", and an operator auditing the limit expects exactly that. One
 * limiter instance lives in the plugin fiber, so the budget is process-wide
 * (all browser tabs share it) and resets when the Host restarts.
 *
 * `now` is injectable so tests never sleep.
 */
export function createSlidingWindowLimiter({ limit, windowMs, now = Date.now }) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer')
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('windowMs must be positive')

  /** @type {number[]} timestamps of accepted deletions, oldest first */
  const accepted = []

  function prune(current) {
    const cutoff = current - windowMs
    let drop = 0
    while (drop < accepted.length && accepted[drop] <= cutoff) drop += 1
    if (drop > 0) accepted.splice(0, drop)
  }

  return {
    /**
     * Try to reserve `cost` deletions. A reservation that later fails to
     * delete (rollback, writer busy, …) calls `release()` so the failed
     * attempt does not spend the minute quota it never used.
     * @returns {{ ok: true, remaining: number, release: () => void } | { ok: false, retryAfterMs: number, limit: number }}
     */
    take(cost = 1) {
      const current = now()
      prune(current)
      if (accepted.length + cost > limit) {
        const oldest = accepted[0]
        const retryAfterMs = oldest === undefined ? windowMs : Math.max(1, oldest + windowMs - current)
        return { ok: false, retryAfterMs, limit }
      }
      for (let index = 0; index < cost; index += 1) accepted.push(current)
      return {
        ok: true,
        remaining: limit - accepted.length,
        release() {
          // Drop only the reservation we just made: remove `cost` stamps equal
          // to this instant; other concurrent reservations at the same instant
          // stay in place.
          for (let index = 0; index < cost; index += 1) {
            const position = accepted.lastIndexOf(current)
            if (position !== -1) accepted.splice(position, 1)
          }
        },
      }
    },

    /** Current budget without consuming it (used by the preview response). */
    status() {
      const current = now()
      prune(current)
      return {
        limit,
        windowMs,
        used: accepted.length,
        remaining: Math.max(0, limit - accepted.length),
        resetAt: accepted.length === 0 ? null : accepted[0] + windowMs,
      }
    },

    reset() {
      accepted.length = 0
    },
  }
}
