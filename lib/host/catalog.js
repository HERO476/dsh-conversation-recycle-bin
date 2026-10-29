/**
 * DSH-specific implementations of the two cascade stages that touch the live
 * application: the session log payload and the session/workspace catalog.
 *
 * Both use official Service entry points:
 *   - `workspaceRegistry.archiveSession/unarchiveSession/pinSession/unpinSession`
 *   - `Workspace.detachSession/insertSessionBefore/attachSession`
 *
 * Nothing here rewrites `workspace.json` or the session store by hand. Restore
 * state is captured BEFORE the first mutation and every undo re-applies the
 * exact prior state, so a failure in a later stage can put the catalog back:
 * position (next-session anchor), pin and archive flags.
 */
import { join } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import { DeleteError } from '../core/errors.js'
import { moveDirectory, removeProjectionCheckpoint } from './paths.js'

const trim = (value) => (typeof value === 'string' ? value.trim() : '')
const DETAILS_REFUSAL = /active|running|busy/i

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Newest regular-file mtime inside a session directory, or null when the
 * directory cannot be read. A session log is append-only, so any write by a
 * second Host moves this timestamp.
 */
async function latestWriteMs(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return null
  }
  let latest = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    try {
      const info = await stat(join(directory, entry.name))
      if (info.mtimeMs > latest) latest = info.mtimeMs
    } catch {
      // A file removed while scanning does not move the newest write forward.
    }
  }
  return latest === 0 ? null : latest
}

function wrapCatalogError(error, action, sessionId) {
  if (error instanceof DeleteError) return error
  const message = error instanceof Error ? error.message : String(error)
  const code = DETAILS_REFUSAL.test(message) ? 'E_POLICY_LIVE' : 'E_TRANSACTION_FAILED'
  return new DeleteError(code, `Could not ${action} the conversation catalog entry: ${message}`, {
    sessionId,
    action,
    cause: message,
  }, { cause: error })
}

/** Session log payload stage (the "messages" step). */
export function createSessionLogOps({ gateway, paths, config, now = Date.now, delay = sleep, logger = console }) {
  /**
   * A second Host process (the desktop app and `dsh web` share one DSH_HOME)
   * keeps its own live-session table, so `isLive()` cannot see its writers.
   * Before moving a log this process believes is cold, re-check the newest
   * write after a short grace window: a log that keeps growing is refused
   * instead of being moved out from under the other writer.
   *
   * Live sessions are NOT exempt: `quiesce` (which runs before this step in
   * the cascade) only stops THIS process's Agent. A conversation open in a
   * second Host is exactly the writer this check must catch, and it is also
   * the one this process sees as `live`, so the recheck runs for every mode.
   * The grace window is normally already satisfied at that point, which makes
   * the extra cost one mtime scan.
   */
  async function assertNoForeignWriter(session, directory) {
    const grace = Number.isFinite(config?.foreignWriterGraceMs) ? config.foreignWriterGraceMs : 0
    if (grace <= 0) return
    const first = await latestWriteMs(directory)
    if (first === null) return
    const age = now() - first
    if (age >= grace) return
    const waitMs = Math.min(2_000, Math.max(0, grace - age) + 50)
    logger.warn?.(`[conversation-recycle-bin] session ${session.id} was written ${Math.max(0, age)}ms ago; waiting ${waitMs}ms before the move`)
    await delay(waitMs)
    const second = await latestWriteMs(directory)
    if (second !== null && second > first) {
      throw new DeleteError(
        'E_POLICY_FOREIGN_WRITER',
        'The conversation is still being written by another running DSH instance. Close it there and retry.',
        { sessionId: session.id, lastWriteAt: second },
      )
    }
  }

  return {
    /**
     * Move `<sessions>/<slug>/<sessionId>/` into the recycle-bin entry.
     * @returns {Promise<{ sessionId: string, from: string, to: string }>}
     */
    async moveToTrash(session, entryDir) {
      const from = await gateway.findSessionDir(session.id)
      if (from === null) {
        throw new DeleteError('E_NOT_FOUND', 'The conversation log was not found on disk.', { sessionId: session.id })
      }
      await assertNoForeignWriter(session, from)
      const to = join(entryDir, 'session')
      await moveDirectory(from, to)
      // Derived cache only: safe to lose, and removing it here prevents a stale
      // projection row for a session that no longer exists. Best-effort by
      // design — the cache self-heals, so this must not fail the transaction.
      if (paths !== undefined) await removeProjectionCheckpoint(paths.storagesDir, session.id)
      return { sessionId: session.id, from, to }
    },

    async restoreEntry(moved) {
      if (moved === null || typeof moved !== 'object' || typeof moved.from !== 'string' || typeof moved.to !== 'string') {
        throw new DeleteError('E_TRASH_CONFLICT', 'The recycle-bin entry has no usable session-log location.', {})
      }
      await moveDirectory(moved.to, moved.from)
    },
  }
}

/** Session/workspace catalog stage (archive, detach, pin bookkeeping). */
export function createCatalogOps({ ctx, now = Date.now }) {
  const registry = () => {
    let value
    try {
      value = ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry
    } catch {
      value = undefined
    }
    if (value === undefined) {
      throw new DeleteError('E_INTERNAL', 'The workspace registry service is unavailable.', {})
    }
    return value
  }

  function workspaceOf(snapshot) {
    if (snapshot?.workspaceId === null || snapshot?.workspaceId === undefined) return null
    return registry().get(snapshot.workspaceId) ?? null
  }

  function isArchived(service, sessionId) {
    try {
      return Array.isArray(service.archivedSessionIds) && service.archivedSessionIds.includes(sessionId)
    } catch {
      return false
    }
  }

  function isPinned(service, sessionId) {
    try {
      return Array.isArray(service.pinnedSessionIds) && service.pinnedSessionIds.includes(sessionId)
    } catch {
      return false
    }
  }

  /**
   * Put a session back at the position its snapshot recorded.
   *
   * `insertSessionBefore` requires the session to be accounted (the real Host
   * throws `WorkspaceMoveInvalidError` otherwise), so this helper attaches
   * first and only then moves it. Position is cosmetic: a failed move leaves
   * the session attached, which is still correct.
   */
  async function restorePosition(workspace, sessionId, nextSessionId) {
    if (workspace === null) return
    if (!workspace.sessionIds.includes(sessionId)) await workspace.attachSession(sessionId)
    try {
      if (nextSessionId === null || nextSessionId === undefined) {
        await workspace.insertSessionBefore(sessionId, undefined)
      } else if (workspace.sessionIds.includes(nextSessionId)) {
        await workspace.insertSessionBefore(sessionId, nextSessionId)
      }
    } catch {
      // The anchor disappeared or the workspace refused the move; the session
      // is still attached, so only the ordering is lost.
    }
  }

  return {
    /** Capture the exact catalog state before any mutation. */
    async capture(session) {
      const workspace = session.workspaceId === null ? null : registry().get(session.workspaceId) ?? null
      const index = workspace === null ? -1 : workspace.sessionIds.indexOf(session.id)
      const nextSessionId = workspace !== null && index >= 0 ? workspace.sessionIds[index + 1] ?? null : null
      return {
        sessionId: session.id,
        workspaceId: workspace?.id ?? null,
        index,
        nextSessionId,
        archived: session.archived === true,
        pinned: session.pinned === true,
        live: session.live === true,
        capturedAt: now(),
      }
    },

    /**
     * Remove the session from the catalog.
     *  - soft: archive (the Host hides archived Sessions and keeps the log).
     *  - hard: detach from the workspace, drop archive pin state; the log is
     *    moved by the previous stage before this one runs.
     * @returns {Promise<() => Promise<void>>} undo
     */
    async remove(session, mode, snapshot) {
      const service = registry()
      if (mode === 'soft') {
        // stopActivity: the archive step is also the official "stop this
        // conversation" hook, so deleting a running conversation does not
        // leave a writer that would recreate the log after a later purge.
        try {
          await service.archiveSession(session.id, { stopActivity: true })
        } catch (error) {
          throw wrapCatalogError(error, 'archive', session.id)
        }
        return async () => {
          if (!snapshot.archived) await service.unarchiveSession(session.id)
        }
      }

      // Hard mode performs several mutations. Each one pushes its own inverse
      // as it commits, so a failure halfway can put back exactly what this call
      // changed instead of leaving the conversation visibly unarchived,
      // unpinned or moved after a rolled back deletion.
      const wasArchived = isArchived(service, session.id)
      const wasPinned = isPinned(service, session.id)
      const undone = []
      const undoAll = async () => {
        for (const step of [...undone].reverse()) await step()
      }
      try {
        // Drop an existing archive marker (including the one quiesce adds for
        // a live session) — EXCEPT for a live Agent: its pending inbox may
        // still wake after this deletion. Keeping the archive gate as a
        // tombstone makes that wake a blocked pre-step instead of a writer that
        // recreates the moved log. Restore clears the tombstone.
        if (session.live !== true && wasArchived) {
          await service.unarchiveSession(session.id)
          undone.push(async () => { await service.archiveSession(session.id, { stopActivity: true }) })
        }
        if (wasPinned) {
          await service.unpinSession(session.id)
          undone.push(async () => { await service.pinSession(session.id) })
        }
        const workspace = workspaceOf(snapshot)
        if (workspace !== null && workspace.sessionIds.includes(session.id)) {
          await workspace.detachSession(session.id)
          undone.push(async () => {
            const current = workspaceOf(snapshot)
            if (current === null) return
            await restorePosition(current, session.id, snapshot.nextSessionId ?? null)
          })
        }
      } catch (error) {
        await undoAll().catch(() => {})
        throw wrapCatalogError(error, 'detach', session.id)
      }
      return undoAll
    },

    /**
     * Rebuild the catalog state captured by `capture` (used by trash restore).
     *
     * The undo only reverts mutations THIS call made. A soft-deleted session is
     * still attached to its workspace; an unconditional detach in the undo used
     * to remove it from the workspace when a later (memory) step failed.
     *
     * @returns {Promise<() => Promise<void>>} undo
     */
    async restore(snapshot) {
      const service = registry()
      const sessionId = snapshot.sessionId
      const workspace = workspaceOf(snapshot)
      const wasAttached = workspace !== null && workspace.sessionIds.includes(sessionId)
      const wasArchived = isArchived(service, sessionId)
      const wasPinned = isPinned(service, sessionId)
      const changed = new Set()
      try {
        if (workspace !== null && !wasAttached) {
          await workspace.attachSession(sessionId)
          changed.add('attached')
        }
        if (workspace !== null) await restorePosition(workspace, sessionId, snapshot.nextSessionId ?? null)
        if (snapshot.pinned === true && !wasPinned) {
          await service.pinSession(sessionId)
          changed.add('pinned')
        }
        if (snapshot.archived === true) {
          if (!wasArchived) {
            await service.archiveSession(sessionId, { stopActivity: true })
            changed.add('archived')
          }
        } else if (wasArchived) {
          // A soft delete archived the session; restoring an entry whose
          // pre-delete state was NOT archived must undo that archive.
          await service.unarchiveSession(sessionId)
          changed.add('unarchived')
        }
        return async () => {
          if (changed.has('unarchived')) {
            await service.archiveSession(sessionId, { stopActivity: true }).catch(() => {})
          }
          if (changed.has('archived')) {
            await service.unarchiveSession(sessionId).catch(() => {})
          }
          if (changed.has('pinned')) {
            await service.unpinSession(sessionId).catch(() => {})
          }
          if (changed.has('attached')) {
            const current = workspaceOf(snapshot)
            if (current !== null && current.sessionIds.includes(sessionId)) {
              await current.detachSession(sessionId).catch(() => {})
            }
          }
        }
      } catch (error) {
        throw wrapCatalogError(error, 'restore', sessionId)
      }
    },
  }
}
