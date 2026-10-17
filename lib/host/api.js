/**
 * The plugin's same-origin HTTP API.
 *
 * Transport: the Host Web server route registered by `lib/index.js`. The route
 * is DELIBERATELY not exposed as an agent tool: deleting conversations is a
 * user-only authority (see README "权限声明"). The Client never receives raw
 * filesystem handles — it only sends session ids and receives counts/status.
 *
 * Request contract (all responses JSON, `cache-control: no-store`):
 *   GET  /state                     capabilities, adapters, limits, rate budget
 *   GET  /sessions                  sessions visible to the batch picker
 *   POST /preview                   counts + policy + a single-use confirm token
 *   POST /delete                    execute (memory → messages → session per id)
 *   GET  /trash                     recycle-bin entries + incomplete entries
 *   POST /trash/restore             restore one entry
 *   POST /trash/purge               permanently delete one entry
 *   POST /trash/discard             remove an entry that never committed
 *   GET  /audit?limit=N             audit trail tail
 *
 * Confirmation is a two-part server-side protocol, not a Client-side courtesy:
 * `/preview` issues a single-use token bound to (session ids, includeMemory,
 * mode); `/delete` must present that token. An additional typed phrase is
 * required only for a soft batch (double confirmation) and for purging a
 * recycle-bin entry (irreversible); permanent deletion itself is one click.
 * A replayed, edited or expired plan is refused.
 */
import { randomBytes } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { DeleteError, ERROR_STATUS, asDeleteError, toWireError } from '../core/errors.js'
import { createAuditLog } from '../core/audit.js'
import { createTrashStore } from '../core/trash.js'
import { createMemoryService } from '../core/memory/registry.js'
import { performSessionDelete, performPurge, performRestore, performDiscard } from '../core/cascade.js'
import { evaluateSessionPolicy } from '../core/policy.js'
import { createSlidingWindowLimiter } from '../core/rate-limit.js'
import { createCatalogOps, createSessionLogOps } from './catalog.js'
import { createLifecycleOps } from './lifecycle.js'
import { createSessionGateway } from './gateway.js'
import { createMemoryAdapters } from './memory.js'
import { PLUGIN_VERSION } from '../version.js'

export const ROUTE_PREFIX = '/delete-conversation/api'
export const REQUIRED_HEADER = 'x-delete-conversation'
const MAX_BODY_BYTES = 256 * 1024
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{6,80}$/

function isLoopbackHostname(hostname) {
  const value = String(hostname ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  return value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)
}

function hostnameOf(hostHeader) {
  const value = String(hostHeader ?? '').trim().toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? value : value.slice(1, end)
  }
  const colon = value.lastIndexOf(':')
  return colon > 0 && /^\d+$/.test(value.slice(colon + 1)) ? value.slice(0, colon) : value
}

function sameHostname(left, right) {
  const normalize = (value) => {
    const trimmed = String(value ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')
    if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(trimmed)) return trimmed.slice('::ffff:'.length)
    if (trimmed === '0:0:0:0:0:0:0:1') return '::1'
    return trimmed
  }
  return normalize(left) === normalize(right)
}

/**
 * Origin/Host verdict for one request.
 * @returns {{ ok: true } | { ok: false, error: DeleteError }}
 */
export function requestOriginVerdict(headers, { requireSameOrigin, allowNonLoopback }) {
  const read = (name) => {
    if (headers === null || typeof headers !== 'object') return ''
    const value = headers[name]
    return typeof value === 'string' ? value : ''
  }
  const requestHostname = hostnameOf(read('host'))

  if (!allowNonLoopback && !isLoopbackHostname(requestHostname)) {
    return {
      ok: false,
      error: new DeleteError('E_FORBIDDEN_HOST', 'This route only accepts loopback requests unless allowNonLoopback is enabled.', {
        host: read('host') || null,
      }),
    }
  }
  if (read('sec-fetch-site').trim().toLowerCase() === 'cross-site') {
    return { ok: false, error: new DeleteError('E_FORBIDDEN_ORIGIN', 'Cross-site requests are refused.', { reason: 'Sec-Fetch-Site: cross-site' }) }
  }
  if (requireSameOrigin) {
    const origin = read('origin').trim()
    if (origin !== '') {
      let originHostname = ''
      let trustedAppShell = false
      try {
        const parsed = new URL(origin)
        originHostname = parsed.hostname.toLowerCase()
        // The Electron shell serves the page from a private scheme and
        // forwards the request to this same Host; no web origin can produce
        // that scheme, so it is safe to trust it as same-origin.
        trustedAppShell = parsed.protocol === 'dsh-app:'
      } catch {
        originHostname = ''
      }
      if (trustedAppShell !== true && (originHostname === '' || !sameHostname(originHostname, requestHostname))) {
        return { ok: false, error: new DeleteError('E_FORBIDDEN_ORIGIN', 'The request origin does not match this Host.', { origin }) }
      }
    }
  }
  return { ok: true }
}

function expectedPhrase({ count, mode, config }) {
  // Permanent deletion must stay one click: the user asked for no typed
  // confirmation. The server-side token is still required and still binds the
  // exact plan, so a stale or edited plan is refused without ever making the
  // user repeat a phrase.
  if (mode === 'hard') return ''
  if (count > 1 && config.ui.batchDoubleConfirm) return String(count)
  return ''
}

function normalizeSessionIds(body) {
  const list = Array.isArray(body?.sessionIds)
    ? body.sessionIds
    : typeof body?.sessionId === 'string'
      ? [body.sessionId]
      : []
  const ids = []
  for (const raw of list) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (!SESSION_ID_PATTERN.test(id)) {
      throw new DeleteError('E_BAD_REQUEST', 'A session id is malformed.', { sessionId: String(raw).slice(0, 80) })
    }
    if (!ids.includes(id)) ids.push(id)
  }
  if (ids.length === 0) throw new DeleteError('E_BAD_REQUEST', 'At least one session id is required.', {})
  return ids
}

function normalizeMode(body, config) {
  const mode = body?.mode === undefined ? config.defaultMode : body.mode
  if (mode !== 'soft' && mode !== 'hard') {
    throw new DeleteError('E_BAD_REQUEST', 'mode must be "soft" or "hard".', { mode: String(mode).slice(0, 20) })
  }
  return mode
}

function normalizeBoolean(body, key) {
  return body?.[key] === true
}

/** Read and parse a JSON body with a hard byte ceiling. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0
    let overflow = false
    const chunks = []
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (overflow) return
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > MAX_BODY_BYTES) {
        overflow = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      if (overflow) {
        reject(new DeleteError('E_BAD_REQUEST', 'Request body exceeds the size limit.', { limit: MAX_BODY_BYTES }, { httpStatus: 413 }))
        return
      }
      const raw = chunks.join('').trim()
      if (raw === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new DeleteError('E_BAD_REQUEST', 'Request body must be a JSON object.', {}))
          return
        }
        resolve(parsed)
      } catch (error) {
        reject(new DeleteError('E_BAD_REQUEST', 'Request body is not valid JSON.', {}, { cause: error }))
      }
    })
  })
}

function sendJson(res, status, payload) {
  if (res.writableEnded === true) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body, 'utf8'),
  })
  res.end(body)
}

/**
 * @param {object} input
 * @param {import('@deepseek-ai/cordis').Context} input.ctx
 * @param {ReturnType<import('../core/config.js').normalizeConfig>['value']} input.config
 * @param {object} input.paths resolution from `host/paths.js`
 * @param {() => number} [input.now]
 * @param {Pick<Console, 'error'|'warn'|'info'>} [input.logger]
 */
export function createDeleteApi({ ctx, config, paths, now = Date.now, logger = console }) {
  const gateway = createSessionGateway({ ctx, paths, now })
  const memoryService = createMemoryService({
    adapters: createMemoryAdapters({ config, dshHome: paths.dshHome, now }),
    config,
    now,
  })
  const trash = createTrashStore({ rootDir: paths.trashDir, now })
  const audit = createAuditLog({
    filePath: paths.auditFile,
    maxBytes: config.auditMaxBytes,
    retentionLines: config.auditRetentionLines,
    now,
  })
  const limiter = createSlidingWindowLimiter({ limit: config.maxDeletesPerMinute, windowMs: 60_000, now })
  const ops = {
    memory: memoryService,
    sessionLog: createSessionLogOps({ gateway, paths, config, now, logger }),
    catalog: createCatalogOps({ ctx, now }),
    session: gateway,
    lifecycle: createLifecycleOps({ ctx, gateway, config, now }),
    pathExists: async (target) => {
      try {
        await stat(target)
        return true
      } catch {
        return false
      }
    },
    hasFiles: async (target) => {
      try {
        const entries = await readdir(target, { recursive: true })
        return entries.length > 0
      } catch {
        return false
      }
    },
  }

  /** @type {Map<string, { planKey: string, sessionIds: string[], includeMemory: boolean, mode: 'soft'|'hard', phrase: string, issuedAt: number, expiresAt: number, used: boolean }>} */
  const confirmations = new Map()
  let mutationChain = Promise.resolve()
  let requestCounter = 0

  function serialize(operation) {
    const next = mutationChain.then(operation, operation)
    mutationChain = next.then(() => undefined, () => undefined)
    return next
  }

  function requestId() {
    requestCounter += 1
    return `dc-${now().toString(36)}-${requestCounter.toString(36)}-${randomBytes(2).toString('hex')}`
  }

  /**
   * Effective batch ceiling for this moment: the configured batch size capped
   * by the remaining per-minute budget. Without this, a batch of 21–50 always
   * died with E_RATE_LIMITED even though `maxBatchSessions` said it was legal.
   */
  function effectiveBatchLimit() {
    const remaining = limiter.status().remaining
    return Math.max(1, Math.min(config.maxBatchSessions, remaining))
  }

  function cleanupConfirmations() {
    const current = now()
    for (const [token, record] of confirmations) {
      if (record.expiresAt <= current) confirmations.delete(token)
    }
    if (confirmations.size <= 512) return
    // Evict the oldest plans, not the whole map: a long preview session used to
    // invalidate every open dialog at once.
    const oldest = [...confirmations.entries()].sort((left, right) => left[1].issuedAt - right[1].issuedAt)
    for (const [token] of oldest.slice(0, confirmations.size - 512)) confirmations.delete(token)
  }

  function issueConfirmation({ sessionIds, includeMemory, mode }) {
    cleanupConfirmations()
    const token = randomBytes(24).toString('hex')
    const phrase = expectedPhrase({ count: sessionIds.length, mode, config })
    const record = {
      planKey: planKeyOf({ sessionIds, includeMemory, mode }),
      sessionIds: [...sessionIds],
      includeMemory,
      mode,
      phrase,
      issuedAt: now(),
      expiresAt: now() + config.confirmTokenTtlMs,
      used: false,
    }
    confirmations.set(token, record)
    return { token, expiresAt: record.expiresAt, phrase }
  }

  function validateConfirmation(token, plan) {
    if (typeof token !== 'string' || token === '') {
      throw new DeleteError('E_CONFIRM_REQUIRED', 'Preview the deletion before confirming it.', {})
    }
    const record = confirmations.get(token)
    if (record === undefined) {
      throw new DeleteError('E_CONFIRM_INVALID', 'The confirmation token is unknown or was already used.', {})
    }
    if (record.expiresAt <= now()) {
      confirmations.delete(token)
      throw new DeleteError('E_CONFIRM_EXPIRED', 'The confirmation expired; preview the deletion again.', { expiredAt: record.expiresAt })
    }
    if (record.used) {
      throw new DeleteError('E_CONFIRM_INVALID', 'The confirmation token was already used.', {})
    }
    if (record.planKey !== planKeyOf(plan)) {
      throw new DeleteError('E_CONFIRM_INVALID', 'The confirmation does not match this deletion plan.', {})
    }
    return { token, record }
  }

  function markConfirmationUsed(validated) {
    validated.record.used = true
    confirmations.delete(validated.token)
  }

  function planKeyOf({ sessionIds, includeMemory, mode }) {
    return JSON.stringify({ ids: [...sessionIds].sort(), includeMemory: includeMemory === true, mode })
  }

  async function preview({ sessionIds, includeMemory, mode }) {
    const rate = limiter.status()
    if (rate.remaining === 0) {
      const retryAfterMs = rate.resetAt === null ? 60_000 : Math.max(1, rate.resetAt - now())
      throw new DeleteError('E_RATE_LIMITED', `Too many deletions; retry in ${Math.ceil(retryAfterMs / 1000)}s.`, {
        retryAfterMs,
        limit: rate.limit,
      })
    }
    const batchLimit = Math.max(1, Math.min(config.maxBatchSessions, rate.remaining))
    if (sessionIds.length > batchLimit) {
      throw new DeleteError('E_BATCH_TOO_LARGE', `At most ${batchLimit} conversations can be deleted in one batch right now.`, {
        count: sessionIds.length,
        limit: batchLimit,
        maxBatchSessions: config.maxBatchSessions,
        rateRemaining: limiter.status().remaining,
      })
    }
    const sessions = []
    const blocked = []
    for (const id of sessionIds) {
      const session = await gateway.inspect(id)
      if (session === null) {
        blocked.push({ sessionId: id, policy: { ok: false, code: 'E_NOT_FOUND', message: 'The conversation was not found.' } })
        continue
      }
      const policy = evaluateSessionPolicy({ session, workspace: session.workspace, live: session.live, mode, config })
      const item = {
        id: session.id,
        title: session.title,
        cwd: session.cwd,
        events: session.events,
        sizeBytes: session.sizeBytes,
        live: session.live,
        archived: session.archived,
        workspace: session.workspace,
        policy: policy.ok ? { ok: true, warnings: policy.warnings } : { ok: false, code: policy.error.code, message: policy.error.message },
      }
      sessions.push(item)
      if (!policy.ok) blocked.push({ sessionId: id, policy: item.policy })
    }

    const memory = config.memory.enabled
      ? await memoryService.countForSessions(sessionIds)
      : { total: 0, bySession: Object.fromEntries(sessionIds.map((id) => [id, 0])), protected: 0, adapters: [], disabled: true }
    const adapterStates = await memoryService.status()
    const confirmation = blocked.length === 0 ? issueConfirmation({ sessionIds, includeMemory, mode }) : null

    return {
      sessions,
      blocked,
      memory: {
        enabled: config.memory.enabled,
        deleteMode: config.memory.deleteMode,
        total: memory.total,
        protected: memory.protected,
        bySession: memory.bySession,
        adapters: memory.adapters,
        stores: adapterStates,
      },
      plan: { sessionIds, includeMemory, mode, count: sessionIds.length },
      confirmation,
      limits: {
        maxBatchSessions: config.maxBatchSessions,
        effectiveBatch: batchLimit,
        maxDeletesPerMinute: config.maxDeletesPerMinute,
        rate: limiter.status(),
        trashRetentionDays: config.trashRetentionDays,
        confirmTokenTtlMs: config.confirmTokenTtlMs,
      },
    }
  }

  async function deletePlan(body) {
    const sessionIds = normalizeSessionIds(body)
    const mode = normalizeMode(body, config)
    const includeMemory = normalizeBoolean(body, 'includeMemory')
    const batchLimit = effectiveBatchLimit()
    if (sessionIds.length > batchLimit) {
      throw new DeleteError('E_BATCH_TOO_LARGE', `At most ${batchLimit} conversations can be deleted in one batch right now.`, {
        count: sessionIds.length,
        limit: batchLimit,
        maxBatchSessions: config.maxBatchSessions,
        rateRemaining: limiter.status().remaining,
      })
    }
    if (!config.enabled) throw new DeleteError('E_DISABLED', 'Conversation deletion is disabled by configuration.', {})

    // Confirmation is validated BEFORE any side effect. The token is consumed
    // only once the phrase and the rate budget have passed, so a typo or a
    // temporary rate limit does not force the user to re-preview.
    const validated = validateConfirmation(body?.confirmToken, { sessionIds, includeMemory, mode })
    const phrase = typeof body?.confirmPhrase === 'string' ? body.confirmPhrase.trim() : ''
    if (validated.record.phrase !== '' && phrase !== validated.record.phrase) {
      throw new DeleteError('E_CONFIRM_PHRASE', `Type “${validated.record.phrase}” to confirm this deletion.`, {
        expected: validated.record.phrase,
        received: phrase.slice(0, 40),
      })
    }

    // Preflight EVERY session before mutating ANY of them: a batch either
    // starts with a fully authorized plan or is refused with the complete list
    // of reasons, never half-executed because the last id was forbidden.
    const sessions = []
    const refusals = []
    for (const id of sessionIds) {
      const session = await gateway.inspect(id)
      if (session === null) {
        refusals.push({ sessionId: id, code: 'E_NOT_FOUND', message: 'The conversation was not found.' })
        continue
      }
      const policy = evaluateSessionPolicy({ session, workspace: session.workspace, live: session.live, mode, config })
      if (!policy.ok) refusals.push({ sessionId: id, code: policy.error.code, message: policy.error.message })
      else sessions.push(session)
    }
    if (refusals.length > 0) {
      await audit
        .append({
          id: `${requestId()}:delete:denied`,
          action: 'delete',
          result: 'denied',
          sessionIds,
          mode,
          includeMemory,
          actor: 'local-user',
          refusals,
          source: 'web-ui',
        })
        .catch(() => {})
      // Report the ACTUAL first refusal. The wire code is what the Client
      // localizes, so hard-coding E_POLICY_ORPHAN made every refusal (live,
      // protected, outside roots, not found) read as "not owned by a
      // workspace". The HTTP status still comes from that same real code.
      const first = refusals[0]
      throw new DeleteError(first.code ?? 'E_POLICY_ORPHAN', first.message, { refusals }, {
        httpStatus: ERROR_STATUS[first.code] ?? 403,
      })
    }

    const budget = limiter.take(sessions.length)
    if (!budget.ok) {
      throw new DeleteError('E_RATE_LIMITED', `Too many deletions; retry in ${Math.ceil(budget.retryAfterMs / 1000)}s.`, {
        retryAfterMs: budget.retryAfterMs,
        limit: budget.limit,
      })
    }
    markConfirmationUsed(validated)

    const request = requestId()
    const results = []
    const failures = []
    for (const session of sessions) {
      try {
        const outcome = await performSessionDelete({
          session,
          mode,
          includeMemory,
          ops,
          trash,
          audit,
          config,
          now,
          actor: 'local-user',
          requestId: request,
        })
        results.push({
          sessionId: session.id,
          title: session.title,
          trashId: outcome.entry.trashId,
          mode,
          memory: outcome.memory.total,
          durationMs: outcome.durationMs,
        })
      } catch (error) {
        const normalized = asDeleteError(error)
        failures.push({ sessionId: session.id, error: normalized.toJSON() })
        logger.error?.(`[delete-conversation] delete failed for ${session.id}: ${normalized.message}`)
      }
    }
    gateway.invalidate()

    if (results.length === 0 && failures.length > 0) {
      const first = failures[0].error
      throw new DeleteError(first.code, first.message, { ...(first.details ?? {}), failures })
    }
    return { requestId: request, results, failures, mode, includeMemory }
  }

  async function restoreEntry(trashId) {
    if (typeof trashId !== 'string' || trashId === '') throw new DeleteError('E_BAD_REQUEST', 'A recycle-bin id is required.', {})
    const entry = await trash.read(trashId)
    if (entry === null) throw new DeleteError('E_TRASH_NOT_FOUND', 'The recycle-bin entry was not found.', { trashId })
    const result = await performRestore({ entry, ops, trash, audit, now, actor: 'local-user', requestId: requestId() })
    gateway.invalidate()
    return result
  }

  async function purgeEntry(trashId, confirmPhrase) {
    if (typeof trashId !== 'string' || trashId === '') throw new DeleteError('E_BAD_REQUEST', 'A recycle-bin id is required.', {})
    if (typeof confirmPhrase !== 'string' || confirmPhrase.trim() !== 'DELETE') {
      throw new DeleteError('E_CONFIRM_PHRASE', 'Type “DELETE” to permanently delete this entry.', { expected: 'DELETE' })
    }
    const entry = await trash.read(trashId)
    if (entry === null) throw new DeleteError('E_TRASH_NOT_FOUND', 'The recycle-bin entry was not found.', { trashId })
    // Purging a soft entry performs the missing hard stages on a still-live
    // session. The cascade's quiesce step stops that session first; if it
    // cannot be stopped within liveDrainMs, the purge fails and rolls back.
    const result = await performPurge({ entry, ops, trash, audit, now, actor: 'local-user', requestId: requestId() })
    gateway.invalidate()
    return result
  }

  /**
   * Remove an entry that never committed (failed / pending / interrupted).
   * These used to be invisible in the UI and rejected by both restore and
   * purge, so they stayed on disk forever.
   */
  async function discardEntry(trashId, confirmPhrase) {
    if (typeof trashId !== 'string' || trashId === '') throw new DeleteError('E_BAD_REQUEST', 'A recycle-bin id is required.', {})
    if (typeof confirmPhrase !== 'string' || confirmPhrase.trim() !== 'DELETE') {
      throw new DeleteError('E_CONFIRM_PHRASE', 'Type “DELETE” to discard this incomplete entry.', { expected: 'DELETE' })
    }
    const entry = await trash.read(trashId)
    if (entry === null) throw new DeleteError('E_TRASH_NOT_FOUND', 'The recycle-bin entry was not found.', { trashId })
    return performDiscard({ entry, ops, trash, audit, now, actor: 'local-user', requestId: requestId() })
  }

  async function state() {
    const adapters = await memoryService.status()
    return {
      enabled: config.enabled,
      version: PLUGIN_VERSION,
      defaultMode: config.defaultMode,
      memory: {
        enabled: config.memory.enabled,
        deleteMode: config.memory.deleteMode,
        adapters,
      },
      limits: {
        maxBatchSessions: config.maxBatchSessions,
        effectiveBatch: effectiveBatchLimit(),
        maxDeletesPerMinute: config.maxDeletesPerMinute,
        rate: limiter.status(),
        trashRetentionDays: config.trashRetentionDays,
        confirmTokenTtlMs: config.confirmTokenTtlMs,
      },
      ui: config.ui,
      storage: {
        trashDir: paths.trashDir,
        auditFile: paths.auditFile,
        dataDir: paths.dataDir,
      },
    }
  }

  async function sessionsForUi() {
    const sessions = await gateway.list()
    await gateway.enrichTitles(sessions)
    return sessions.map((session) => ({
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      updatedAt: session.updatedAt,
      running: session.running,
      live: session.live,
      blank: session.blank,
      archived: session.archived,
      pinned: session.pinned,
      origin: session.origin,
      workspace: session.workspaceId === null ? null : { id: session.workspaceId },
    }))
  }

  function serializeEntry(entry) {
    return {
      trashId: entry.trashId,
      sessionId: entry.sessionId,
      title: entry.title,
      mode: entry.mode,
      includeMemory: entry.includeMemory,
      deletedAt: entry.deletedAt,
      updatedAt: entry.updatedAt,
      memory: entry.memory?.total ?? 0,
      memoryAdapters: Array.isArray(entry.memory?.adapters) ? entry.memory.adapters : [],
      hasSessionLog: entry.sessionLog !== null && entry.sessionLog !== undefined,
      status: entry.status,
      error: entry.error ?? null,
    }
  }

  async function trashList() {
    // Every manifest is returned: `trashed` entries are the usable recycle bin,
    // while failed/pending/restoring/purging entries used to be invisible and
    // impossible to clean up at all. The Client renders them separately.
    const all = await trash.listAll()
    return {
      entries: all.filter((entry) => entry.status === 'trashed').map(serializeEntry),
      incomplete: all.filter((entry) => entry.status !== 'trashed').map(serializeEntry),
    }
  }

  async function auditTail(limit) {
    const parsed = Number.parseInt(String(limit ?? '50'), 10)
    const safe = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50
    const result = await audit.tail(safe)
    return { records: result.records, malformed: result.malformed }
  }

  /** One request → one response. Route matching stays here, not in `apply`. */
  const handler = (req, res) => {
    void (async () => {
      const method = String(req.method ?? 'GET').toUpperCase()
      const url = new URL(req.url ?? '/', 'http://host.invalid')
      const path = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) : url.pathname

      const origin = requestOriginVerdict(req.headers, config)
      if (!origin.ok) {
        sendJson(res, origin.error.httpStatus, toWireError(origin.error))
        return
      }

      try {
        if (method === 'GET' && (path === '' || path === '/state')) {
          sendJson(res, 200, { ok: true, state: await state() })
          return
        }
        if (method === 'GET' && path === '/sessions') {
          sendJson(res, 200, { ok: true, sessions: await sessionsForUi() })
          return
        }
        if (method === 'GET' && path === '/trash') {
          sendJson(res, 200, { ok: true, ...(await trashList()) })
          return
        }
        if (method === 'GET' && path === '/audit') {
          sendJson(res, 200, { ok: true, ...(await auditTail(url.searchParams.get('limit'))) })
          return
        }
        if (method !== 'POST') {
          throw new DeleteError('E_BAD_REQUEST', 'This endpoint accepts POST requests only.', {}, { httpStatus: 405 })
        }
        const header = req.headers?.[REQUIRED_HEADER]
        if (header !== '1') {
          throw new DeleteError('E_FORBIDDEN_ORIGIN', 'Missing the plugin request header.', {})
        }
        if (!config.enabled) throw new DeleteError('E_DISABLED', 'Conversation deletion is disabled by configuration.', {})
        const body = await readJsonBody(req)

        if (path === '/preview') {
          const sessionIds = normalizeSessionIds(body)
          const mode = normalizeMode(body, config)
          const includeMemory = normalizeBoolean(body, 'includeMemory')
          sendJson(res, 200, { ok: true, preview: await preview({ sessionIds, includeMemory, mode }) })
          return
        }
        if (path === '/delete') {
          const result = await serialize(() => deletePlan(body))
          // `ok` means "the plan was executed", not "every item succeeded".
          // A partial batch carries `results` + `failures`; marking the whole
          // response as an error hid those results and made the Client show
          // "The Host refused the request" while rows had already been deleted.
          sendJson(res, 200, { ok: true, partial: result.failures.length > 0, ...result })
          return
        }
        if (path === '/trash/restore') {
          const result = await serialize(() => restoreEntry(body?.trashId))
          sendJson(res, 200, { ok: true, ...result })
          return
        }
        if (path === '/trash/purge') {
          const result = await serialize(() => purgeEntry(body?.trashId, body?.confirmPhrase))
          sendJson(res, 200, { ok: true, ...result })
          return
        }
        if (path === '/trash/discard') {
          const result = await serialize(() => discardEntry(body?.trashId, body?.confirmPhrase))
          sendJson(res, 200, { ok: true, ...result })
          return
        }
        throw new DeleteError('E_NOT_FOUND', 'Unknown endpoint.', { path: path.slice(0, 120) })
      } catch (error) {
        const normalized = asDeleteError(error)
        logger.error?.(`[delete-conversation] ${method} ${path}: ${normalized.code} ${normalized.message}`)
        sendJson(res, normalized.httpStatus, toWireError(normalized))
      }
    })().catch((error) => {
      logger.error?.('[delete-conversation] route failure:', error)
      sendJson(res, 500, toWireError(asDeleteError(error)))
    })
  }

  return {
    handler,
    routePrefix: ROUTE_PREFIX,
    handler_services: { gateway, memoryService, trash, audit, limiter },
    // exported for tests
    __test: { preview, deletePlan, restoreEntry, purgeEntry, discardEntry, state, sessionsForUi, trashList, auditTail, issueConfirmation, validateConfirmation, markConfirmationUsed, expectedPhrase, effectiveBatchLimit },
  }
}
