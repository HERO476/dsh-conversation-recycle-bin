/**
 * dsh-delete-conversation — Host half.
 *
 * The plugin is intentionally thin at the Cordis layer:
 *   - it depends on nothing but `webServer` (the only service needed to reach
 *     the UI); every data service is probed per request so a slimmer profile
 *     degrades to a readable error instead of a failed plugin fiber;
 *   - it performs NO deletion work in `apply`; all authority lives behind the
 *     user-confirmed HTTP plan (see `host/api.js`);
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
 * as `dsh-delete-conversation` (see the module id there).
 */
export const name = 'delete-conversation'

/** The Web server is the only hard dependency; everything else is probed. */
export const inject = ['webServer']

export { PLUGIN_VERSION }

export { ROUTE_PREFIX }

/**
 * Cordis entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig row config from `cordis.patch.yml`
 */
export function apply(ctx, rawConfig) {
  const { value: config, warnings } = normalizeConfig(rawConfig)
  for (const warning of warnings) console.warn(`[delete-conversation] config: ${warning}`)

  const dshHome = resolveDshHome()
  const paths = resolveDataPaths(dshHome)
  const api = createDeleteApi({ ctx, config, paths })

  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: api.handler })
    console.info(
      `[delete-conversation] API registered at ${ROUTE_PREFIX} (dshHome=${dshHome}, `
      + `mode=${config.defaultMode}, memory=${config.memory.enabled ? 'on' : 'off'}, `
      + `trash=${paths.trashDir})`,
    )
    return () => {
      try {
        dispose()
      } catch (error) {
        console.error('[delete-conversation] route dispose failed:', error)
      }
    }
  })
}
