/**
 * dsh-conversation-recycle-bin — Host half.
 *
 * The plugin is intentionally thin at the Cordis layer:
 *   - it depends on nothing but `webServer` (the only service needed to reach
 *     the UI); every data service is probed per request so a slimmer profile
 *     degrades to a readable error instead of a failed plugin fiber;
 *   - `apply` itself deletes nothing. The only autonomous work it schedules is
 *     the recycle-bin retention sweep (`trashRetentionDays`, default 30 days),
 *     which is the documented promise of that setting and is switched off with
 *     `trashRetentionDays: 0`. Everything else lives behind the user-confirmed
 *     HTTP plan (see `host/api.js`);
 *   - it registers no agent tool: deleting conversations is a user-only
 *     authority and the model must not be able to execute or authorize it.
 *
 * Installation and rollback are documented in INSTALL.md.
 */
import { normalizeConfig } from './core/config.js'
import { createDeleteApi, ROUTE_PREFIX } from './host/api.js'
import { resolveDataPaths, resolveDshHome } from './host/paths.js'
import { PLUGIN_VERSION } from './version.js'

/**
 * Host-side row id: matches the `id` of the bundle patch row in
 * `cordis.patch.yml`. The Client bundle is addressed differently — the boot
 * graph keys client rows by `package.json#name`, so `client.js` must register
 * as `dsh-conversation-recycle-bin` (see the module id there).
 */
export const name = 'conversation-recycle-bin'

/** The Web server is the only hard dependency; everything else is probed. */
export const inject = ['webServer']

export { PLUGIN_VERSION }

export { ROUTE_PREFIX }

/**
 * Retention cadence. The first sweep waits a minute so a Host start does not
 * compete with boot; afterwards six hours is frequent enough for a
 * day-granularity window and cheap enough to ignore.
 */
const RETENTION_FIRST_SWEEP_MS = 60_000
const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Cordis entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig row config from `cordis.patch.yml`
 */
export function apply(ctx, rawConfig) {
  const { value: config, warnings } = normalizeConfig(rawConfig)
  for (const warning of warnings) console.warn(`[conversation-recycle-bin] config: ${warning}`)

  const dshHome = resolveDshHome()
  const paths = resolveDataPaths(dshHome)
  const api = createDeleteApi({ ctx, config, paths })
  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: api.handler })
    console.info(
      `[conversation-recycle-bin] API registered at ${ROUTE_PREFIX} (dshHome=${dshHome}, `
      + `mode=${config.defaultMode}, memory=${config.memory.enabled ? 'on' : 'off'}, `
      + `trash=${paths.trashDir})`,
    )
    return () => {
      try {
        dispose()
      } catch (error) {
        console.error('[conversation-recycle-bin] route dispose failed:', error)
      }
    }
  })

  // Recycle-bin retention. The sweep is idempotent and takes the same mutation
  // lock as a user action, so a Host that restarts mid-sweep simply resumes on
  // the next tick. Both timers are unref'd: a Host that is otherwise done must
  // still be able to exit.
  ctx.effect(() => {
    const sweep = () => {
      void api.sweepExpiredTrash().catch((error) => {
        console.warn('[conversation-recycle-bin] retention sweep failed:', error)
      })
    }
    const first = setTimeout(sweep, RETENTION_FIRST_SWEEP_MS)
    const timer = setInterval(sweep, RETENTION_SWEEP_INTERVAL_MS)
    first.unref?.()
    timer.unref?.()
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  })
}
