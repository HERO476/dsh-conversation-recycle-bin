/**
 * Shared adapter for key-value memory stores shaped as
 *
 *   { schema, nodes: { "<nodeId>": { <sessionField>: "<sessionId>", <contentField>: "rel/file", protected?: true, ... } } }
 *
 * The 灵枢 md_cg store (`.dsh-memory/data/mdcg/_index.json`) is exactly this
 * shape, and the `generic-json` adapter reuses the same machinery for other
 * local stores through configuration.
 *
 * Deletion is a MOVE, never an unlink: node content files and full index
 * entries are copied into the recycle-bin bundle, the live index is rewritten
 * atomically, and a plugin-private lock is held for the whole
 * read-modify-write.
 *
 * ## Why the lock is plugin-private
 *
 * The store's own `<index>.lock` belongs to md_cg and is a permanent zero-byte
 * file guarded by an OS byte-range lock (`msvcrt.locking` on Windows, `flock`
 * on POSIX). Its existence is NOT a lock, and removing it silently breaks the
 * store's own mutual exclusion. This adapter therefore never opens, writes or
 * deletes that file; it uses `<index>.conversation-recycle-bin.lock`, which
 * only coordinates this plugin's Host processes. The store lock is left to
 * md_cg.
 *
 * ## Index generations
 *
 * md_cg persists an index as a snapshot (`_index.json`) plus append-only
 * shards under `_index_log/`, replaying the shards over the snapshot on every
 * load. When `indexLogDir` is configured (the 灵枢 preset), this adapter
 * appends its own records to a fresh shard: tombstones (`e: null`) for removed
 * nodes and the updated records of peers whose references were stripped. That
 * keeps a later snapshot+log replay from resurrecting a deleted node. The
 * adapter still writes the snapshot itself so its own reads (counts, preview)
 * are immediately correct.
 *
 * Limitations are explicit: a md_cg process that already holds the node in its
 * unflushed `_dirty` set can still re-expose it until that process reloads; and
 * a node updated by another writer after our tombstone wins. Callers must treat
 * this as a best-effort offline adapter, not as md_cg's own `forget` protocol.
 */
import * as defaultFs from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { resolveJsonPointer } from '../config.js'
import { DeleteError } from '../errors.js'
import { createFileLock } from '../file-lock.js'

const REFERENCE_FIELDS = ['edges', 'depends_on', 'derived_from']
const REFERENCE_KEYS = ['id', 'target', 'to', 'nodeId', 'node', 'targetId', 'target_id', 'ref']

function isProtected(node) {
  return node !== null && typeof node === 'object' && (node.protected === true || node.immutable === true)
}

function referenceIdOf(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  if (value !== null && typeof value === 'object') {
    for (const key of REFERENCE_KEYS) {
      if (typeof value[key] === 'string') return value[key]
    }
  }
  return null
}

function missing(entry, ids) {
  const ref = referenceIdOf(entry)
  return ref !== null && ids.has(ref)
}

function validateRelativeContentPath(rootDir, relative) {
  if (typeof relative !== 'string' || relative === '' || isAbsolute(relative)) return null
  const base = resolve(rootDir)
  const target = resolve(base, relative)
  if (target !== base && !target.startsWith(`${base}${sep}`)) return null
  return target
}

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {object} options
 * @param {string} options.id stable adapter id
 * @param {string} options.label human label (localized by the Client, this one is a fallback)
 * @param {string} options.indexFile absolute path of the JSON index
 * @param {string|null} options.rootDir directory content paths are relative to; null = index-only store
 * @param {string} [options.sessionField]
 * @param {string} [options.nodesPointer]
 * @param {string|null} [options.contentField]
 * @param {string|null} [options.indexLogDir] md_cg `_index_log` directory; null = no shard records
 * @param {(index: any) => string | null} [options.validateIndex] return an error string to mark the store unsupported
 * @param {number} [options.lockTimeoutMs]
 * @param {number} [options.staleLockMs]
 * @param {number} [options.lockHeartbeatMs]
 * @param {() => number} [options.now]
 * @param {object} [options.fsApi]
 */
export function createJsonIndexMemoryAdapter(options) {
  const {
    id,
    label,
    indexFile,
    rootDir,
    sessionField = 'session',
    nodesPointer = '/nodes',
    contentField = 'path',
    indexLogDir = null,
    validateIndex = null,
    lockTimeoutMs = 15_000,
    staleLockMs = 120_000,
    lockHeartbeatMs = 5_000,
    now = Date.now,
    sleep = sleepDefault,
    fsApi = defaultFs,
  } = options

  // Deliberately NOT `<indexFile>.lock`: that file belongs to md_cg.
  const lockPath = `${indexFile}.conversation-recycle-bin.lock`
  const bundleFileName = 'bundle.json'
  const lock = createFileLock({
    lockPath,
    timeoutMs: lockTimeoutMs,
    staleMs: staleLockMs,
    heartbeatMs: lockHeartbeatMs,
    now,
    sleep,
    fsApi,
  })

  function withLock(operation) {
    return lock.acquire().then(async (release) => {
      try {
        return await operation()
      } finally {
        await release()
      }
    })
  }

  /**
   * Last parsed snapshot, keyed by the file's identity (mtime + size).
   *
   * A single `/preview` probes the adapter and then counts nodes, and both used
   * to `readFile` + `JSON.parse` the whole index: 2 full reads of a 1.9 MB
   * index cost ~39 ms. The stat key catches a concurrent md_cg write without a
   * TTL, and every write this adapter performs clears the entry.
   */
  let snapshotCache = null

  async function readSnapshot() {
    let key = null
    if (typeof fsApi.stat === 'function') {
      try {
        const info = await fsApi.stat(indexFile)
        key = `${info.mtimeMs}:${info.size}`
      } catch {
        // Fall through: readFile below reports the real error (ENOENT etc.).
      }
    }
    if (key !== null && snapshotCache !== null && snapshotCache.key === key) return snapshotCache.snapshot
    const raw = await fsApi.readFile(indexFile, 'utf8')
    let index
    try {
      index = JSON.parse(raw)
    } catch (error) {
      throw new DeleteError('E_MEMORY_FAILED', `Memory index is not valid JSON: ${indexFile}`, { indexFile }, { cause: error })
    }
    if (index === null || typeof index !== 'object') {
      throw new DeleteError('E_MEMORY_FAILED', `Memory index has an unexpected shape: ${indexFile}`, { indexFile })
    }
    if (typeof validateIndex === 'function') {
      const reason = validateIndex(index)
      if (reason !== null) {
        throw new DeleteError('E_MEMORY_FAILED', `Memory store is not supported: ${reason}`, { indexFile, reason })
      }
    }
    const nodes = resolveJsonPointer(index, nodesPointer)
    if (nodes === null || typeof nodes !== 'object') {
      throw new DeleteError('E_MEMORY_FAILED', `Memory index has no node map at ${nodesPointer}`, { indexFile, nodesPointer })
    }
    const snapshot = { index, nodes, sig: createHash('sha256').update(raw).digest('hex') }
    if (key !== null) snapshotCache = { key, snapshot }
    return snapshot
  }

  async function readIndex() {
    const snapshot = await readSnapshot()
    return { index: snapshot.index, nodes: snapshot.nodes }
  }

  async function writeIndexAtomic(index) {
    const temporary = `${indexFile}.delete-conversation.tmp`
    await fsApi.writeFile(temporary, `${JSON.stringify(index)}\n`, 'utf8')
    await fsApi.rename(temporary, indexFile)
    // The next reader must not see the pre-write snapshot, even if the rename
    // happened within the filesystem's mtime granularity.
    snapshotCache = null
  }

  async function newestLogMtimeMs() {
    if (indexLogDir === null) return 0
    let entries
    try {
      entries = await fsApi.readdir(indexLogDir, { withFileTypes: true })
    } catch {
      return 0
    }
    let newest = 0
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.log')) continue
      try {
        const info = await fsApi.stat(join(indexLogDir, entry.name))
        if (info.mtimeMs > newest) newest = info.mtimeMs
      } catch {
        // A shard cleared by a concurrent compact is simply absent.
      }
    }
    return newest
  }

  /**
   * Append records to a fresh md_cg shard.
   *
   * The shard format is the one `md_cg.fsutil.ShardedLog` writes:
   * `{ id, e, _t, _s }` per line. `e: null` is a tombstone; a dict is an
   * upsert. A fresh shard avoids sharing a write point with md_cg, and `_t`
   * starts after the newest existing shard so the records replay last.
   *
   * @param {Array<{ id: string, e: object | null }>} records
   * @returns {Promise<string|null>} shard path, or null when disabled/empty
   */
  async function appendIndexLog(records) {
    if (indexLogDir === null || records.length === 0) return null
    await fsApi.mkdir(indexLogDir, { recursive: true })
    const newest = await newestLogMtimeMs()
    const base = Math.max(now() / 1000, newest / 1000 + 0.001)
    const shardPath = join(indexLogDir, `${process.pid}-${randomBytes(4).toString('hex')}.log`)
    const lines = records.map((record, index) => JSON.stringify({
      id: record.id,
      e: record.e,
      _t: base + index / 1_000_000,
      _s: index + 1,
    }))
    try {
      await fsApi.writeFile(shardPath, `${lines.join('\n')}\n`, 'utf8')
      return shardPath
    } catch (error) {
      await fsApi.rm(shardPath, { force: true }).catch(() => {})
      throw error
    }
  }

  async function removeQuietly(target) {
    if (target === null || target === undefined) return
    await fsApi.rm(target, { recursive: true, force: true }).catch(() => {})
  }

  return {
    id,
    label,
    indexFile,
    rootDir,
    lockPath,

    async probe() {
      try {
        await readIndex()
        return { available: true, reason: null, storePath: indexFile }
      } catch (error) {
        return {
          available: false,
          reason: error instanceof Error ? error.message : String(error),
          storePath: indexFile,
        }
      }
    },

    /**
     * Count deletable nodes per session id.
     * Protected nodes are reported separately and never deleted.
     * @param {Iterable<string>} sessionIds
     */
    async countSessions(sessionIds) {
      const { nodes } = await readIndex()
      const wanted = new Set(sessionIds)
      const counts = new Map()
      for (const wantedId of wanted) counts.set(wantedId, 0)
      let protectedCount = 0
      for (const node of Object.values(nodes)) {
        if (node === null || typeof node !== 'object') continue
        const sessionId = node[sessionField]
        if (!wanted.has(sessionId)) continue
        if (isProtected(node)) {
          protectedCount += 1
          continue
        }
        counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1)
      }
      return { counts, protected: protectedCount }
    },

    /**
     * Move one session's nodes into `targetDir/memory/<id>/` and return the
     * restore bundle that `restoreBundle` consumes.
     */
    async exportSession(sessionId, targetDir) {
      const emptyBundle = () => ({
        format: 1,
        adapter: id,
        indexFile,
        rootDir: rootDir ?? null,
        sessionId,
        createdAt: now(),
        count: 0,
        entries: [],
        links: [],
      })

      // Fast path: a conversation with nothing to move must not take the lock.
      const before = await readSnapshot()
      const hasLinked = Object.values(before.nodes).some(
        (node) => node !== null && typeof node === 'object' && node[sessionField] === sessionId && !isProtected(node),
      )
      if (!hasLinked) return emptyBundle()

      return withLock(async () => {
        const current = await readSnapshot()
        // Another writer changed the snapshot while we waited for the lock.
        // Recomputing against `current` would silently miss a node added after
        // `before`; refusing is the only safe answer.
        if (current.sig !== before.sig) {
          throw new DeleteError('E_MEMORY_FAILED', 'The memory index changed while waiting; retry the deletion.', {
            indexFile,
            retryable: true,
          })
        }
        const { index, nodes } = current
        // Snapshot before ANY mutation: compensation must put the original
        // index back byte-for-byte in meaning (key order preserved).
        const pristine = structuredClone(index)
        const bundleDir = join(targetDir, 'memory', id)
        const filesDir = join(bundleDir, 'files')
        const ids = new Set()
        for (const [nodeId, node] of Object.entries(nodes)) {
          if (node !== null && typeof node === 'object' && node[sessionField] === sessionId && !isProtected(node)) ids.add(nodeId)
        }

        /** @type {{ format: number, adapter: string, indexFile: string, rootDir: string|null, sessionId: string, createdAt: number, count: number, entries: any[], links: any[] }} */
        const bundle = emptyBundle()
        bundle.count = ids.size
        if (ids.size === 0) return bundle

        const movedFiles = []
        let indexWritten = false
        let logShard = null
        try {
          await fsApi.mkdir(filesDir, { recursive: true })
          for (const nodeId of ids) {
            const node = nodes[nodeId]
            const entry = { nodeId, originalPath: null, storedFile: null, node }
            const relative = contentField === null ? null : node[contentField]
            if (rootDir !== null && typeof relative === 'string') {
              const source = validateRelativeContentPath(rootDir, relative)
              if (source !== null) {
                const storedName = `${nodeId}.content`
                try {
                  await fsApi.rename(source, join(filesDir, storedName))
                  movedFiles.push({ from: source, to: join(filesDir, storedName) })
                  entry.originalPath = relative
                  entry.storedFile = storedName
                } catch (error) {
                  if (error?.code !== 'ENOENT') throw error
                  // A missing content file is recorded, not fatal: the index
                  // entry is still restorable, and losing the index entry while
                  // the file is gone changes nothing for the user.
                }
              }
            }
            bundle.entries.push(entry)
          }

          // Orphan cleanup: remove references to the deleted nodes from the
          // nodes that stay, and record exactly what was removed so a restore
          // can put the links back.
          for (const [nodeId, node] of Object.entries(nodes)) {
            if (ids.has(nodeId) || node === null || typeof node !== 'object') continue
            for (const field of REFERENCE_FIELDS) {
              const value = node[field]
              if (!Array.isArray(value)) continue
              const kept = value.filter((item) => !missing(item, ids))
              if (kept.length !== value.length) {
                bundle.links.push({ nodeId, field, items: value.filter((item) => missing(item, ids)), restoredAtEnd: true })
                node[field] = kept
              }
            }
          }

          for (const nodeId of ids) delete nodes[nodeId]
          const bundleFile = join(bundleDir, bundleFileName)
          bundle.bundlePath = bundleFile
          // Persist the restore bundle BEFORE removing the entries from the
          // live index: a crash in between leaves a recoverable bundle plus an
          // index that still lists its nodes, which is inspectable.
          await fsApi.writeFile(bundleFile, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')
          await writeIndexAtomic(index)
          indexWritten = true

          // Snapshot taken. Now make the deletion survive a md_cg
          // snapshot+log replay: tombstones for the removed nodes and the
          // updated records of the peers whose references we stripped.
          const records = [...ids].map((nodeId) => ({ id: nodeId, e: null }))
          const seenPeers = new Set()
          for (const link of bundle.links) {
            if (seenPeers.has(link.nodeId) || nodes[link.nodeId] === undefined) continue
            seenPeers.add(link.nodeId)
            records.push({ id: link.nodeId, e: nodes[link.nodeId] })
          }
          logShard = await appendIndexLog(records)
          return bundle
        } catch (error) {
          // Compensation inside the memory stage: the caller must see either a
          // fully moved session or an untouched store.
          await removeQuietly(logShard)
          if (indexWritten) {
            await writeIndexAtomic(pristine).catch(() => {})
          }
          for (const moved of movedFiles.reverse()) {
            await fsApi.mkdir(dirname(moved.from), { recursive: true }).catch(() => {})
            await fsApi.rename(moved.to, moved.from).catch(() => {})
          }
          // A bundle written before the failure is not referenced by any
          // manifest; leaving it behind made the failed entry impossible to
          // discard (the discard guard sees files the manifest does not know).
          await removeQuietly(bundleDir)
          throw error instanceof DeleteError
            ? error
            : new DeleteError('E_MEMORY_FAILED', 'Failed to move memory entries to the recycle bin.', {
                adapter: id,
                sessionId,
                cause: error instanceof Error ? error.message : String(error),
              }, { cause: error })
        }
      })
    },

    /** Restore a bundle produced by `exportSession`. Idempotence is NOT promised. */
    async restoreBundle(bundle) {
      if (bundle === null || typeof bundle !== 'object' || !Array.isArray(bundle.entries) || bundle.entries.length === 0) return
      await withLock(async () => {
        const current = await readSnapshot()
        const { index, nodes } = current
        const pristine = structuredClone(index)
        const alreadyRestored = new Set()
        for (const entry of bundle.entries) {
          const destination = entry.storedFile !== null && entry.originalPath !== null && rootDir !== null
            ? validateRelativeContentPath(rootDir, entry.originalPath)
            : null
          if (nodes[entry.nodeId] !== undefined) {
            // A previous restore attempt may have partially succeeded. Treat an
            // entry whose node and content are both already back as restored,
            // so retrying the trash restore converges instead of dead-locking
            // on its own leftovers.
            let contentBack = destination === null
            if (destination !== null) {
              try {
                await fsApi.stat(destination)
                contentBack = true
              } catch {
                contentBack = false
              }
            }
            if (contentBack) {
              alreadyRestored.add(entry.nodeId)
              continue
            }
            throw new DeleteError('E_TRASH_CONFLICT', 'A memory entry with the same id already exists; restore aborted.', {
              adapter: id,
              nodeId: entry.nodeId,
            })
          }
        }
        const movedBack = []
        let indexWritten = false
        let logShard = null
        try {
          for (const entry of bundle.entries) {
            if (alreadyRestored.has(entry.nodeId)) continue
            if (entry.storedFile !== null && entry.originalPath !== null && rootDir !== null) {
              const destination = validateRelativeContentPath(rootDir, entry.originalPath)
              if (destination === null) throw new DeleteError('E_TRASH_CONFLICT', 'Memory content path is invalid; restore aborted.', { nodeId: entry.nodeId })
              const stored = join(bundle.bundlePath ? dirname(bundle.bundlePath) : '', 'files', entry.storedFile)
              await fsApi.mkdir(dirname(destination), { recursive: true })
              await fsApi.rename(stored, destination)
              movedBack.push({ from: destination, to: stored })
            }
          }
          for (const entry of bundle.entries) {
            if (alreadyRestored.has(entry.nodeId)) continue
            nodes[entry.nodeId] = entry.node
          }
          for (const link of bundle.links ?? []) {
            const node = nodes[link.nodeId]
            if (node === null || typeof node !== 'object' || !Array.isArray(node[link.field])) continue
            const present = new Set(node[link.field].map(referenceIdOf))
            for (const item of link.items) {
              const ref = referenceIdOf(item)
              if (ref === null || !present.has(ref)) {
                node[link.field].push(item)
                if (ref !== null) present.add(ref)
              }
            }
          }
          await writeIndexAtomic(index)
          indexWritten = true

          // Mirror the restored records into md_cg's shard log so a later
          // snapshot+log replay keeps them (a stale tombstone would otherwise
          // win). Peers whose links came back are re-recorded too.
          const records = []
          for (const entry of bundle.entries) {
            if (alreadyRestored.has(entry.nodeId)) continue
            records.push({ id: entry.nodeId, e: entry.node })
          }
          const seenPeers = new Set()
          for (const link of bundle.links ?? []) {
            if (seenPeers.has(link.nodeId) || nodes[link.nodeId] === undefined) continue
            seenPeers.add(link.nodeId)
            records.push({ id: link.nodeId, e: nodes[link.nodeId] })
          }
          logShard = await appendIndexLog(records)
        } catch (error) {
          await removeQuietly(logShard)
          if (indexWritten) {
            await writeIndexAtomic(pristine).catch(() => {})
          }
          for (const moved of movedBack.reverse()) {
            await fsApi.rename(moved.from, moved.to).catch(() => {})
          }
          throw error
        }
      })
    },
  }
}
