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
/** The per-record projection format this plugin was written against. */
const PROJECTION_VERSION = 7
/** `unit.version` of the legacy bulk title table that `readTitles` trusts. */
const LEGACY_TITLES_VERSION = 3

export function createSessionGateway({ ctx, paths, now = Date.now, logger = console }) {
  let listCache = null
  let listCachedAt = -Infinity
  // Single-flight for the list build. `inspect()` calls `loadList()` and a plan
  // preflight now inspects several sessions concurrently, so without this every
  // worker that arrives before the first build finishes would start its own.
  let listInFlight = null
  // Bumped by `invalidate()`. A build that started before an invalidation must
  // not write its (possibly pre-mutation) snapshot into the cache afterwards.
  let listGeneration = 0
  let stateCache = null
  let stateCachedAt = -Infinity
  /**
   * Why a row has no title must be visible, not silent: the previous
   * `version !== 7 → null` rule turned a Host format bump into "every
   * conversation is untitled" with no signal anywhere. These counters are
   * reset per list build and published through `diagnostics()`.
   */
  let projectionStats = { total: 0, foreignVersion: 0, malformed: 0, unreadable: 0 }
  let legacyTitles = 'unknown'

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

  /**
   * Legacy bulk title table (`storages/session_projcache.json`).
   *
   * Host 0.2.2+ stopped writing it when per-record checkpoints arrived, so the
   * per-session files are authoritative and this table is a compatibility read
   * for older layouts. Two rules keep it from becoming a source of stale data:
   *
   *   - it is VERSION-PINNED (`unit.version`), because the row semantics are
   *     what that number describes. The observed file is `unit.version: 3`;
   *     anything else is skipped with a diagnostic instead of trusted;
   *   - it never outranks a per-record checkpoint — `buildList` asks for the
   *     bulk table only to fill rows the authoritative read could not resolve.
   *
   * Reading it unconditionally (pre-0.3.22) meant a conversation renamed after
   * the migration kept showing its migration-era title forever.
   */
  async function readTitles() {
    try {
      const document = await readJsonFile(paths.projectionCacheFile)
      const version = document?.unit?.version
      if (version !== LEGACY_TITLES_VERSION) {
        legacyTitles = version === undefined ? 'no-version' : `v${String(version)}`
        return new Map()
      }
      const sessions = document?.tables?.sessions
      if (sessions === null || typeof sessions !== 'object') {
        legacyTitles = 'v3'
        return new Map()
      }
      const map = new Map()
      for (const [sessionId, record] of Object.entries(sessions)) {
        const title = record?.rows?.title?.val
        const blank = record?.rows?.sessionListMetadata?.val?.blank
        map.set(sessionId, {
          title: typeof title === 'string' ? title : '',
          blank: blank === true,
          createdAt: typeof record?.identity?.createdAt === 'number' ? record.identity.createdAt : null,
        })
      }
      legacyTitles = 'v3'
      return map
    } catch (error) {
      legacyTitles = error?.code === 'ENOENT' ? 'absent' : 'unreadable'
      return new Map()
    }
  }

  /**
   * The authoritative projection checkpoint is the per-session file
   * (`storages/session_projcache/sessions/<id>.json`).
   *
   * 0.3.22 replaced the `version === 7` equality with a capability check. The
   * old gate had two failure modes, both silent: a Host that bumped the format
   * while keeping these fields cost every row its title, and the test suite had
   * baked that degradation in as the EXPECTED result (so CI stayed green). The
   * fields the plugin actually reads are self-describing (`rows.title.val`,
   * `rows.sessionListMetadata.val`), so they are checked directly; an
   * unexpected version that STILL satisfies the shape is read and counted in
   * the diagnostics, while a shape mismatch degrades to "no projection".
   */
  async function readSessionProjection(sessionId) {
    const file = join(paths.storagesDir, 'session_projcache', 'sessions', `${sessionId}.json`)
    let document
    try {
      document = await readJsonFile(file)
    } catch (error) {
      if (error?.code !== 'ENOENT') projectionStats.unreadable += 1
      return null
    }
    const rows = document?.record?.rows
    if (rows === null || typeof rows !== 'object') {
      projectionStats.malformed += 1
      return null
    }
    const titleRow = rows.title
    const blankRow = rows.sessionListMetadata
    // At least one of the two rows this build reads must be present: a `rows`
    // object made only of unknown keys is a different layout, not an empty one.
    if (titleRow === undefined && blankRow === undefined) {
      projectionStats.malformed += 1
      return null
    }
    const titleShaped = titleRow === undefined || (titleRow !== null && typeof titleRow === 'object' && 'val' in titleRow)
    const blankShaped = blankRow === undefined || (blankRow !== null && typeof blankRow === 'object' && 'val' in blankRow)
    if (!titleShaped || !blankShaped) {
      projectionStats.malformed += 1
      return null
    }
    const version = document?.version
    if (version !== PROJECTION_VERSION) projectionStats.foreignVersion += 1
    return {
      title: typeof titleRow?.val === 'string' ? titleRow.val : '',
      blank: blankRow?.val?.blank === true,
      createdAt: document?.record?.identity?.createdAt ?? null,
      version,
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
    if (listInFlight !== null) return listInFlight
    const generation = listGeneration
    const pending = buildList(generation)
    listInFlight = pending
    try {
      return await pending
    } finally {
      if (listInFlight === pending) listInFlight = null
    }
  }

  async function buildList(generation) {
    const controller = service('sessionController')
    const persistence = service('sessionPersistence')
    let items = []
    // A Host list call that times out or throws used to fail the whole
    // `/sessions` route with 500, which also broke the preview/delete
    // preflight. Degrade to an empty list and keep the failure audible in the
    // log instead: every other read in this module already swallows errors.
    try {
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
    } catch (error) {
      logger.warn?.(`[conversation-recycle-bin] session list unavailable: ${error?.message ?? error}`)
      items = []
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
    const rows = items.map((item) => {
      const member = workspaceBySession.get(item.sessionId) ?? null
      const byCwd = member === null ? workspaceByCwd(item.cwd) : null
      const owned = member ?? (byCwd === null ? null : { workspace: byCwd, index: -1 })
      return {
        id: String(item.sessionId),
        // Left empty on purpose: the authoritative per-record projection below
        // fills it, and the legacy bulk table is only a fallback. Seeding this
        // from `titles` here is what made the stale value win.
        title: '',
        cwd: item.cwd ?? null,
        origin: item.origin ?? null,
        blank: item.blank === true,
        running: item.running === true,
        live: isLive(item.sessionId),
        archived: state.archived.has(item.sessionId),
        pinned: state.pinned.has(item.sessionId),
        createdAt: null,
        updatedAt: item.updatedAt ?? null,
        events: null,
        sizeBytes: null,
        workspace: owned === null ? null : { id: owned.workspace.id, title: owned.workspace.title, path: owned.workspace.path, index: owned.index },
        workspaceId: owned?.workspace?.id ?? null,
        workspacePath: owned?.workspace?.path ?? null,
        workspaceIndex: owned?.index ?? -1,
      }
    })
    // The per-record checkpoint is the AUTHORITATIVE source, so it is read for
    // every row, not just the rows the legacy table failed to title. Reading it
    // only for untitled rows is what let a migration-era title outlive a rename
    // (the legacy row still carried a non-empty title, so the fresh one was
    // never consulted). Batched so a long history does not open hundreds of
    // descriptors at once.
    projectionStats = { total: rows.length, foreignVersion: 0, malformed: 0, unreadable: 0 }
    const legacyTitlesMap = titles
    for (let index = 0; index < rows.length; index += 16) {
      await Promise.all(rows.slice(index, index + 16).map(async (row) => {
        const projection = await readSessionProjection(row.id)
        if (projection === null) return
        if (projection.title !== '') row.title = projection.title
        row.blank = row.blank || projection.blank
        if (projection.createdAt !== null) row.createdAt = projection.createdAt
      }))
    }
    // Compatibility fill for rows the authoritative read could not resolve
    // (no checkpoint on disk at all, or a shape this build cannot read).
    for (const row of rows) {
      if (row.title !== '') continue
      const cached = legacyTitlesMap.get(row.id)
      if (cached === undefined) continue
      if (cached.title !== '') row.title = cached.title
      row.blank = row.blank || cached.blank === true
      if (row.createdAt === null && cached.createdAt !== null) row.createdAt = cached.createdAt
    }
    // A build that started before an `invalidate()` describes state the caller
    // deliberately discarded, so it must not install itself as the cache.
    if (generation === listGeneration) {
      listCache = rows
      listCachedAt = now()
    }
    return rows
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
     * NOTE: `enrichTitles()` used to live here. It re-read the same projection
     * files `buildList()` had just read — but only for rows still untitled, and
     * only for the first 80 rows — purely to fill a title/`createdAt` that
     * `buildList()` now fills for every row. `/sessions` paid for that second,
     * partial pass on every call. Titles and `createdAt` are complete after
     * `list()`; see `buildList()`.
     */

    /**
     * Drop every cached read. Also retires an in-flight list build: it started
     * from state the caller has just been told is stale (a pin or archive made
     * inside the 1.5 s window), so its result must neither be installed nor be
     * what the next `inspect()` awaits.
     */
    /**
     * Host-contract health, published through `/state`.
     *
     * The point of this record is that a degraded title source must be
     * OBSERVABLE. `foreignVersion` counts checkpoints that were readable but
     * carried an unexpected format version; `malformed` counts shapes this
     * build cannot read; `legacyTitles` says whether the bulk table was used
     * (`v3`), absent, or skipped because its `unit.version` was not the one
     * this build understands.
     */
    diagnostics() {
      return { projection: { ...projectionStats }, legacyTitles }
    },

    invalidate() {
      listGeneration += 1
      listInFlight = null
      listCache = null
      listCachedAt = -Infinity
      stateCache = null
      stateCachedAt = -Infinity
    },
  }
}
