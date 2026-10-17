/**
 * 灵枢 (dsh-memory) adapter preset.
 *
 * The store is the md_cg cognitive graph at `<DSH_HOME>/.dsh-memory/data/mdcg`:
 * `_index.json` (schema 2) maps node ids to records whose `session` field is
 * the owning DSH session id, while node bodies live in `<layer>/<id>.md`.
 * Deleting a conversation therefore has a real, provable join key.
 */
import { join } from 'node:path'
import { createJsonIndexMemoryAdapter } from './json-index-adapter.js'

/**
 * @param {{ rootDir: string, now?: () => number, fsApi?: object }} options
 */
export function createLingshuAdapter({ rootDir, now, fsApi }) {
  return createJsonIndexMemoryAdapter({
    id: 'lingshu',
    label: '灵枢认知图 (md_cg)',
    indexFile: join(rootDir, '_index.json'),
    rootDir,
    sessionField: 'session',
    nodesPointer: '/nodes',
    contentField: 'path',
    // md_cg serializes its own writers with this exact lock file; taking it is
    // the cooperative way to avoid a lost update against the Python process.
    useStoreLock: true,
    validateIndex: (index) => {
      if (index.schema === 2) return null
      return `unsupported md_cg index schema ${String(index.schema)} (expected 2)`
    },
    now,
    fsApi,
  })
}
