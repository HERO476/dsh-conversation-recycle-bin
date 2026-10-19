/**
 * Live-session lifecycle stage for hard deletion and recycle-bin purges.
 *
 * A DSH session can stay mounted in the Host after its last turn: the Agent
 * object remains live and its session-log writer can still append. Moving that
 * log is only safe after the agent has been stopped:
 *
 *   1. cancel an in-flight turn (`sessionController.cancel`),
 *   2. archive the session with `stopActivity` so no wake can start a new turn,
 *   3. wait a bounded time (`liveDrainMs`) for the running flag to clear.
 *
 * Sessions that are live but idle pass through immediately. If a session is
 * still running after the drain window, the stage fails and the cascade rolls
 * back; the plugin never trades data integrity for convenience. The undo only
 * re-applies state this stage changed (unarchive a session it archived itself),
 * because cancelling a turn cannot be undone.
 */
import { DeleteError } from '../core/errors.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createLifecycleOps({ ctx, gateway, config, now = Date.now, delay = sleep }) {
  function service(name) {
    let value
    try {
      value = ctx.get?.(name) ?? ctx[name]
    } catch {
      value = undefined
    }
    if (value === undefined) {
      throw new DeleteError('E_INTERNAL', `The ${name} service is unavailable.`, {})
    }
    return value
  }

  async function inspectRunning(sessionId) {
    // Cheap path: read the in-memory live table without invalidating and
    // rebuilding the whole session list on every poll. Only fall back to a
    // full inspect when the probe cannot answer (absent service, unknown shape).
    const raw = typeof gateway.isRunning === 'function' ? gateway.isRunning(sessionId) : undefined
    const probe = raw instanceof Promise ? await raw : raw
    if (probe !== undefined) return probe === true
    gateway.invalidate()
    const current = await gateway.inspect(sessionId)
    return current !== null && current.running === true
  }

  return {
    /**
     * Stop a live session and wait for its turn to settle.
     *
     * @param {object} session normalized session snapshot (`live: true`)
     * @returns {Promise<() => Promise<void>>} undo: unarchive only when this
     *   stage performed the archive itself.
     */
    async quiesce(session) {
      const registry = service('workspaceRegistry')
      const controller = ctx.get?.('sessionController') ?? ctx.sessionController
      const wasArchived = session.archived === true
      const drainMs = Math.max(0, Number(config.liveDrainMs) || 0)

      if (session.running === true && controller !== undefined && typeof controller.cancel === 'function') {
        try {
          await controller.cancel({ sessionId: session.id })
        } catch {
          // Cancellation is best-effort; the archive gate below still prevents
          // new turns, and the drain check fails loudly if the turn keeps going.
        }
      }

      // An archived session is already gated, and its original archive call is
      // what installed the stop barrier. Only a live, unarchived session needs
      // this stage's own archive (and its undo).
      if (!wasArchived) {
        await registry.archiveSession(session.id, { stopActivity: true })
      }

      // Registered BEFORE the drain check: if the turn never settles the
      // transaction rolls back, and the archive this stage performed must roll
      // back with it. Throwing before the undo existed left an aborted deletion
      // with a silently archived (stopped, list-hidden) conversation.
      const undo = async () => {
        if (!wasArchived) await registry.unarchiveSession(session.id)
      }

      const deadline = now() + drainMs
      try {
        while (await inspectRunning(session.id)) {
          if (now() >= deadline) {
            throw new DeleteError(
              'E_POLICY_LIVE',
              'The conversation is still running after it was asked to stop. Close it and retry.',
              { sessionId: session.id, waitedMs: drainMs },
            )
          }
          await delay(Math.min(100, Math.max(0, deadline - now())))
        }
      } catch (error) {
        await undo().catch(() => {})
        throw error
      }

      return undo
    },
  }
}
