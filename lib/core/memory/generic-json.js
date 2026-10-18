/**
 * Configurable adapter for any local memory store whose JSON index maps node
 * ids to records carrying a session field (see `json-index-adapter.js` for the
 * contract). Operators point it at their store with:
 *
 *   memory.generic.indexFile  absolute path of the index JSON
 *   memory.generic.rootDir    directory content paths are relative to (or null)
 *   memory.generic.sessionField
 *   memory.generic.nodesPointer
 */
import { createJsonIndexMemoryAdapter } from './json-index-adapter.js'

/**
 * @param {{ indexFile: string|null, rootDir: string|null, sessionField?: string, nodesPointer?: string, now?: () => number, fsApi?: object }} options
 */
export function createGenericJsonAdapter({ indexFile, rootDir, sessionField = 'session', nodesPointer = '/nodes', now, fsApi }) {
  if (typeof indexFile !== 'string' || indexFile === '') return null
  return createJsonIndexMemoryAdapter({
    id: 'generic-json',
    // Neutral label: the Client localizes by adapter id.
    label: 'generic-json',
    indexFile,
    rootDir: typeof rootDir === 'string' && rootDir !== '' ? rootDir : null,
    sessionField,
    nodesPointer,
    contentField: rootDir === null ? null : 'path',
    now,
    fsApi,
  })
}
