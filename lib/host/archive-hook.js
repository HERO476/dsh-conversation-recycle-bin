/**
 * Host-side bridge between DSH's archive lifecycle and the plugin.
 *
 * The Host publishes two Cordis events from `workspaceRegistry`:
 *
 *   workspace/session-archived     AFTER the durable write, payload `{ sessionId }`
 *   workspace/session-unarchiving  BEFORE the removal, awaited (a cancel hook)
 *
 * `@deepseek-ai/dsh-experimental-worktree` already uses exactly this pair —
 * archive schedules a cleanup attempt, unarchiving cancels it — so this is the
 * documented shape rather than a guess.
 *
 * ## The one rule that makes or breaks this module
 *
 * `archiveSession()` runs its whole body, INCLUDING `await ctx.parallel(
 * "workspace/session-archived")`, inside `enqueueOperation()`. Every listener is
 * awaited before that operation can finish, and any further registry write from
 * a listener is queued BEHIND that same operation. So a listener that awaits a
 * registry write — which `await performSessionDelete()` does, because the soft
 * path archives — makes the queue wait for itself. The Host's sidebar, archive
 * and pin actions then stop responding for good.
 *
 * Therefore: handlers here are SYNCHRONOUS and never await anything. They
 * schedule (see `autoTrashOnArchive`) and return. Nothing in this module may
 * touch the filesystem, the trash store or a Host service.
 *
 * The mirror-image rule applies to the cancel hook: a rejection from a
 * `session-unarchiving` listener RETAINS the archived state on current Hosts, so
 * a handler that throws would make a conversation impossible to unarchive.
 * Every handler is wrapped and swallows.
 */

/** Event names, exported so `scripts/verify-host-api.mjs` asserts the same pair. */
export const ARCHIVED_EVENT = 'workspace/session-archived'
export const UNARCHIVING_EVENT = 'workspace/session-unarchiving'

/**
 * @param {object} input
 * @param {import('@deepseek-ai/cordis').Context} input.ctx
 * @param {(sessionId: string) => void} input.onArchived MUST return synchronously
 * @param {(sessionId: string) => void} input.onUnarchiving MUST NOT throw
 * @param {Pick<Console, 'warn'|'error'>} [input.logger]
 * @returns {{ available: boolean, reason: string, dispose: () => void, handlers: object }}
 */
export function registerArchiveHook({ ctx, onArchived, onUnarchiving, logger = console }) {
  // A slim composition may expose no event bus at all. That is not an error:
  // the plugin degrades to "archive does nothing", and `/state` reports why.
  if (typeof ctx?.on !== 'function') {
    return {
      available: false,
      reason: 'no-event-bus',
      dispose: () => {},
      handlers: { archived: () => {}, unarchiving: () => {} },
    }
  }

  /**
   * Wrap one handler so a throw can never reach the Host.
   *
   * `payload` is Host data, so it is validated, not trusted: a missing or
   * malformed `sessionId` must not reach the trash layer (which would reject it
   * with a typed error nobody asked for, on the archive path).
   */
  const guard = (label, handler) => (payload) => {
    try {
      const sessionId = payload?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') return
      const result = handler(sessionId)
      // A promise here means somebody made the handler async. That is the
      // deadlock described above, so it is reported instead of silently
      // awaited: the work still runs, but the mistake is loud in the log.
      if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        logger.warn?.(`[conversation-recycle-bin] ${label} handler returned a promise; archive listeners MUST be synchronous`)
        void result.catch((error) => logger.warn?.(`[conversation-recycle-bin] ${label} handler rejected: ${error?.message ?? error}`))
      }
    } catch (error) {
      logger.warn?.(`[conversation-recycle-bin] ${label} handler failed: ${error?.message ?? error}`)
    }
  }

  const handlers = {
    archived: guard(ARCHIVED_EVENT, onArchived),
    unarchiving: guard(UNARCHIVING_EVENT, onUnarchiving),
  }

  let offArchived
  let offUnarchiving
  const detach = () => {
    for (const off of [offArchived, offUnarchiving]) {
      if (typeof off !== 'function') continue
      try {
        off()
      } catch (error) {
        logger.warn?.(`[conversation-recycle-bin] archive hook dispose failed: ${error?.message ?? error}`)
      }
    }
    offArchived = undefined
    offUnarchiving = undefined
  }

  try {
    // `ctx.on` returns a disposer on every Cordis version this plugin supports;
    // older shapes return undefined, in which case the enclosing `ctx.effect`
    // still tears the fiber down and the listeners go with it.
    offArchived = ctx.on(ARCHIVED_EVENT, handlers.archived)
    offUnarchiving = ctx.on(UNARCHIVING_EVENT, handlers.unarchiving)
  } catch (error) {
    logger.warn?.(`[conversation-recycle-bin] could not subscribe to archive events: ${error?.message ?? error}`)
    detach()
    return { available: false, reason: 'subscribe-failed', dispose: () => {}, handlers }
  }

  return { available: true, reason: 'subscribed', dispose: detach, handlers }
}
