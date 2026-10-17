/**
 * Filesystem locations this plugin needs.
 *
 * DSH home precedence mirrors `@deepseek-ai/dsh-home-paths`: an explicit
 * `$DSH_HOME`, then `~/.dsh`. A blank override counts as unset and must never
 * resolve to the current working directory (the historical bug that made a
 * plugin's data "disappear" when the Host was started from another directory).
 *
 * Session directories are discovered by scanning `<DSH_HOME>/sessions/<slug>/`
 * instead of re-implementing the slug encoding: the slug is a Host implementation
 * detail, while the session id directory name is part of the durable identity.
 */
import { cp, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function resolveDshHome(env = process.env, home = homedir()) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return configured !== '' ? configured : join(home, '.dsh')
}

/**
 * @param {string} dshHome
 * @param {{ pluginId?: string }} [options]
 */
export function resolveDataPaths(dshHome, { pluginId = 'delete-conversation' } = {}) {
  const dataDir = join(dshHome, pluginId)
  return {
    dshHome,
    dataDir,
    trashDir: join(dataDir, 'trash'),
    auditFile: join(dataDir, 'audit.jsonl'),
    sessionsRoot: join(dshHome, 'sessions'),
    storagesDir: join(dshHome, 'storages'),
    workspaceFile: join(dshHome, 'storages', 'workspace.json'),
    projectionCacheFile: join(dshHome, 'storages', 'session_projcache.json'),
  }
}

/**
 * Inverse of the Host's `encodeSegment`: unsafe UTF-16 units become `~XXXX`.
 * Session ids are normally `session-<uuid>` or a bare UUID and therefore stay
 * literal; decoding is a compatibility fallback, not the primary lookup.
 */
export function decodeSessionSegment(name) {
  return String(name).replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
}

/** Find `<sessionsRoot>/<slug>/<sessionId>`; null when the session has no log. */
export async function findSessionDir(sessionsRoot, sessionId) {
  let dirents
  try {
    dirents = await readdir(sessionsRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  const candidates = []
  for (const dirent of dirents) {
    if (dirent.isDirectory()) candidates.push(join(sessionsRoot, dirent.name, sessionId))
  }
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (info.isDirectory()) return candidate
    } catch {
      // Not in this slug; fall through to the encoded-name pass.
    }
  }
  // Encoded id fallback (only needed for ids containing unsafe characters).
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    const slugDir = join(sessionsRoot, dirent.name)
    let entries
    try {
      entries = await readdir(slugDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() && decodeSessionSegment(entry.name) === sessionId) {
        return join(slugDir, entry.name)
      }
    }
  }
  return null
}

/**
 * Best-effort removal of the per-session projection checkpoint. The checkpoint
 * is derived state and self-heals, so a failure here is reported nowhere and
 * never blocks the deletion transaction.
 */
export async function removeProjectionCheckpoint(storagesDir, sessionId) {
  await rm(join(storagesDir, 'session_projcache', 'sessions', `${sessionId}.json`), { force: true }).catch(() => {})
}

/** Rename across volumes safely (the recycle bin normally shares the volume). */
export async function moveDirectory(from, to) {
  await mkdir(dirname(to), { recursive: true })
  try {
    await rename(from, to)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    await cp(from, to, { recursive: true, errorOnExist: true, force: false })
    await rm(from, { recursive: true, force: true })
  }
}

/** Read one JSON file; `undefined` for ENOENT, throws for malformed content. */
export async function readJsonFile(filePath) {
  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`malformed JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Write JSON through a sibling temp file + rename (never a torn target). */
export async function writeJsonAtomic(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`
  const payload = `${JSON.stringify(value, null, 2)}\n`
  const { writeFile } = await import('node:fs/promises')
  await writeFile(temporary, payload, 'utf8')
  await rename(temporary, filePath)
}
