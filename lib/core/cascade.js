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
        try {
          // Persist the summary immediately. The bundle files are already on
          // disk at this point; without this write a crash before the final
          // manifest left a `pending` entry whose manifest claimed
          // `memory.total: 0`, and restore/purge/discard then all refused it —
          // the memory stayed stranded in the entry directory forever.
          await trash.update(entry.trashId, { memory: bundle })
        } catch (error) {
          await ops.memory.restoreEntry(bundle).catch(() => {})
          throw error
        }
        entry.memory = bundle
        return async () => {
          await ops.memory.restoreEntry(bundle)
          entry.memory = emptyMemorySummary()
          await trash.update(entry.trashId, { memory: emptyMemorySummary() }).catch(() => {})
        }
      },
    })
  }

  if (mode === 'hard') {
    steps.push({
      name: 'messages',
      run: async () => {
        // Persist the mapping BEFORE the rename. A crash between the move and
        // the final manifest write used to leave a `pending` entry whose
        // `sessionLog` was null while `session/` held the only copy: discard
        // refused it, restore had "nothing" to restore, and the log was
        // stranded. With the mapping recorded first, either crash side is
        // recoverable (log still in place, or log in the bin with a known
        // destination).
        const moved = await ops.sessionLog.moveToTrash(session, dir, {
          beforeMove: async (mapping) => {
            await trash.update(entry.trashId, { sessionLog: mapping })
            entry.sessionLog = mapping
          },
        })
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
      // Capture is read-only; persist it before the first catalog mutation so
      // a crash after a detach can still restore the workspace position.
      const snapshot = await ops.catalog.capture(session)
      entry.catalog = snapshot
      await trash.update(entry.trashId, { catalog: snapshot })
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

/** Statuses a purge may start from (`restored` = an interrupted restore). */
const PURGEABLE_STATUSES = new Set(['trashed', 'restored'])

/**
 * The single answer to "what may be done with this entry".
 *
 * The UI used to decide from `status !== 'trashed'` while restore/purge/discard
 * each re-derived their own predicate, which is how a row could be rendered
 * with a button the route then refused. Status-only questions live here; the
 * disk-dependent half (`canDiscard` while payload is still present) stays with
 * the caller, which is the only side that can stat the entry directory.
 *
 * @param {{ status?: unknown }} entry
 * @param {{ hasLogFiles?: boolean|null, hasMemoryFiles?: boolean|null, payloadRecoverable?: boolean|null, requirePayload?: boolean }} [disk]
 *   `requirePayload` makes `canRestore` false for entry states that have no
 *   payload at all (nothing in the manifest and nothing on disk), which is the
 *   answer the list endpoint publishes to the Client.
 *   `payloadRecoverable === false` means the log copy is on disk but its header
 *   cannot be read: restore has no path to put it back to, so the only action
 *   that can reclaim the space is discard.
 */
export function entryCapabilities(entry, disk = {}) {
  const status = typeof entry?.status === 'string' && entry.status !== '' ? entry.status : 'unknown'
  const hasLogFiles = disk.hasLogFiles ?? null
  const hasMemoryFiles = disk.hasMemoryFiles ?? null
  // Unreadable log ≠ restorable log. Offering restore here produced a button
  // that always failed with "discard it", while discard itself refused.
  const unrecoverable = disk.payloadRecoverable === false
  const hasSessionLog = entry?.sessionLog !== null && entry?.sessionLog !== undefined
  const hasCatalog = entry?.catalog !== null && entry?.catalog !== undefined
  const memoryTotal = typeof entry?.memory?.total === 'number' ? entry.memory.total : 0
  // `requirePayload` is set by the list endpoint, which is allowed to stat the
  // entry directory. `performRestore` itself keeps the status-only gate: it can
  // rebuild an unrecorded memory bundle or a moved log from disk, so refusing
  // that state at the door would break the very recovery it implements.
  const hasPayload = hasSessionLog || hasCatalog || memoryTotal > 0 || hasLogFiles === true || hasMemoryFiles === true
  return {
    status,
    canRestore: RESTORABLE_STATUSES.has(status) && !unrecoverable && (disk.requirePayload !== true || hasPayload),
    canPurge: PURGEABLE_STATUSES.has(status),
    // Discard is the escape hatch for entries that never committed: it is
    // refused while a payload copy still exists, because deleting the folder
    // would destroy the only copy of a log or a memory bundle. The one
    // exception is a log whose header cannot be read — nothing can use it any
    // more, so discarding is the only way to get the disk space back.
    canDiscard: status !== 'trashed' && hasMemoryFiles !== true && (unrecoverable || hasLogFiles !== true),
  }
}

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
  if (!entryCapabilities(entry).canRestore) {
    throw new DeleteError('E_TRASH_CONFLICT', 'This recycle-bin entry is not in a restorable state.', { trashId: entry.trashId, status: previousStatus })
  }
  let sessionLog = entry.sessionLog !== null && entry.sessionLog !== undefined && typeof entry.sessionLog === 'object'
    ? entry.sessionLog
    : null
  // A crash between the log move and its manifest write leaves the log in
  // `session/` while the manifest still says `null`. Rebuild the original path
  // from the log header so restore can put it back instead of answering
  // "nothing left to restore" (the discard route refuses that folder too, so
  // without this the only copy was stranded).
  if (sessionLog === null && typeof ops.recoverSessionLog === 'function') {
    sessionLog = await ops.recoverSessionLog(entry).catch(() => null)
  }
  // If the log copy is on disk but its header cannot be read (truncated, wrong
  // codec, missing `cwd`), there is no path to put it back to and no state it
  // can ever reach. Say that plainly instead of "nothing left to restore",
  // which sent the user to a discard that then refused to run.
  if (sessionLog === null && typeof ops.pathExists === 'function' && typeof trash?.entryDir === 'function') {
    const dir = trash.entryDir(entry.trashId)
    if (typeof dir === 'string' && await ops.pathExists(join(dir, 'session')).catch(() => false)) {
      throw new DeleteError('E_TRASH_CONFLICT', 'The conversation log in this recycle-bin entry cannot be read, so it cannot be restored. Discard the entry to reclaim the space.', {
        trashId: entry.trashId,
        reason: 'log-unreadable',
      })
    }
  }
  const catalog = entry.catalog !== null && entry.catalog !== undefined && typeof entry.catalog === 'object' ? entry.catalog : null
  let memorySummary = entry.memory !== null && entry.memory !== undefined && typeof entry.memory === 'object' ? entry.memory : null
  let hasMemory = entry.includeMemory === true && memorySummary !== null && (memorySummary.total ?? 0) > 0
  // A delete that crashed between "memory bundle exported" and "manifest
  // written" leaves the bundles on disk while the manifest still says
  // `total: 0`. Rebuild the summary from the directory instead of claiming
  // there is nothing to restore (which made the entry impossible to finish).
  if (!hasMemory && entry.includeMemory === true && typeof ops.memory?.readExported === 'function') {
    const entryDir = typeof trash?.entryDir === 'function' ? trash.entryDir(entry.trashId) : null
    if (typeof entryDir === 'string') {
      const recovered = await ops.memory.readExported(entryDir).catch(() => null)
      if (recovered !== null && (recovered.total ?? 0) > 0) {
        memorySummary = recovered
        hasMemory = true
      }
    }
  }
  const canStat = typeof ops.pathExists === 'function'
  // Manifest paths are untrusted input: `restore` moves `from` → `to`, so a
  // hand-edited manifest could otherwise make this plugin a confused proxy
  // that stats and moves arbitrary directories. Both sides must stay inside
  // their own storage roots.
  if (sessionLog !== null) {
    // A caller that cannot answer "is this inside our own storage?" gets a
    // refusal, not the benefit of the doubt: the default used to be `true`,
    // which made the whole guard optional.
    const fromOk = typeof ops.isInsideSessionsRoot === 'function'
      ? ops.isInsideSessionsRoot(sessionLog.from) === true
      : false
    const toOk = typeof ops.isInsideTrashDir === 'function'
      ? ops.isInsideTrashDir(sessionLog.to) === true
      : false
    if (!fromOk || !toOk) {
      throw new DeleteError(
        'E_TRASH_CONFLICT',
        'This recycle-bin entry points outside its own storage; restore is unsafe.',
        { trashId: entry.trashId, fromInsideSessions: fromOk, toInsideTrash: toOk },
      )
    }
  }
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
        const undo = await ops.memory.restoreEntry(memorySummary)
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
  // Only clear the entry directory once its memory bundles are actually gone.
  // `restoreEntry` removes the bundles it consumed; if memory files are still
  // there (an adapter was uninstalled, a bundle was unreadable) removing the
  // directory here would silently destroy the only remaining copy.
  const memoryFilesLeft = typeof ops.hasFiles === 'function' && typeof trash?.entryDir === 'function'
    ? await ops.hasFiles(join(trash.entryDir(entry.trashId), 'memory')).catch(() => true)
    : false
  if (!memoryFilesLeft) await trash.remove(entry.trashId).catch(() => {})
  return { trashId: entry.trashId, sessionId: entry.sessionId, memoryLeftOnDisk: memoryFilesLeft }
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
  if (!entryCapabilities(entry).canPurge) {
    throw new DeleteError('E_TRASH_CONFLICT', 'This recycle-bin entry cannot be purged in its current state.', { trashId: entry.trashId, status: entry.status })
  }
  const startedAt = now()
  // Both checks happen BEFORE the status moves to `purging`: doing them after
  // the write left a thrown refusal with the entry stuck in a state that
  // neither restore nor the retention sweep will ever pick up again.
  let softSession = null
  if (entry.mode === 'soft' && typeof ops.session?.inspect === 'function') {
    try {
      softSession = await ops.session.inspect(entry.sessionId)
    } catch (error) {
      throw new DeleteError('E_INTERNAL', 'Could not tell whether the conversation is still visible, so the entry was not purged.', {
        trashId: entry.trashId,
        sessionId: entry.sessionId,
        cause: error instanceof Error ? error.message : String(error),
      }, { cause: error })
    }
    // A soft-deleted entry archived its session. If the user brought it back,
    // the conversation is visible and usable again; purging would stop it and
    // delete it a second time, which is the opposite of what restore promised.
    if (softSession !== null && softSession.archived === false) {
      throw new DeleteError('E_SESSION_ALIVE', 'This conversation is visible in the Host again, so it was not purged. Archive it first if you really want it gone.', {
        trashId: entry.trashId,
        sessionId: entry.sessionId,
      })
    }
  }
  await trash.update(entry.trashId, { status: 'purging' })
  const steps = []

  if (entry.mode === 'soft') {
    const session = softSession
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
          const moved = await ops.sessionLog.moveToTrash(session, trash.entryDir(entry.trashId), {
            beforeMove: async (mapping) => {
              await trash.update(entry.trashId, { sessionLog: mapping })
              entry.sessionLog = mapping
            },
          })
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
          await trash.update(entry.trashId, { catalog: snapshot }).catch(() => {})
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
        trashId: entry.trashId,
        // Terminal actions drop the title on purpose (a purged conversation
        // should not live on in the audit trail), but the key stays present so
        // consumers do not have to special-case `delete` versus `purge`.
        title: null,
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
    trashId: entry.trashId,
    title: null,
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
  // A log with no recorded location is normally restorable (the header carries
  // the cwd). When the header is unreadable there is no such path: the log can
  // never go back, so discard is the only way to reclaim the folder — refusing
  // it left the entry stuck in `pending` forever.
  let logUnrecoverable = false
  if (holdsLog === true && (entry.sessionLog === null || entry.sessionLog === undefined) && typeof ops.recoverSessionLog === 'function') {
    logUnrecoverable = (await ops.recoverSessionLog(entry).catch(() => null)) === null
  }
  if (holdsLog === true && !logUnrecoverable) {
    throw new DeleteError('E_TRASH_CONFLICT', 'This incomplete entry still holds the conversation log; restore or purge it instead of discarding it.', {
      trashId: entry.trashId,
      status: entry.status,
    })
  }
  // An unreadable memory folder must count as "holds files": the old `false`
  // default let discard delete the only copy of a bundle it never looked at.
  let holdsMemory = false
  if (typeof ops.hasFiles === 'function') {
    holdsMemory = await ops.hasFiles(join(entryDir, 'memory')).catch(() => true)
  } else {
    holdsMemory = entry.includeMemory === true && (entry.memory?.total ?? 0) > 0
  }
  // The status half of the decision is shared with the UI; the two refusals
  // below stay separate because their advice differs (purge vs restore).
  const capabilities = entryCapabilities(entry, {
    hasLogFiles: holdsLog === true && !logUnrecoverable,
    hasMemoryFiles: holdsMemory,
    payloadRecoverable: logUnrecoverable ? false : null,
  })
  if (holdsMemory || !capabilities.canDiscard) {
    const which = holdsMemory ? 'memory files' : 'payload'
    throw new DeleteError('E_TRASH_CONFLICT', `This incomplete entry still holds ${which}; restore or purge it instead of discarding it.`, {
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
      trashId: entry.trashId,
      status: entry.status,
      title: null,
      actor,
      requestId,
      durationMs: now() - startedAt,
      source,
    })
    .catch(() => {})
  return { trashId: entry.trashId, sessionId: entry.sessionId }
}
