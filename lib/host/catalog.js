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
   */
  async function assertNoForeignWriter(session, directory) {
    const grace = Number.isFinite(config?.foreignWriterGraceMs) ? config.foreignWriterGraceMs : 0
    if (grace <= 0 || session.live === true) return
    const first = await latestWriteMs(directory)
    if (first === null) return
    const age = now() - first
    if (age >= grace) return
    const waitMs = Math.min(2_000, Math.max(0, grace - age) + 50)
    logger.warn?.(`[delete-conversation] session ${session.id} was written ${Math.max(0, age)}ms ago; waiting ${waitMs}ms before the move`)
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
      try {
        if (mode === 'soft') {
          // stopActivity: the archive step is also the official "stop this
          // conversation" hook, so deleting a running conversation does not
          // leave a writer that would recreate the log after a later purge.
          await service.archiveSession(session.id, { stopActivity: true })
          return async () => {
            if (!snapshot.archived) await service.unarchiveSession(session.id)
          }
        }

        // Unarchive to drop any archive marker (including the one quiesce adds
        // for a live session) — EXCEPT for a live Agent: its pending inbox may
        // still wake after this deletion. Keeping the archive gate as a
        // tombstone makes that wake a blocked pre-step instead of a writer that
        // recreates the moved log. Restore clears the tombstone.
        if (session.live !== true) await service.unarchiveSession(session.id)
        if (snapshot.pinned) await service.unpinSession(session.id)
        const workspace = workspaceOf(snapshot)
        if (workspace !== null && workspace.sessionIds.includes(session.id)) {
          await workspace.detachSession(session.id)
        }
        return async () => {
          const current = workspaceOf(snapshot)
          if (current !== null) {
            try {
              await current.insertSessionBefore(session.id, snapshot.nextSessionId ?? undefined)
            } catch {
              await current.attachSession(session.id)
            }
          }
          if (snapshot.pinned) await service.pinSession(session.id)
          if (snapshot.archived) await service.archiveSession(session.id, { stopActivity: true })
        }
      } catch (error) {
        throw wrapCatalogError(error, mode === 'soft' ? 'archive' : 'detach', session.id)
      }
    },

    /**
     * Rebuild the catalog state captured by `capture` (used by trash restore).
     * @returns {Promise<() => Promise<void>>} undo
     */
    async restore(snapshot) {
      const service = registry()
      try {
        const workspace = workspaceOf(snapshot)
        if (workspace !== null && !workspace.sessionIds.includes(snapshot.sessionId)) {
          try {
            await workspace.insertSessionBefore(snapshot.sessionId, snapshot.nextSessionId ?? undefined)
          } catch {
            await workspace.attachSession(snapshot.sessionId)
          }
        }
        if (snapshot.pinned) await service.pinSession(snapshot.sessionId)
        if (snapshot.archived) {
          await service.archiveSession(snapshot.sessionId, { stopActivity: true })
        } else {
          // A soft delete archived the session; restoring an entry whose
          // pre-delete state was NOT archived must undo that archive. The call
          // is idempotent, so a hard-delete entry (never archived here) is a
          // no-op.
          await service.unarchiveSession(snapshot.sessionId)
        }
        return async () => {
          const current = workspaceOf(snapshot)
          if (current !== null && current.sessionIds.includes(snapshot.sessionId)) {
            await current.detachSession(snapshot.sessionId)
          }
          if (snapshot.pinned) await service.unpinSession(snapshot.sessionId)
          if (snapshot.archived) await service.unarchiveSession(snapshot.sessionId)
        }
      } catch (error) {
        throw wrapCatalogError(error, 'restore', snapshot.sessionId)
      }
    },
  }
}
