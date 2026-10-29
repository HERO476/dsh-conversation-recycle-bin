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
    // Neutral label: the Client localizes by adapter id, so a hard-coded
    // Chinese/English mix here showed up untranslated in the other language.
    label: 'lingshu (md_cg)',
    indexFile: join(rootDir, '_index.json'),
    rootDir,
    sessionField: 'session',
    nodesPointer: '/nodes',
    contentField: 'path',
    // md_cg persists the index as `_index.json` + append-only shards under
    // `_index_log/` and replays the shards on every load. Our tombstones and
    // restored-node records go into a fresh shard so that replay cannot
    // resurrect a deleted node. We deliberately do NOT touch the store's
    // `_index.json.lock`: that is md_cg's permanent OS-lock file, not a
    // presence lock.
    indexLogDir: join(rootDir, '_index_log'),
    validateIndex: (index) => {
      if (index.schema === 2) return null
      return `unsupported md_cg index schema ${String(index.schema)} (expected 2)`
    },
    now,
    fsApi,
  })
}
