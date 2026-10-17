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
 * atomically, and the store lock is held for the whole read-modify-write. A
 * failure at any point restores the files and the original index before the
 * error leaves this module, so the caller's transaction sees an all-or-nothing
 * memory stage.
 *
 * Limitations are explicit: the adapter understands the documented index
 * shape and reference arrays (`edges`, `depends_on`, `derived_from`) by
 * best-effort inspection. If a store introduces another reference field, its
 * dangling references are preserved (not silently rewritten) and the adapter's
 * `probe()` remains available because the schema itself still matches.
 */
import * as defaultFs from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { resolveJsonPointer } from '../config.js'
import { DeleteError } from '../errors.js'

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

/**
 * @param {object} options
 * @param {string} options.id stable adapter id
 * @param {string} options.label human label (localized by the Client, this one is a fallback)
 * @param {string} options.indexFile absolute path of the JSON index
 * @param {string|null} options.rootDir directory content paths are relative to; null = index-only store
 * @param {string} [options.sessionField]
 * @param {string} [options.nodesPointer]
 * @param {string|null} [options.contentField]
 * @param {boolean} [options.useStoreLock] use `<indexFile>.lock` (the store's own lock) instead of a plugin-private lock
 * @param {(index: any) => string | null} [options.validateIndex] return an error string to mark the store unsupported
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
    useStoreLock = false,
    validateIndex = null,
    now = Date.now,
    lockTimeoutMs = 6_000,
    staleLockMs = 120_000,
    // A zero-byte lock carries no owner pid. If it is older than this, the
    // writer almost certainly died; waiting the full two minutes would make
    // every delete fail while the dialog says there is nothing to export.
    ownerlessLockStaleMs = 5_000,
    fsApi = defaultFs,
  } = options

  const lockFile = useStoreLock ? `${indexFile}.lock` : `${indexFile}.delete-conversation.lock`
  const bundleFileName = 'bundle.json'

  async function readIndex() {
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
    return { index, nodes }
  }

  async function writeIndexAtomic(index) {
    const temporary = `${indexFile}.delete-conversation.tmp`
    await fsApi.writeFile(temporary, `${JSON.stringify(index)}\n`, 'utf8')
    await fsApi.rename(temporary, indexFile)
  }

  /** Acquire the store lock; a stale lock is broken after `staleLockMs`. */
  async function withLock(operation) {
    const started = now()
    let handle = null
    // A zero-byte lock is the crashed-writer signal, and the grace that proves
    // it must fit INSIDE the wait budget. A content-bearing lock keeps the
    // caller's (shorter) timeout, because it is a live writer, not a corpse.
    let waitBudgetMs = lockTimeoutMs
    while (handle === null) {
      try {
        handle = await fsApi.open(lockFile, 'wx')
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        let stale = false
        try {
          const info = await fsApi.stat(lockFile)
          stale = now() - info.mtimeMs > staleLockMs
          if (info.size === 0) {
            waitBudgetMs = Math.max(waitBudgetMs, ownerlessLockStaleMs + 500)
            if (!stale && now() - info.mtimeMs > ownerlessLockStaleMs) stale = true
          }
        } catch {
          stale = false
        }
        if (stale) {
          await fsApi.rm(lockFile, { force: true }).catch(() => {})
          continue
        }
        if (now() - started > waitBudgetMs) {
          throw new DeleteError('E_MEMORY_FAILED', 'The memory store is busy; try again later.', { lockFile })
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
        continue
      }
      // The file now exists. A failed owner write must not leave a lock this
      // process will never release (the exact zero-byte lock that blocked every
      // later delete until it aged out).
      try {
        await handle.writeFile(`${process.pid}\n${now()}\n`, 'utf8')
      } catch (error) {
        try {
          await handle.close()
        } catch {
          // already broken; the lock file is removed below either way
        }
        await fsApi.rm(lockFile, { force: true }).catch(() => {})
        throw error
      }
    }
    try {
      return await operation()
    } finally {
      try {
        await handle?.close()
      } catch {
        // closing a lock handle must never mask the operation outcome
      }
      await fsApi.rm(lockFile, { force: true }).catch(() => {})
    }
  }

  return {
    id,
    label,
    indexFile,
    rootDir,

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
      for (const id of wanted) counts.set(id, 0)
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

      // Fast path: a conversation with nothing to move must not depend on the
      // store lock. A stale lock left by a crashed writer (or a long write)
      // used to make "delete this conversation" fail with "memory store is
      // busy" even though the dialog showed zero linked memories.
      const before = await readIndex()
      const hasLinked = Object.values(before.nodes).some(
        (node) => node !== null && typeof node === 'object' && node[sessionField] === sessionId && !isProtected(node),
      )
      if (!hasLinked) return emptyBundle()

      return withLock(async () => {
        const { index, nodes } = await readIndex()
        // Snapshot before ANY mutation: compensation must be able to put the
        // original index back byte-for-byte in meaning (key order preserved).
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
          // index that still lists its nodes, which is inspectable. The reverse
          // order could drop entries whose only copy was the rewritten index.
          await fsApi.writeFile(bundleFile, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')
          await writeIndexAtomic(index)
          indexWritten = true
          return bundle
        } catch (error) {
          // Compensate inside the memory stage: the caller must see either a
          // fully moved session or an untouched store.
          if (indexWritten) {
            await writeIndexAtomic(pristine).catch(() => {})
          }
          for (const moved of movedFiles.reverse()) {
            await fsApi.mkdir(dirname(moved.from), { recursive: true }).catch(() => {})
            await fsApi.rename(moved.to, moved.from).catch(() => {})
          }
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
        const { index, nodes } = await readIndex()
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
        } catch (error) {
          for (const moved of movedBack.reverse()) {
            await fsApi.rename(moved.from, moved.to).catch(() => {})
          }
          throw error
        }
      })
    },
  }
}
