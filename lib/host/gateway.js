/**
 * Read-only gateway over the Host services this plugin depends on.
 *
 * All services are optional at construction time and probed per request, so a
 * slimmer composition yields a readable `E_INTERNAL`/`E_NOT_FOUND` instead of a
 * failed plugin fiber. The gateway normalizes the several DSH shapes into ONE
 * session record used by policy, previews and the cascade:
 *
 *   { id, title, cwd, origin, blank, running, live, archived, pinned,
 *     createdAt, updatedAt, events, sizeBytes, workspace, workspaceIndex }
 *
 * Titles come from the durable session projection cache when present (a cheap
 * read of `storages/session_projcache.json`) and fall back to the Client's
 * display title; nothing here trusts the Client for authorization.
 */
import { findSessionDir, readJsonFile } from './paths.js'
import { join } from 'node:path'
import { isPathInside } from '../core/policy.js'
import { SESSION_ID_PATTERN } from '../core/ids.js'

const LIST_TTL_MS = 1_500
const STATE_TTL_MS = 1_500

export function createSessionGateway({ ctx, paths, now = Date.now }) {
  let listCache = null
  let listCachedAt = -Infinity
  let stateCache = null
  let stateCachedAt = -Infinity

  const service = (name) => {
    try {
      return ctx.get?.(name) ?? ctx[name]
    } catch {
      return undefined
    }
  }

  async function readWorkspaceState() {
    if (stateCache !== null && now() - stateCachedAt < STATE_TTL_MS) return stateCache
    let archived = []
    let pinned = []
    try {
      const document = await readJsonFile(paths.workspaceFile)
      archived = Array.isArray(document?.global?.archivedSessionIds) ? document.global.archivedSessionIds : []
      pinned = Array.isArray(document?.global?.pinnedSessionIds) ? document.global.pinnedSessionIds : []
    } catch {
      // A missing or being-rewritten registry is treated as "no archive data";
      // the authoritative mutate path is workspaceRegistry, not this read.
    }
    stateCache = { archived: new Set(archived), pinned: new Set(pinned) }
    stateCachedAt = now()
    return stateCache
  }

  async function readTitles() {
    try {
      const document = await readJsonFile(paths.projectionCacheFile)
      const sessions = document?.tables?.sessions
      if (sessions === null || typeof sessions !== 'object') return new Map()
      const map = new Map()
      for (const [sessionId, record] of Object.entries(sessions)) {
        const title = record?.rows?.title?.val
        const blank = record?.rows?.sessionListMetadata?.val?.blank
        map.set(sessionId, { title: typeof title === 'string' ? title : '', blank: blank === true })
      }
      return map
    } catch {
      return new Map()
    }
  }

  /**
   * The authoritative projection checkpoint is the per-session file
   * (`storages/session_projcache/sessions/<id>.json`, format version 7); the
   * root `session_projcache.json` is a legacy domain dump and is intentionally
   * only a bulk fallback.
   */
  async function readSessionProjection(sessionId) {
    const file = join(paths.storagesDir, 'session_projcache', 'sessions', `${sessionId}.json`)
    try {
      const document = await readJsonFile(file)
      const rows = document?.record?.rows
      if (rows === null || typeof rows !== 'object') return null
      return {
        title: typeof rows.title?.val === 'string' ? rows.title.val : '',
        blank: rows.sessionListMetadata?.val?.blank === true,
        createdAt: document?.record?.identity?.createdAt ?? null,
      }
    } catch {
      return null
    }
  }

  async function workspaceEntities() {
    const registry = service('workspaceRegistry')
    if (registry === undefined || typeof registry.list !== 'function') return []
    try {
      return registry.list()
    } catch {
      return []
    }
  }

  async function loadList() {
    if (listCache !== null && now() - listCachedAt < LIST_TTL_MS) return listCache
    const controller = service('sessionController')
    const persistence = service('sessionPersistence')
    let items = []
    if (controller !== undefined && typeof controller.list === 'function') {
      const value = await controller.list({}, AbortSignal.timeout(5_000))
      items = Array.isArray(value?.items) ? value.items : []
    } else if (persistence !== undefined && typeof persistence.list === 'function') {
      const snapshots = await persistence.list({ signal: AbortSignal.timeout(5_000) })
      items = snapshots.map((snapshot) => ({
        sessionId: snapshot.header.id,
        updatedAt: snapshot.header.createdAt,
        running: false,
        blank: false,
        cwd: snapshot.header.cwd,
        origin: snapshot.header.origin,
      }))
    }
    const workspaces = await workspaceEntities()
    const workspaceBySession = new Map()
    for (const workspace of workspaces) {
      const ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
      ids.forEach((sessionId, index) => {
        if (!workspaceBySession.has(sessionId)) workspaceBySession.set(sessionId, { workspace, index })
      })
    }
    // Ownership is also decided by cwd containment, exactly like `inspect`'s
    // `workspaceFor` fallback: a session whose directory moved out of every
    // registered workspace is an orphan, and `/sessions` must say so per row.
    // Without this, `evaluateSessionPolicy` saw `workspace: undefined` on every
    // list row and marked the whole batch picker non-deletable.
    const workspaceByCwd = (cwd) => {
      if (typeof cwd !== 'string' || cwd === '') return null
      return workspaces.find((workspace) => isPathInside(workspace.path, cwd)) ?? null
    }
    const titles = await readTitles()
    const state = await readWorkspaceState()
    listCache = items.map((item) => {
      const member = workspaceBySession.get(item.sessionId) ?? null
      const byCwd = member === null ? workspaceByCwd(item.cwd) : null
      const owned = member ?? (byCwd === null ? null : { workspace: byCwd, index: -1 })
      const cached = titles.get(item.sessionId) ?? { title: '', blank: item.blank === true }
      return {
        id: String(item.sessionId),
        title: cached.title,
        cwd: item.cwd ?? null,
        origin: item.origin ?? null,
        blank: item.blank === true || cached.blank === true,
        running: item.running === true,
        live: isLive(item.sessionId),
        archived: state.archived.has(item.sessionId),
        pinned: state.pinned.has(item.sessionId),
        createdAt: cached.createdAt ?? null,
        updatedAt: item.updatedAt ?? null,
        events: null,
        sizeBytes: null,
        workspace: owned === null ? null : { id: owned.workspace.id, title: owned.workspace.title, path: owned.workspace.path, index: owned.index },
        workspaceId: owned?.workspace?.id ?? null,
        workspacePath: owned?.workspace?.path ?? null,
        workspaceIndex: owned?.index ?? -1,
      }
    })
    listCachedAt = now()
    return listCache
  }

  function isLive(sessionId) {
    // Two independent signals: the in-memory session table, and the agent
    // registry the Host itself uses to compute a row's `running` flag. A
    // composition that publishes only `agents` used to look "not live" here,
    // which skipped quiescing and moved a running conversation's log.
    const sessions = service('sessions')
    if (sessions !== undefined && typeof sessions.get === 'function') {
      try {
        if (sessions.get(sessionId) !== undefined) return true
      } catch {
        // fall through to the agent registry
      }
    }
    const agents = service('agents')
    if (agents !== undefined && typeof agents.get === 'function') {
      try {
        if (agents.get(sessionId) !== undefined && agents.get(sessionId) !== null) return true
      } catch {
        return false
      }
    }
    return false
  }

  /**
   * Lightweight running probe for the bounded drain: reads only the in-memory
   * live-sessions table instead of rebuilding the whole session list on every
   * poll. Returns `undefined` when the service is absent or the entry shape is
   * unknown, so the caller falls back to a full `inspect()`.
   * @returns {boolean|undefined}
   */
  /**
   * Merge the two running signals: the cached list row and the live probe.
   * Either saying "running" wins (a stale list must not hide a live turn); a
   * probe that cannot answer leaves the list's value alone, `undefined`
   * included, so callers can stay fail-closed.
   */
  function runningFlag(fromList, probed) {
    if (fromList?.running === true || probed === true) return true
    if (probed !== undefined) return probed
    return fromList?.running
  }

  function probeRunning(sessionId) {
    // Authoritative cheap probe first: the Host computes a list row's `running`
    // flag from exactly this check (`api-session-controller`: `agents.get(id)
    // ?.status === "running"`). The `Session` object handed out by `sessions.get`
    // carries no `running`/`active`/`busy` field, so the legacy probe below can
    // only ever answer `undefined` on current Hosts.
    const agents = service('agents')
    if (agents !== undefined && typeof agents.get === 'function') {
      try {
        const agent = agents.get(sessionId)
        if (agent === undefined || agent === null) return false
        if (typeof agent.status === 'string') return agent.status === 'running'
      } catch {
        // Fall through to the legacy field probe.
      }
    }
    const sessions = service('sessions')
    if (sessions === undefined || typeof sessions.get !== 'function') return undefined
    let current
    try {
      current = sessions.get(sessionId)
    } catch {
      return undefined
    }
    if (current === null || current === undefined) return false
    if (typeof current !== 'object') return undefined
    if (typeof current.running === 'boolean') return current.running
    if (typeof current.active === 'boolean') return current.active
    if (typeof current.busy === 'boolean') return current.busy
    return undefined
  }

  /**
   * Event count when it is cheaply knowable, `null` otherwise.
   *
   * `sessionPersistence.stat()` reports `header`/`revision`/`sizeBytes` (and no
   * `eventCount` on 0.2.1), so the old `snapshot.eventCount` read was dead. A
   * live session does expose the count exactly: the session store defines `seq`
   * as "always the log length" (`dsh-session` `get seq()`), and it is a plain
   * number read, not a materialized `snapshotEvents()` (that API is deprecated).
   * For a stored, non-live session there is no equivalent that avoids reading
   * and parsing the whole log, so the field stays `null` instead of presenting
   * a projection cursor as an exact count.
   * @returns {number|null}
   */
  function eventCountFor(sessionId, snapshot) {
    if (typeof snapshot?.eventCount === 'number') return snapshot.eventCount
    const sessions = service('sessions')
    if (sessions === undefined || typeof sessions.get !== 'function') return null
    try {
      const seq = sessions.get(sessionId)?.seq
      return typeof seq === 'number' && Number.isFinite(seq) && seq >= 0 ? seq : null
    } catch {
      return null
    }
  }

  async function workspaceFor(session) {
    const workspaces = await workspaceEntities()
    const byId = workspaces.find((workspace) => workspace.id === session.workspaceId)
    if (byId !== undefined) return byId
    const byCwd = workspaces.find((workspace) => {
      if (typeof workspace.path !== 'string' || typeof session.cwd !== 'string') return false
      // Shared path semantics: drive-letter paths compare case-insensitively,
      // POSIX paths stay case-sensitive, and UNC roots are handled like Windows.
      return isPathInside(workspace.path, session.cwd)
    })
    return byCwd ?? null
  }

  return {
    workspaceState: readWorkspaceState,
    list: loadList,
    isRunning: probeRunning,

    /** Normalize one session; throws E_NOT_FOUND-shaped data as `null`. */
    async inspect(sessionId) {
      if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return null
      const persistence = service('sessionPersistence')
      let snapshot
      if (persistence !== undefined && typeof persistence.stat === 'function') {
        try {
          snapshot = await persistence.stat(sessionId, { signal: AbortSignal.timeout(5_000) })
        } catch {
          snapshot = undefined
        }
      }
      const fromList = (await loadList()).find((item) => item.id === sessionId)
      if (snapshot === undefined && fromList === undefined && !isLive(sessionId)) return null
      const projection = await readSessionProjection(sessionId)
      const workspace = await workspaceFor(fromList ?? { workspaceId: null, cwd: snapshot?.header?.cwd ?? null })
      const entity = workspace !== null && typeof workspace.sessionIds?.indexOf === 'function'
        ? workspace.sessionIds.indexOf(sessionId)
        : -1
      // `controller.list()` does not have to carry archive state, and treating
      // its silence as "not archived" made restore un-hide conversations the
      // user had archived. The workspace registry is the authoritative record,
      // so it wins when it knows about the session.
      const state = await readWorkspaceState()
      return {
        id: sessionId,
        title: projection?.title || fromList?.title || '',
        cwd: snapshot?.header?.cwd ?? fromList?.cwd ?? null,
        origin: snapshot?.header?.origin ?? fromList?.origin ?? null,
        blank: projection?.blank ?? fromList?.blank ?? false,
        // `?? false` made "the Host did not say" indistinguishable from "it is
        // stopped", which turned lifecycle's fail-closed branch into dead code.
        // `controller.list()` is cached for a few seconds, so a turn that
        // started since then still reads as stopped there; the live agent
        // registry is cheap and authoritative, so any `true` from either wins.
        running: runningFlag(fromList, probeRunning(sessionId)),
        live: isLive(sessionId),
        archived: state.archived.has(sessionId) || fromList?.archived === true,
        pinned: state.pinned.has(sessionId) || fromList?.pinned === true,
        createdAt: snapshot?.header?.createdAt ?? null,
        updatedAt: fromList?.updatedAt ?? null,
        events: eventCountFor(sessionId, snapshot),
        sizeBytes: typeof snapshot?.sizeBytes === 'number' ? snapshot.sizeBytes : null,
        workspace: workspace === null ? null : { id: workspace.id, title: workspace.title, path: workspace.path, index: entity },
        workspaceId: workspace?.id ?? null,
        workspaceIndex: entity,
      }
    },

    findSessionDir(sessionId) {
      return findSessionDir(paths.sessionsRoot, sessionId)
    },

    /**
     * Fill missing titles from the per-session projection checkpoints for the
     * first `limit` rows. The bulk list is read-only UI data, so this is done
     * lazily here rather than on every inspect; a missing checkpoint simply
     * leaves the id/cwd fallback the Client renders.
     */
    async enrichTitles(sessions, limit = 80) {
      const slice = sessions.slice(0, Math.max(1, limit))
      await Promise.all(slice.map(async (session) => {
        if (typeof session.title === 'string' && session.title !== '') return
        const projection = await readSessionProjection(session.id)
        if (projection === null) return
        if (typeof projection.title === 'string' && projection.title !== '') session.title = projection.title
        if (projection.blank === true) session.blank = true
        if (session.createdAt === null) session.createdAt = projection.createdAt ?? null
      }))
      return sessions
    },

    invalidate() {
      listCache = null
      listCachedAt = -Infinity
      stateCache = null
      stateCachedAt = -Infinity
    },
  }
}
