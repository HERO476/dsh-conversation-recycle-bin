/**
 * The always-unavailable fallback adapter.
 *
 * Its job is honesty in the UI: when no memory store is detected the confirm
 * dialog must say "memory store not available", not "0 entries" (which would
 * read as "we looked and there is nothing to delete"). It exposes the same
 * shape as a real adapter so the registry has no special cases.
 */
export function createNoneAdapter() {
  return {
    id: 'none',
    // Neutral label + a stable reason key: the Client localizes both by id, so
    // an English sentence here used to appear untranslated in a Chinese UI.
    label: 'none',
    async probe() {
      return { available: false, reason: 'no-memory-store', storePath: null }
    },
    async countSessions(sessionIds) {
      const counts = new Map()
      for (const id of sessionIds) counts.set(id, 0)
      return { counts, protected: 0 }
    },
    async exportSession(sessionId) {
      return {
        format: 1,
        adapter: 'none',
        sessionId,
        createdAt: Date.now(),
        count: 0,
        entries: [],
        links: [],
      }
    },
    async restoreBundle() {
      // nothing to restore
    },
  }
}
