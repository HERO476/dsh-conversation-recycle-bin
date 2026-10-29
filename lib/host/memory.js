/**
 * Build the memory adapter list from configuration + auto-detection.
 *
 * The 灵枢 md_cg store is detected at `<DSH_HOME>/.dsh-memory/data/mdcg`. If it
 * is absent the adapter still exists and `probe()` reports why, so the dialog
 * can distinguish "store unavailable" from "0 associated entries". A `none`
 * adapter is always appended as the honest fallback.
 */
import { join } from 'node:path'
import { createGenericJsonAdapter } from '../core/memory/generic-json.js'
import { createLingshuAdapter } from '../core/memory/lingshu.js'
import { createNoneAdapter } from '../core/memory/none.js'

/**
 * @param {object} input
 * @param {ReturnType<import('../core/config.js').normalizeConfig>['value']} input.config
 * @param {string} input.dshHome
 * @param {() => number} [input.now]
 */
export function createMemoryAdapters({ config, dshHome, now }) {
  const adapters = []
  const enabled = config.memory.enabled ? config.memory.adapters : ['none']

  if (enabled.includes('lingshu')) {
    const rootDir = config.memory.lingshu.rootDir ?? join(dshHome, '.dsh-memory', 'data', 'mdcg')
    adapters.push(createLingshuAdapter({ rootDir, now }))
  }
  if (enabled.includes('generic-json') && config.memory.generic.indexFile !== null) {
    const adapter = createGenericJsonAdapter({
      indexFile: config.memory.generic.indexFile,
      rootDir: config.memory.generic.rootDir,
      sessionField: config.memory.generic.sessionField,
      nodesPointer: config.memory.generic.nodesPointer,
      now,
    })
    if (adapter !== null) adapters.push(adapter)
  }
  adapters.push(createNoneAdapter())
  return adapters
}
