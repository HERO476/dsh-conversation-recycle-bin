/**
 * Plugin recycle bin ("trash") manifest store.
 *
 * One directory per deleted conversation under `<DSH_HOME>/delete-conversation/trash/`:
 *
 *   <trashId>/
 *     manifest.json          the entry below (status, catalog snapshot, memory bundle refs)
 *     session/               moved session-log directory (hard mode only)
 *     memory/                moved memory files + per-adapter bundle.json
 *
 * The manifest is the recovery contract: restore reads it, the UI lists it, and
 * the audit trail references its `trashId`. A `pending` entry is written before
 * the transaction starts; only a committed cascade flips it to `trashed`, so a
 * crash mid-delete leaves an inspectable but non-restorable record instead of a
 * session silently missing from every list.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DeleteError } from './errors.js'
import { SESSION_ID_PATTERN } from './ids.js'

const MANIFEST = 'manifest.json'
const TRASH_ID_PATTERN = /^[0-9a-z]{2,40}-[0-9a-z]{2,20}$/
/**
 * Manifest reads in flight during one directory scan. The work is dominated by
 * syscalls on many small files, so a small fixed pool removes the serial
 * round-trip chain without flooding the FS with hundreds of concurrent opens.
 */
const SCAN_CONCURRENCY = 8

/** Ordered `map` with at most `limit` promises in flight. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      out[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return out
}


/** Statuses a manifest may carry. `pending` and `failed` are never listed. */
export const TRASH_STATUS = Object.freeze(['pending', 'trashed', 'failed', 'restoring', 'restored', 'purging'])

/**
 * `sessionId` may be absent (a memory-only entry) but must never be present and
 * malformed: it ends up in a `join(workspaceRoot, sessionId, 'session.jsonl')`.
 */
function isSessionIdField(value) {
  return value === undefined || value === null || (typeof value === 'string' && SESSION_ID_PATTERN.test(value))
}

export function isTrashId(value) {
  return typeof value === 'string' && TRASH_ID_PATTERN.test(value)
}

/**
 * @param {object} options
 * @param {string} options.rootDir absolute trash root
 * @param {() => number} [options.now]
 * @param {() => string} [options.newId] injectable id factory for tests
 * @param {object} [options.fsApi]
 */
export function createTrashStore({ rootDir, now = Date.now, newId, fsApi = { mkdir, readdir, readFile, rename, rm, writeFile } }) {
  const idFactory = newId ?? createIdFactory(now)

  async function ensureRoot() {
    await fsApi.mkdir(rootDir, { recursive: true })
  }

  function entryDir(trashId) {
    if (!isTrashId(trashId)) {
      // A plain Error here escaped as `E_INTERNAL 500` and, worse, was
      // distinguishable from `E_TRASH_NOT_FOUND 404`, which made malformed ids
      // an existence probe. Keep it a typed, user-facing refusal.
      throw new DeleteError('E_BAD_REQUEST', 'The recycle-bin id is malformed.', {})
    }
    return join(rootDir, trashId)
  }

  async function writeManifestFile(dir, entry) {
    const temporary = join(dir, `${MANIFEST}.tmp`)
    await fsApi.writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
    await fsApi.rename(temporary, join(dir, MANIFEST))
  }

  return {
    rootDir,

    async allocate({ sessionId }) {
      await ensureRoot()
      const trashId = idFactory(sessionId)
      const dir = entryDir(trashId)
      await fsApi.mkdir(join(dir, 'memory'), { recursive: true })
      return { trashId, dir }
    },

    entryDir,

    async write(entry) {
      const dir = entryDir(entry.trashId)
      await fsApi.mkdir(dir, { recursive: true })
      await writeManifestFile(dir, entry)
      return entry
    },

    async update(trashId, patch) {
      const entry = await this.read(trashId)
      // A missing entry used to be spread into `{...null}` and written back as a
      // fresh manifest with `trashId: null`: a directory nobody could ever list,
      // restore or discard. Callers treat `null` as "already gone".
      if (entry === null) return null
      const next = { ...entry, ...patch, updatedAt: now() }
      await writeManifestFile(entryDir(trashId), next)
      return next
    },

    async read(trashId) {
      if (!isTrashId(trashId)) return null
      const dir = entryDir(trashId)
      let raw
      try {
        raw = await fsApi.readFile(join(dir, MANIFEST), 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') return null
        throw error
      }
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return null
      }
      if (parsed === null || typeof parsed !== 'object' || parsed.format !== 1) return null
      if (!TRASH_STATUS.includes(parsed.status)) return null
      // `sessionId` is data, not truth: restore joins it into a workspace path,
      // so a hand-edited manifest must not be able to smuggle `..` through the
      // entry at all. A manifest that fails this is unreadable, not listable.
      if (!isSessionIdField(parsed.sessionId)) return null
      return parsed
    },

    /**
     * One directory pass over the recycle bin.
     *
     * `listAll()` and `scanUnreadable()` used to be called together by `/trash`
     * and each did its own `readdir` plus one `readFile` per entry, so every
     * listing cost 2N manifest reads (measured at ~0.31 ms per entry, 156 ms at
     * 500 entries). They now share this single pass: one `readdir`, one read per
     * entry, bounded concurrency instead of a serial `for await`.
     *
     * A missing or unreadable root yields empty lists rather than throwing: the
     * settings page must still render on a fresh install with no trash yet.
     * @returns {Promise<{ entries: object[], unreadable: Array<{ trashId: string, reason: 'missing-manifest'|'corrupt-manifest'|'unreadable-manifest' }> }>}
     */
    async scanAll() {
      await ensureRoot()
      let dirents = []
      try {
        dirents = await fsApi.readdir(rootDir, { withFileTypes: true })
      } catch {
        return { entries: [], unreadable: [] }
      }
      const names = []
      for (const dirent of dirents) {
        if (dirent.isDirectory() && isTrashId(dirent.name)) names.push(dirent.name)
      }
      const scanned = await mapLimit(names, SCAN_CONCURRENCY, async (trashId) => {
        let raw
        try {
          raw = await fsApi.readFile(join(rootDir, trashId, MANIFEST), 'utf8')
        } catch (error) {
          return { trashId, reason: error?.code === 'ENOENT' ? 'missing-manifest' : 'unreadable-manifest' }
        }
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          return { trashId, reason: 'corrupt-manifest' }
        }
        if (parsed === null || typeof parsed !== 'object' || parsed.format !== 1 || !TRASH_STATUS.includes(parsed.status)
          || !isSessionIdField(parsed.sessionId)) {
          return { trashId, reason: 'corrupt-manifest' }
        }
        return { entry: parsed }
      })
      const entries = []
      const unreadable = []
      for (const item of scanned) {
        if (item.entry !== undefined) entries.push(item.entry)
        else unreadable.push({ trashId: item.trashId, reason: item.reason })
      }
      // Newest first. `Array.prototype.sort` is stable, so equal timestamps keep
      // the directory order the scan produced.
      entries.sort((left, right) => (right.deletedAt ?? 0) - (left.deletedAt ?? 0))
      return { entries, unreadable }
    },

    /** Every readable manifest, newest first, regardless of status. */
    async listAll() {
      const { entries } = await this.scanAll()
      return entries
    },

    /** Newest first. Only committed entries are returned. */
    async list() {
      const entries = await this.listAll()
      return entries.filter((entry) => entry.status === 'trashed')
    },

    /**
     * Trash directories whose manifest cannot be read at all: missing
     * (crashed between allocate and write), corrupt, or unparseable. These
     * are invisible to restore/purge but must still be listable and
     * discardable, otherwise a single bad manifest strands the directory on
     * disk forever.
     * @returns {Promise<Array<{ trashId: string, reason: 'missing-manifest'|'corrupt-manifest'|'unreadable-manifest' }>>}
     */
    async scanUnreadable() {
      const { unreadable } = await this.scanAll()
      return unreadable
    },

    async remove(trashId) {
      await fsApi.rm(entryDir(trashId), { recursive: true, force: true })
    },
  }
}

function createIdFactory(now) {
  let counter = 0
  return (sessionId) => {
    counter = (counter + 1) % 1296
    const stamp = now().toString(36)
    const sessionPart = String(sessionId ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toLowerCase() || 'session'
    const salt = `${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
    return `${stamp}-${salt}${sessionPart.slice(0, 4)}`
  }
}
