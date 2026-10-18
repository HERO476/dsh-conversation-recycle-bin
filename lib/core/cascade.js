/**
 * Conversation deletion cascades.
 *
 * Order is fixed and documented in README:
 *
 *   memory  →  messages  →  session/catalog
 *
 * Why exactly this order: memory is the only stage that can be restored from a
 * portable bundle; the message log is the session payload itself (DSH stores a
 * conversation's messages as events inside its append-only session log), and
 * the catalog stage removes the durable workspace/archive bookkeeping last, so
 * an interruption before it leaves the conversation recoverable in the normal
 * list. A failure at ANY stage rolls the completed stages back in reverse order
 * (see `transaction.js`).
 *
 * `soft` mode intentionally does not move the session log: it archives the
 * conversation through the Host's durable archive set, which removes it from
 * the sidebar while keeping every message on disk until an explicit purge.
 * `hard` mode moves the log directory into the plugin's recycle bin, so even a
 * hard delete remains recoverable until the entry is purged.
 *
 * All effects are injected (`ops`) so the pure cascade logic is unit-testable
 * against fakes, while the Host file (`lib/index.js`) supplies the real DSH
 * service adapters.
 */
import { DeleteError } from './errors.js'
import { runSteps } from './transaction.js'
import { join } from 'node:path'

function toDeleteError(result, context) {
  const cause = result.error instanceof Error ? result.error.message : String(result.error)
  return new DeleteError(
    'E_TRANSACTION_FAILED',
    result.rolledBack
      ? `Deleting “${context.title ?? context.sessionId}” failed at the ${result.failedStep} step; all completed steps were rolled back.`
      : `Deleting “${context.title ?? context.sessionId}” failed at the ${result.failedStep} step and the rollback was incomplete. Inspect the audit trail.`,
    {
      sessionId: context.sessionId,
      failedStep: result.failedStep,
      rolledBack: result.rolledBack,
      rollbackErrors: result.rollbackErrors.map((item) => ({
        step: item.step,
        message: item.error instanceof Error ? item.error.message : String(item.error),
      })),
      cause,
    },
    { cause: result.error },
  )
}

function emptyMemorySummary() {
  return { adapters: [], total: 0, protected: 0, skipped: [] }
}

/**
 * Delete ONE conversation transactionally.
 *
 * @param {object} input
 * @param {{ id: string, title?: string, cwd?: string, blank?: boolean, archived?: boolean, workspaceId?: string | null }} input.session
 * @param {'soft'|'hard'} input.mode
 * @param {boolean} input.includeMemory
 * @param {object} input.ops `{ memory, sessionLog, catalog }`
 * @param {object} input.trash trash store (`core/trash.js`)
 * @param {object} input.audit audit log (`core/audit.js`)
 * @param {object} input.config normalized config
 * @param {() => number} [input.now]
 * @param {string} [input.actor]
 * @param {string} [input.requestId]
 * @returns {Promise<{ entry: object, memory: object, durationMs: number }>}
 */
export async function performSessionDelete({
  session,
  mode,
  includeMemory,
  ops,
  trash,
  audit,
  config,
  now = Date.now,
  actor = 'local-user',
  source = 'web-ui',
  requestId = null,
}) {
  const startedAt = now()
  const { trashId, dir } = await trash.allocate({ sessionId: session.id })

  /** @type {object} */
  const entry = {
    format: 1,
    trashId,
    sessionId: session.id,
    title: session.title ?? '',
    cwd: session.cwd ?? null,
    workspaceId: session.workspaceId ?? null,
    mode,
    includeMemory: includeMemory === true,
    deletedAt: startedAt,
    updatedAt: startedAt,
    actor,
    requestId,
    status: 'pending',
    sessionLog: null,
    catalog: null,
    memory: emptyMemorySummary(),
    error: null,
  }
  await trash.write(entry)

  const memoryEnabled = includeMemory === true && config.memory.enabled && config.memory.deleteMode === 'trash'
  const steps = []

  // A live Agent keeps a session log writer attached; remove its log only after
  // the session has been stopped and its in-flight turn has drained. This step
  // is a no-op for cold sessions, so the common path is unchanged.
  if (mode === 'hard' && session.live === true) {
    steps.push({
      name: 'quiesce',
      run: async () => {
        if (typeof ops.lifecycle?.quiesce !== 'function') {
          throw new DeleteError('E_INTERNAL', 'The live-session lifecycle service is unavailable.', { sessionId: session.id })
        }
        return ops.lifecycle.quiesce(session)
      },
    })
  }

  if (memoryEnabled) {
    steps.push({
      name: 'memory',
      run: async () => {
        const bundle = await ops.memory.exportForSession(session.id, dir)
        entry.memory = bundle
        return async () => {
          await ops.memory.restoreEntry(bundle)
          entry.memory = emptyMemorySummary()
        }
      },
    })
  }

  if (mode === 'hard') {
    steps.push({
      name: 'messages',
      run: async () => {
        const moved = await ops.sessionLog.moveToTrash(session, dir)
        try {
          // Record the move immediately. A crash between the move and the
          // final manifest write used to leave a `pending` entry that knew
          // nothing about the log sitting in its directory: discard refused
          // it, restore had nothing to restore, and the payload was stranded.
          await trash.update(entry.trashId, { sessionLog: moved })
        } catch (error) {
          await ops.sessionLog.restoreEntry(moved).catch(() => {})
          throw error
        }
        entry.sessionLog = moved
        return async () => {
          await ops.sessionLog.restoreEntry(moved)
          entry.sessionLog = null
          await trash.update(entry.trashId, { sessionLog: null }).catch(() => {})
        }
      },
    })
  }

  steps.push({
    name: 'session',
    run: async () => {
      const snapshot = await ops.catalog.capture(session)
      entry.catalog = snapshot
      const undo = await ops.catalog.remove(session, mode, snapshot)
      return async () => {
        await undo()
        entry.catalog = null
      }
    },
  })

  steps.push({
    name: 'manifest',
    run: async () => {
      await trash.write({ ...entry, status: 'trashed', updatedAt: now() })
      return async () => {
        await trash.write({ ...entry, status: 'pending', updatedAt: now() })
      }
    },
  })

  steps.push({
    name: 'audit',
    run: async () => {
      await audit.append({
        id: `${trashId}:delete`,
        action: 'delete',
        result: 'success',
        sessionId: session.id,
        title: entry.title,
        mode,
        includeMemory: entry.includeMemory,
        memory: { total: entry.memory.total, adapters: entry.memory.adapters.map((adapter) => ({ id: adapter.id, count: adapter.count })) },
        trashId,
        actor,
        requestId,
        durationMs: now() - startedAt,
        source,
      })
    },
  })

  const result = await runSteps(steps)
  if (!result.ok) {
    entry.status = 'failed'
    entry.error = {
      failedStep: result.failedStep,
      cause: result.error instanceof Error ? result.error.message : String(result.error),
      rolledBack: result.rolledBack,
    }
    // Best-effort bookkeeping; the original failure is the one reported.
    await trash.write({ ...entry, updatedAt: now() }).catch(() => {})
    await audit
      .append({
        id: `${trashId}:delete:failed`,
        action: 'delete',
        result: result.rolledBack ? 'rolled-back' : 'rollback-incomplete',
        sessionId: session.id,
        title: entry.title,
        mode,
        includeMemory: entry.includeMemory,
        trashId,
        actor,
        requestId,
        failedStep: result.failedStep,
        rollback: {
          ok: result.rolledBack,
          errors: result.rollbackErrors.map((item) => ({
            step: item.step,
            message: item.error instanceof Error ? item.error.message : String(item.error),
          })),
        },
        durationMs: now() - startedAt,
        source,
      })
      .catch(() => {})
    throw toDeleteError(result, { sessionId: session.id, title: entry.title })
  }

  return { entry, memory: entry.memory, durationMs: now() - startedAt }
}

/**
 * Statuses a restore may start from.
 *
 * `trashed` is the normal recycle-bin case. The others are the crash/rollback
 * leftovers that `GET /trash` reports as `incomplete`: an entry whose manifest
 * still points at moved payload (a log, a catalog snapshot, a memory bundle) is
 * exactly what a restore is for, and refusing it left the "restore or purge it
 * instead of discarding it" advice from `performDiscard` impossible to follow.
 */
const RESTORABLE_STATUSES = new Set(['trashed', 'pending', 'failed', 'restoring', 'purging'])

/**
 * Restore ONE recycle-bin entry.
 *
 * Restore order is the reverse of delete (payload first, bookkeeping second,
 * memory last), because the workspace entity validates that the session it
 * re-attaches still exists. Only the steps whose payload the manifest still
 * records are run, so a partially rolled-back entry restores what it can.
 *
 * @param {object} input
 * @param {object} input.entry manifest returned by the trash store
 * @param {object} input.ops
 * @param {object} input.trash
 * @param {object} input.audit
 * @param {() => number} [input.now]
 * @param {string} [input.actor]
 * @param {string} [input.requestId]
 */
export async function performRestore({ entry, ops, trash, audit, now = Date.now, actor = 'local-user', source = 'web-ui', requestId = null }) {
  const previousStatus = entry.status
  if (!RESTORABLE_STATUSES.has(previousStatus)) {
    throw new DeleteError('E_TRASH_CONFLICT', 'This recycle-bin entry is not in a restorable state.', { trashId: entry.trashId, status: previousStatus })
  }
  const sessionLog = entry.sessionLog !== null && entry.sessionLog !== undefined && typeof entry.sessionLog === 'object'
    ? entry.sessionLog
    : null
  const catalog = entry.catalog !== null && entry.catalog !== undefined && typeof entry.catalog === 'object' ? entry.catalog : null
  const hasMemory = entry.includeMemory === true && entry.memory !== null && typeof entry.memory === 'object' && (entry.memory.total ?? 0) > 0
  const canStat = typeof ops.pathExists === 'function'
  const logInTrash = sessionLog !== null && (!canStat || await ops.pathExists(sessionLog.to))
  const logInPlace = sessionLog !== null && canStat && await ops.pathExists(sessionLog.from)
  const logMissing = sessionLog !== null && !logInTrash && !logInPlace
  // Re-attaching a hard-deleted conversation whose log is nowhere would leave a
  // conversation with no messages on disk, so that combination stays refused.
  // A log that is already back in place is fine: an interrupted purge can leave
  // exactly that state.
  if (catalog !== null && entry.mode === 'hard' && (sessionLog === null || logMissing)) {
    throw new DeleteError('E_TRASH_CONFLICT', 'The recycle-bin entry has no session-log location; restore is unsafe.', { trashId: entry.trashId })
  }

  const steps = []
  if (entry.mode === 'hard' && logInTrash) {
    steps.push({
      name: 'messages',
      run: async () => {
        const undo = await ops.sessionLog.restoreEntry(sessionLog)
        return async () => {
          await undo()
        }
      },
    })
  }
  if (catalog !== null) {
    steps.push({
      name: 'session',
      run: async () => {
        const undo = await ops.catalog.restore(catalog)
        return async () => {
          await undo()
        }
      },
    })
  }
  if (hasMemory) {
    steps.push({
      name: 'memory',
      run: async () => {
        // `restoreEntry` is a historical API that does not produce an undo;
        // calling an undefined undo during a later rollback used to throw.
        const undo = await ops.memory.restoreEntry(entry.memory)
        return async () => {
          if (typeof undo === 'function') await undo()
        }
      },
    })
  }
  if (steps.length === 0) {
    // The log is already back on disk (an interrupted purge can leave the
    // manifest pointing at a log that was moved back): clearing the entry is
    // the only remaining action, and it is safe.
    if (!(entry.mode === 'hard' && logInPlace)) {
      throw new DeleteError('E_TRASH_CONFLICT', 'The recycle-bin entry has nothing left to restore; discard it to reclaim the space.', {
        trashId: entry.trashId,
        status: previousStatus,
      })
    }
  }

  const startedAt = now()
  await trash.update(entry.trashId, { status: 'restoring' })

  const result = await runSteps(steps)
  if (!result.ok) {
    // Back to the status it came from: a failed restore of an incomplete entry
    // must not promote it to a restorable `trashed` recycle-bin row.
    await trash.update(entry.trashId, { status: previousStatus, updatedAt: now() }).catch(() => {})
    await audit
      .append({
        id: `${entry.trashId}:restore:failed`,
        action: 'restore',
        result: result.rolledBack ? 'rolled-back' : 'rollback-incomplete',
        sessionId: entry.sessionId,
        title: entry.title,
        trashId: entry.trashId,
        actor,
        requestId,
        failedStep: result.failedStep,
        rollback: { ok: result.rolledBack, errors: result.rollbackErrors.map((item) => ({ step: item.step, message: String(item.error) })) },
        source,
      })
      .catch(() => {})
    throw toDeleteError(result, { sessionId: entry.sessionId, title: entry.title })
  }

  await audit.append({
    id: `${entry.trashId}:restore`,
    action: 'restore',
    result: 'success',
    sessionId: entry.sessionId,
    title: entry.title,
    trashId: entry.trashId,
    actor,
    requestId,
    durationMs: now() - startedAt,
    source,
  })
  await trash.remove(entry.trashId).catch(() => {})
  return { trashId: entry.trashId, sessionId: entry.sessionId }
}

/**
 * Permanently delete ONE recycle-bin entry.
 *
 * A soft-deleted entry still owns a live (archived) session, so purging it
 * first stops that session (cancel + archive `stopActivity` + bounded drain)
 * and then performs the missing hard stages — unless the session is already
 * gone, in which case only the bundle remains to be removed.
 *
 * @param {object} input
 * @param {object} input.entry
 * @param {object} input.ops
 * @param {object} input.trash
 * @param {object} input.audit
 * @param {() => number} [input.now]
 * @param {string} [input.actor]
 * @param {string} [input.requestId]
 */
export async function performPurge({ entry, ops, trash, audit, now = Date.now, actor = 'local-user', source = 'web-ui', requestId = null }) {
  if (!['trashed', 'restored'].includes(entry.status)) {
    throw new DeleteError('E_TRASH_CONFLICT', 'This recycle-bin entry cannot be purged in its current state.', { trashId: entry.trashId, status: entry.status })
  }
  const startedAt = now()
  await trash.update(entry.trashId, { status: 'purging' })
  const steps = []

  if (entry.mode === 'soft') {
    const session = await ops.session.inspect(entry.sessionId)
    if (session !== null) {
      if (session.live === true) {
        steps.push({
          name: 'quiesce',
          run: async () => {
            if (typeof ops.lifecycle?.quiesce !== 'function') {
              throw new DeleteError('E_INTERNAL', 'The live-session lifecycle service is unavailable.', { sessionId: session.id })
            }
            return ops.lifecycle.quiesce(session)
          },
        })
      }
      steps.push({
        name: 'messages',
        run: async () => {
          const moved = await ops.sessionLog.moveToTrash(session, trash.entryDir(entry.trashId))
          try {
            await trash.update(entry.trashId, { sessionLog: moved })
          } catch (error) {
            await ops.sessionLog.restoreEntry(moved).catch(() => {})
            throw error
          }
          entry.sessionLog = moved
          return async () => {
            await ops.sessionLog.restoreEntry(moved)
            entry.sessionLog = null
            await trash.update(entry.trashId, { sessionLog: null }).catch(() => {})
          }
        },
      })
      steps.push({
        name: 'session',
        run: async () => {
          const snapshot = await ops.catalog.capture(session)
          const undo = await ops.catalog.remove(session, 'hard', snapshot)
          return async () => {
            await undo()
          }
        },
      })
    }
  }

  steps.push({
    name: 'purge',
    run: async () => {
      await trash.remove(entry.trashId)
    },
  })

  const result = await runSteps(steps)
  if (!result.ok) {
    await trash.update(entry.trashId, { status: 'trashed', updatedAt: now() }).catch(() => {})
    await audit
      .append({
        id: `${entry.trashId}:purge:failed`,
        action: 'purge',
        result: result.rolledBack ? 'rolled-back' : 'rollback-incomplete',
        sessionId: entry.sessionId,
        title: entry.title,
        trashId: entry.trashId,
        actor,
        requestId,
        failedStep: result.failedStep,
        rollback: { ok: result.rolledBack, errors: result.rollbackErrors.map((item) => ({ step: item.step, message: String(item.error) })) },
        source,
      })
      .catch(() => {})
    throw toDeleteError(result, { sessionId: entry.sessionId, title: entry.title })
  }

  await audit.append({
    id: `${entry.trashId}:purge`,
    action: 'purge',
    result: 'success',
    sessionId: entry.sessionId,
    title: entry.title,
    trashId: entry.trashId,
    actor,
    requestId,
    durationMs: now() - startedAt,
    source,
  })
  return { trashId: entry.trashId, sessionId: entry.sessionId }
}

/**
 * Remove one entry that never reached `trashed` (failed, pending, or an
 * interrupted restore/purge).
 *
 * Restore and purge both refuse these statuses, and `trash.list()` hides them,
 * so before this the only way out was manually deleting the directory. The
 * discard is deliberately conservative: when the entry still contains a moved
 * session log, the user is told to restore or purge instead of losing it.
 *
 * @param {object} input
 * @param {object} input.entry
 * @param {object} input.ops
 * @param {object} input.trash
 * @param {object} input.audit
 * @param {() => number} [input.now]
 * @param {string} [input.actor]
 * @param {string} [input.requestId]
 */
export async function performDiscard({ entry, ops, trash, audit, now = Date.now, actor = 'local-user', source = 'web-ui', requestId = null }) {
  if (entry.status === 'trashed') {
    throw new DeleteError('E_TRASH_CONFLICT', 'This entry is a committed deletion; restore or purge it instead of discarding it.', {
      trashId: entry.trashId,
      status: entry.status,
    })
  }
  // Check the DISK, not only the manifest: a crash can land between a move and
  // the manifest write, and the `session/` or `memory/` copy is the only copy.
  const entryDir = trash.entryDir(entry.trashId)
  const holdsLog = typeof ops.pathExists === 'function'
    ? await ops.pathExists(join(entryDir, 'session'))
    : entry.sessionLog !== null && entry.sessionLog !== undefined
  if (holdsLog) {
    throw new DeleteError('E_TRASH_CONFLICT', 'This incomplete entry still holds the conversation log; restore or purge it instead of discarding it.', {
      trashId: entry.trashId,
      status: entry.status,
    })
  }
  const holdsMemory = typeof ops.hasFiles === 'function' ? await ops.hasFiles(join(entryDir, 'memory')) : false
  if (holdsMemory) {
    throw new DeleteError('E_TRASH_CONFLICT', 'This incomplete entry still holds memory files; restore or purge it instead of discarding it.', {
      trashId: entry.trashId,
      status: entry.status,
    })
  }
  const startedAt = now()
  await trash.remove(entry.trashId)
  await audit
    .append({
      id: `${entry.trashId}:discard`,
      action: 'discard',
      result: 'success',
      sessionId: entry.sessionId,
      title: entry.title,
      trashId: entry.trashId,
      status: entry.status,
      actor,
      requestId,
      durationMs: now() - startedAt,
      source,
    })
    .catch(() => {})
  return { trashId: entry.trashId, sessionId: entry.sessionId }
}
