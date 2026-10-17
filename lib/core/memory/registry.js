/**
 * Memory service: one facade over the detected adapters.
 *
 * Responsibilities:
 *  - probe adapter availability (never throws; a broken store degrades to an
 *    explanatory `reason` so the dialog can say "store unavailable");
 *  - count conversation-linked entries for the live preview;
 *  - move entries into the recycle-bin bundle as ONE all-or-nothing stage and
 *    compensate already-exported adapters when a later adapter fails;
 *  - restore a bundle recorded in a trash manifest.
 *
 * Overlapping adapters pointing at the same store file are de-duplicated by
 * store path, so a "generic" adapter configured at the 灵枢 index cannot make
 * the preview count the same entries twice.
 */
import { readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DeleteError } from '../errors.js'

function emptySummary() {
  return { adapters: [], total: 0, protected: 0 }
}

/**
 * @param {object} options
 * @param {Array<object>} options.adapters adapter instances in preference order
 * @param {object} options.config normalized plugin config
 * @param {() => number} [options.now]
 */
export function createMemoryService({ adapters, config, now = Date.now }) {
  const list = adapters.filter((adapter) => adapter !== null && typeof adapter === 'object')
  const byId = new Map(list.map((adapter) => [adapter.id, adapter]))
  let cachedStatus = null
  let cachedAt = -Infinity

  async function status(force = false) {
    if (!force && cachedStatus !== null && now() - cachedAt < 3_000) return cachedStatus
    const states = []
    const seenStores = new Map()
    for (const adapter of list) {
      let probe
      try {
        probe = await adapter.probe()
      } catch (error) {
        probe = { available: false, reason: error instanceof Error ? error.message : String(error), storePath: null }
      }
      const storePath = typeof probe.storePath === 'string' ? probe.storePath : null
      const duplicateOf = storePath !== null && seenStores.has(storePath) ? seenStores.get(storePath) : null
      if (storePath !== null && duplicateOf === null) seenStores.set(storePath, adapter.id)
      states.push({
        id: adapter.id,
        label: adapter.label ?? adapter.id,
        available: probe.available === true && duplicateOf === null,
        reason: duplicateOf !== null ? `duplicate of ${duplicateOf}` : (probe.reason ?? null),
        storePath,
      })
    }
    cachedStatus = states
    cachedAt = now()
    return states
  }

  async function availablePairs() {
    const states = await status(true)
    return states
      .filter((state) => state.available)
      .map((state) => ({ state, adapter: byId.get(state.id) }))
      .filter((pair) => pair.adapter !== undefined)
  }

  return {
    status,

    /** Aggregate count used by the confirm dialog. */
    async countForSessions(sessionIds) {
      const ids = [...new Set(sessionIds)]
      const bySession = Object.fromEntries(ids.map((id) => [id, 0]))
      const perAdapter = []
      let protectedTotal = 0
      if (!config.memory.enabled) {
        return { total: 0, bySession, protected: 0, adapters: [], disabled: true }
      }
      const pairs = await availablePairs()
      for (const { state, adapter } of pairs) {
        try {
          const result = await adapter.countSessions(ids)
          // `counts` is a Map, so the per-adapter total must be summed from the
          // same lookups that fill `bySession`; `Object.values(Map)` is always
          // `[]`, which reported every adapter as "0 entries" next to a
          // non-zero total.
          let adapterCount = 0
          for (const id of ids) {
            const count = result.counts.get(id) ?? 0
            bySession[id] += count
            adapterCount += count
          }
          protectedTotal += result.protected ?? 0
          perAdapter.push({ id: adapter.id, label: adapter.label, count: adapterCount, protected: result.protected ?? 0, available: true, reason: null })
        } catch (error) {
          // A store that passed probe but fails to read is reported as
          // unavailable for this request; counting it as zero would lie.
          perAdapter.push({ id: adapter.id, label: adapter.label, count: 0, protected: 0, available: false, reason: error instanceof Error ? error.message : String(error) })
        }
      }
      if (perAdapter.every((item) => item.available === false) && list.length > 0) {
        const states = await status()
        for (const state of states) {
          if (!perAdapter.some((item) => item.id === state.id)) {
            perAdapter.push({ id: state.id, label: state.label, count: 0, protected: 0, available: false, reason: state.reason })
          }
        }
      }
      return {
        total: Object.values(bySession).reduce((sum, value) => sum + value, 0),
        bySession,
        protected: protectedTotal,
        adapters: perAdapter,
      }
    },

    /**
     * Move one session's memory entries into `<entryDir>/memory/`. Returns the
     * manifest summary. If any adapter fails, already-exported adapters are
     * restored before the error propagates.
     */
    async exportForSession(sessionId, entryDir) {
      if (!config.memory.enabled || config.memory.deleteMode !== 'trash') return emptySummary()
      const pairs = await availablePairs()
      const exported = []
      try {
        for (const { adapter } of pairs) {
          const bundle = await adapter.exportSession(sessionId, entryDir)
          if (bundle !== null && typeof bundle === 'object' && (bundle.count ?? 0) > 0) exported.push(bundle)
        }
        return {
          adapters: exported.map((bundle) => ({
            id: bundle.adapter,
            label: byId.get(bundle.adapter)?.label ?? bundle.adapter,
            count: bundle.count,
            bundlePath: bundle.bundlePath ?? null,
          })),
          total: exported.reduce((sum, bundle) => sum + (bundle.count ?? 0), 0),
          protected: 0,
        }
      } catch (error) {
        for (const bundle of exported.reverse()) {
          const adapter = byId.get(bundle.adapter)
          try {
            await adapter?.restoreBundle(bundle)
          } catch {
            // Compensation is best-effort; the original error is the report.
          }
        }
        throw error instanceof DeleteError
          ? error
          : new DeleteError('E_MEMORY_FAILED', 'Failed to move conversation memory into the recycle bin.', {
              sessionId,
              cause: error instanceof Error ? error.message : String(error),
            }, { cause: error })
      }
    },

    /** Restore every adapter bundle recorded in a trash manifest memory summary. */
    async restoreEntry(summary) {
      if (summary === null || typeof summary !== 'object' || !Array.isArray(summary.adapters)) return
      for (const entry of [...summary.adapters].reverse()) {
        if (typeof entry.bundlePath !== 'string' || entry.bundlePath === '') continue
        const adapter = byId.get(entry.id)
        if (adapter === undefined) {
          throw new DeleteError('E_TRASH_CONFLICT', `The memory adapter "${entry.id}" is no longer installed; the memory bundle cannot be restored.`, {
            adapter: entry.id,
            bundlePath: entry.bundlePath,
          })
        }
        const bundle = JSON.parse(await readFile(entry.bundlePath, 'utf8'))
        await adapter.restoreBundle(bundle)
        // The payload is back in the live store, so the copy in the recycle bin
        // is redundant. Removing it matters: `performDiscard` refuses an
        // incomplete entry that still holds memory files, and a leftover
        // `bundle.json` made every failed delete (memory included) permanently
        // un-cleanable even though its data had been put back.
        await rm(dirname(entry.bundlePath), { recursive: true, force: true }).catch(() => {})
      }
    },
  }
}
