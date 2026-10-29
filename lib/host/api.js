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
 *   POST /feedback                  email one feedback message to the operator
 *
 * `/feedback` is the only route that does not delete anything: it is the
 * Settings page's "反馈" button. It stays available when `enabled: false`
 * disables deletion (an operator may want feedback while the destructive half
 * is off), but it is disabled on its own by `feedback.transport`/the absence of
 * a configured mail transport.
 *
 * Transport layers, in order: this route's own loopback/origin fence, then DSH's
 * `connection` fence (`requestRejection`) when the service exists, then the
 * `connection/request` waterfall — which is what makes the desktop app-update
 * lock (503 + drain) cover deletions instead of killing them mid-transaction.
 * Mutations additionally take a cross-process lock on `<dataDir>/mutation.lock`
 * so two Hosts sharing one DSH_HOME cannot write the same manifest at once.
 *
 * Confirmation is a two-part server-side protocol, not a Client-side courtesy:
 * `/preview` issues a single-use token bound to (session ids, includeMemory,
 * mode); `/delete` must present that token. An additional typed phrase is
 * required only for a soft batch (double confirmation) and for purging a
 * recycle-bin entry (irreversible); permanent deletion itself is one click.
 * A replayed, edited or expired plan is refused.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DeleteError, ERROR_STATUS, asDeleteError, toWireError } from '../core/errors.js'
import { redactDetails } from '../core/redact.js'
import { createAuditLog } from '../core/audit.js'
import { DEFAULT_MAX_PER_RUN, DAY_MS, daysUntilExpiry, selectExpired } from '../core/retention.js'
import { createTrashStore, isTrashId } from '../core/trash.js'
import { createMemoryService } from '../core/memory/registry.js'
import { performSessionDelete, performPurge, performRestore, performDiscard, entryCapabilities } from '../core/cascade.js'
import { evaluateSessionPolicy, isPathInside } from '../core/policy.js'
import { createSlidingWindowLimiter } from '../core/rate-limit.js'
import { createFileLock } from '../core/file-lock.js'
import { createCatalogOps, createSessionLogOps } from './catalog.js'
import { createLifecycleOps } from './lifecycle.js'
import { createSessionGateway } from './gateway.js'
import { createMemoryAdapters } from './memory.js'
import { encodeSessionSegment, projectKey, readSessionLogCwd } from './paths.js'
import { createFeedbackService } from './feedback.js'
import { PLUGIN_VERSION } from '../version.js'
import { SESSION_ID_PATTERN } from '../core/ids.js'

export const ROUTE_PREFIX = '/conversation-recycle-bin/api'
export const REQUIRED_HEADER = 'x-conversation-recycle-bin'
const MAX_BODY_BYTES = 256 * 1024
/**
 * Lock wait budget for the single-entry trash mutations.
 *
 * `serialize()` chains every mutation in-process and then takes the
 * cross-process file lock, so restore / purge / discard can sit behind a whole
 * batch delete. They used to fall back to the generic 30s lock timeout, which
 * is shorter than one batch's legitimate worst case: the Host answered
 * E_LOCK_BUSY for a request that only needed to wait. The Client's own budget
 * (TRASH_MUTATION_TIMEOUT_MS = 195s) is deliberately slightly larger, so this
 * budget — not the browser's AbortController — decides the outcome.
 */
export const TRASH_LOCK_BUDGET_MS = 180_000

/**
 * Slack added on top of an operation's lock budget before a queued request is
 * rejected. The Host publishes the resulting number (`queueTimeoutMs`) so the
 * Client waits for the Host's answer instead of inventing a shorter deadline of
 * its own — a client that gave up 60 s early used to report a timeout for an
 * operation the Host then completed.
 */
export const QUEUE_GRACE_MS = 60_000

/** The wait a caller should allow for `lockBudgetMs` plus queueing behind it. */
export function queueBudgetFor(lockBudgetMs) {
  const budget = Number(lockBudgetMs)
  return (Number.isFinite(budget) && budget > 0 ? budget : 30_000) + QUEUE_GRACE_MS
}

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

/** Port of a `Host`-style authority, or `''` when none is present. */
function portOf(hostHeader) {
  const value = String(hostHeader ?? '').trim()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end === -1) return ''
    const rest = value.slice(end + 1)
    return rest.startsWith(':') && /^\d+$/.test(rest.slice(1)) ? rest.slice(1) : ''
  }
  const colon = value.lastIndexOf(':')
  return colon > 0 && /^\d+$/.test(value.slice(colon + 1)) ? value.slice(colon + 1) : ''
}

/**
 * Whether a request authority matches the operator's `allowedHosts` list.
 *
 * A bare entry (`app.example`) admits any port on that host; an entry with a
 * port admits only that port. Comparison is hostname-normalized (IPv6 brackets
 * and `::ffff:` mapped addresses included) so `[::1]:8443` and `[::1]:8443`
 * agree regardless of case.
 */
function authorityAllowed(hostHeader, allowedHosts) {
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) return false
  const hostname = hostnameOf(hostHeader)
  if (hostname === '') return false
  const port = portOf(hostHeader)
  for (const entry of allowedHosts) {
    if (typeof entry !== 'string') continue
    if (!sameHostname(hostnameOf(entry), hostname)) continue
    const entryPort = portOf(entry)
    if (entryPort === '' || entryPort === port) return true
  }
  return false
}

/** The port a URL implies when it omits one. */
function defaultPortFor(protocol) {
  if (protocol === 'https:' || protocol === 'wss:') return '443'
  return '80'
}

/**
 * Origin/Host verdict for one request.
 *
 * Hostname alone is not an origin: `http://localhost:9999` served by ANY other
 * loopback process used to pass a Host-name comparison, so a second local web
 * app could drive deletions. The full authority — hostname AND effective port —
 * must match, with a missing port normalized against the Origin's own scheme
 * (the `Host` header carries no scheme, so `https://host` and `Host: host`
 * both mean 443).
 * @returns {{ ok: true } | { ok: false, error: DeleteError }}
 */
export function requestOriginVerdict(headers, { requireSameOrigin, allowNonLoopback, allowedHosts = [] }) {
  const read = (name) => {
    if (headers === null || typeof headers !== 'object') return ''
    const value = headers[name]
    return typeof value === 'string' ? value : ''
  }
  const requestHostname = hostnameOf(read('host'))

  if (!allowNonLoopback && !isLoopbackHostname(requestHostname) && !authorityAllowed(read('host'), allowedHosts)) {
    return {
      ok: false,
      error: new DeleteError('E_FORBIDDEN_HOST', 'This route only accepts loopback requests unless the authority is listed in allowedHosts (or allowNonLoopback is enabled).', {
        host: read('host') || null,
        allowedHosts: Array.isArray(allowedHosts) ? allowedHosts : [],
      }),
    }
  }
  if (read('sec-fetch-site').trim().toLowerCase() === 'cross-site') {
    return { ok: false, error: new DeleteError('E_FORBIDDEN_ORIGIN', 'Cross-site requests are refused.', { reason: 'Sec-Fetch-Site: cross-site' }) }
  }
  if (requireSameOrigin) {
    const origin = read('origin').trim()
    if (origin !== '') {
      let parsed = null
      try {
        parsed = new URL(origin)
      } catch {
        parsed = null
      }
      // The Electron shell serves the app from `dsh-app://app` and the Host's
      // own fences compare against exactly this origin (verified in the shipped
      // app: `out/lib/main.js` refuses `origin !== "dsh-app://app"`). No web
      // origin can mint that scheme, so it is trusted as same-origin. On the
      // real desktop route the shell's forwarder deletes the `Origin` header
      // before the request reaches the Host, so this is defense-in-depth.
      const trustedAppShell = parsed !== null && parsed.protocol === 'dsh-app:' && parsed.hostname === 'app'
      if (trustedAppShell !== true) {
        const requestPort = portOf(read('host'))
        let hostnameMatches = false
        let portMatches = false
        if (parsed !== null) {
          hostnameMatches = parsed.hostname !== '' && sameHostname(parsed.hostname, requestHostname)
          // A missing request port falls back to the Origin's scheme default
          // (80/443) instead of matching every Origin port.
          const effectiveRequestPort = requestPort === '' ? defaultPortFor(parsed.protocol) : requestPort
          const originPort = parsed.port === '' ? defaultPortFor(parsed.protocol) : parsed.port
          portMatches = originPort !== '' && originPort === effectiveRequestPort
        }
        if (!hostnameMatches || !portMatches) {
          return { ok: false, error: new DeleteError('E_FORBIDDEN_ORIGIN', 'The request origin does not match this Host.', { origin }) }
        }
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
    let settled = false
    const chunks = []
    // The promise MUST settle on every path: an unsettled `/delete` inside
    // `serialize()` parks every later mutation behind it until the Host is
    // restarted. `aborted`/`close` fires when the Client disconnects mid-body
    // (its own timeout, or the tab/app closing) and `end` may never come.
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (error !== undefined) reject(error)
      else resolve(value)
    }
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (settled) return
      if (overflow) return
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > MAX_BODY_BYTES) {
        overflow = true
        chunks.length = 0
        // Respond at once instead of draining the whole oversized body; the
        // settled flag keeps the later `end` handler from double-settling.
        finish(new DeleteError('E_BAD_REQUEST', 'Request body exceeds the size limit.', { limit: MAX_BODY_BYTES }, { httpStatus: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (error) => {
      finish(new DeleteError('E_BAD_REQUEST', 'The request stream failed.', {}, { cause: error }))
    })
    req.on('aborted', () => {
      finish(new DeleteError('E_BAD_REQUEST', 'The request was aborted before its body arrived.', {}))
    })
    req.on('close', () => {
      // `close` after a complete `end` is the normal path; without it the
      // stream was cut short.
      if (!settled) {
        finish(new DeleteError('E_BAD_REQUEST', 'The request was closed before its body arrived.', {}))
      }
    })
    req.on('end', () => {
      if (overflow) {
        finish(new DeleteError('E_BAD_REQUEST', 'Request body exceeds the size limit.', { limit: MAX_BODY_BYTES }, { httpStatus: 413 }))
        return
      }
      const raw = chunks.join('').trim()
      if (raw === '') {
        finish(undefined, {})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          finish(new DeleteError('E_BAD_REQUEST', 'Request body must be a JSON object.', {}))
          return
        }
        finish(undefined, parsed)
      } catch (error) {
        finish(new DeleteError('E_BAD_REQUEST', 'Request body is not valid JSON.', {}, { cause: error }))
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
 * @param {{ acquire: () => Promise<() => Promise<void>>, lockPath?: string }} [input.mutationLock]
 *   Cross-process lock serializing mutations. Injectable so a test can drive the
 *   E_LOCK_BUSY path with a short wait budget; production uses 30s because a
 *   deletion transaction legitimately takes a while and waiting beats failing.
 */
export function createDeleteApi({ ctx, config, paths, now = Date.now, logger = console, mutationLock = null }) {
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
  // Feedback is its own subsystem: it never touches the trash, the audit trail
  // or the mutation lock, so a mail failure cannot leave a deletion half done.
  const feedbackService = createFeedbackService({ config, now, logger })
  // Two Hosts can share one DSH_HOME (the desktop app and `dsh web`), and both
  // write the same trash manifests, bundles and audit trail. The in-process
  // `serialize` chain below cannot see the other one, so every mutation also
  // takes a cross-process advisory lock on `<dataDir>/mutation.lock`. A busy
  // lock surfaces as E_LOCK_BUSY (409) instead of a lost manifest update.
  const mutationLockInstance = mutationLock ?? createFileLock({
    lockPath: join(paths.dataDir, 'mutation.lock'),
    timeoutMs: 30_000,
    staleMs: 120_000,
    // A lock file we cannot delete used to vanish into a silent `.catch`: the
    // next acquire then found it stale, failed to break it, and spun forever.
    warn: (message) => logger.warn?.(`[conversation-recycle-bin] ${message}`),
  })
  // Which UI asked: the desktop Electron shell and `dsh web` share this code,
  // and the audit trail used to record both as `web-ui`.
  const auditSource = process.versions?.electron !== undefined ? 'desktop-ui' : 'web-ui'
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
    /**
     * Reconstruct the original session-log location of an entry whose move
     * completed but whose manifest did not record it (a crash between
     * `moveDirectory` and `trash.update`). The log header still carries the
     * session's cwd, which is the only durable input needed to rebuild the
     * Host's project-directory path; a missing/unreadable header returns null
     * and the caller keeps refusing instead of guessing.
     */
    recoverSessionLog: async (entry) => {
      if (typeof entry?.sessionId !== 'string' || !SESSION_ID_PATTERN.test(entry.sessionId)) return null
      if (typeof entry?.trashId !== 'string' || !isTrashId(entry.trashId)) return null
      const sessionDir = join(trash.entryDir(entry.trashId), 'session')
      if (!(await readdir(sessionDir).catch(() => null))) return null
      const cwd = await readSessionLogCwd(sessionDir)
      if (cwd === null) return null
      const from = join(paths.sessionsRoot, projectKey(cwd), encodeSessionSegment(entry.sessionId))
      if (!isPathInside(paths.sessionsRoot, from) || !isPathInside(paths.trashDir, sessionDir)) return null
      return { sessionId: entry.sessionId, from, to: sessionDir }
    },
    // Manifest paths are data, not truth: a hand-edited manifest must not turn
    // "restore" into a proxy for stat/move on arbitrary directories.
    isInsideSessionsRoot: (target) => typeof target === 'string' && target !== '' && isPathInside(paths.sessionsRoot, target),
    isInsideTrashDir: (target) => typeof target === 'string' && target !== '' && isPathInside(paths.trashDir, target),
  }

  /** @type {Map<string, { planKey: string, sessionIds: string[], includeMemory: boolean, mode: 'soft'|'hard', phrase: string, issuedAt: number, expiresAt: number, used: boolean }>} */
  const confirmations = new Map()
  let mutationChain = Promise.resolve()
  let requestCounter = 0
  // `/trash` reads and parses every manifest on disk; a short TTL cache keeps
  // the settings page responsive while every mutation invalidates it, so the
  // user never sees a stale list after their own action.
  const TRASH_CACHE_TTL_MS = 1_500
  // Retention is a background chore, not a request: at most one sweep every
  // five minutes (a `/trash` poll must not rescan the whole bin each time), and
  // at most this many entries per sweep so one huge bin cannot hold the
  // mutation lock for minutes.
  const RETENTION_SWEEP_THROTTLE_MS = 300_000
  const RETENTION_MAX_PER_RUN = DEFAULT_MAX_PER_RUN
  // An entry that cannot be purged (busy lock, a half-written bundle) used to be
  // retried every five minutes forever, writing a warn and an audit record each
  // time. Failures now back off exponentially, capped at six hours.
  const RETENTION_RETRY_BASE_MS = 300_000
  const RETENTION_RETRY_MAX_MS = 21_600_000
  let lastRetentionSweepAt = 0
  /** @type {{ at: number, purged: number, failed: number }|null} */
  let lastRetentionResult = null
  let retentionSweepInFlight = null
  /** @type {Map<string, { failures: number, nextAt: number }>} */
  const retentionRetries = new Map()
  let trashCache = null
  let trashCachedAt = 0
  function invalidateTrashCache() {
    trashCache = null
    trashCachedAt = 0
  }

  /**
   * Serialize one mutation: in-process first (so two HTTP requests never
   * interleave their transactions), then across processes (so a second Host
   * sharing this DSH_HOME cannot write the same manifest concurrently).
   *
   * The in-process queue is bounded too. It used to be an unbounded promise
   * chain: a request whose client had already given up still ran minutes
   * later, and one stuck holder hung every later mutation forever. Now:
   *   - `shouldAbort` is checked before the operation runs (twice: when the
   *     chain reaches us and again after the cross-process lock), so a client
   *     that disconnected changes nothing;
   *   - the wait has a budget derived from the operation's own lock budget
   *     plus a grace period, so it can never fire before a legitimate holder
   *     finishes, and never waits forever either.
   */
  function serialize(operation, { lockTimeoutMs, shouldAbort } = {}) {
    const queueBudgetMs = queueBudgetFor(lockTimeoutMs === undefined ? 30_000 : lockTimeoutMs)
    let abandoned = false
    // Once the operation itself starts, the queue timer stops: from that moment
    // the outcome belongs to the operation, and answering "not applied" would be
    // a lie (the purge/restore may well have happened). The budget therefore
    // covers the wait, which is the only part this function can honestly abort.
    let started = false
    let timer = null
    const aborted = () => typeof shouldAbort === 'function' && shouldAbort() === true
    const next = mutationChain.then(async () => {
      if (abandoned) {
        throw new DeleteError('E_QUEUE_TIMEOUT', 'The recycle bin was busy; this request was not applied. Retry.', {})
      }
      if (aborted()) {
        throw new DeleteError('E_ABANDONED', 'The client disconnected before this request ran; nothing was changed.', {})
      }
      // The lock lives in the data dir, which a fresh install has not created
      // yet (the trash store and audit log mkdir their own targets lazily).
      await mkdir(paths.dataDir, { recursive: true }).catch(() => {})
      let release
      try {
        release = await mutationLockInstance.acquire(lockTimeoutMs === undefined ? {} : { timeoutMs: lockTimeoutMs })
      } catch (error) {
        if (error?.code === 'E_LOCK_BUSY') {
          throw new DeleteError('E_LOCK_BUSY', 'Another DSH instance is using this recycle bin; retry in a moment.', {})
        }
        throw error
      }
      try {
        // Queued behind the lock: the caller may have gone in the meantime.
        if (aborted()) {
          throw new DeleteError('E_ABANDONED', 'The client disconnected before this request ran; nothing was changed.', {})
        }
        started = true
        if (timer !== null) clearTimeout(timer)
        return await operation()
      } finally {
        await release()
      }
    })
    mutationChain = next.then(() => undefined, () => undefined)
    return new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (started) return
        abandoned = true
        reject(
          new DeleteError(
            'E_QUEUE_TIMEOUT',
            'The recycle bin stayed busy for too long; this request was not applied. Retry.',
            { waitedMs: queueBudgetMs },
          ),
        )
      }, queueBudgetMs)
      if (typeof timer.unref === 'function') timer.unref()
      next.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  function requestId() {
    requestCounter += 1
    return `dc-${now().toString(36)}-${requestCounter.toString(36)}-${randomBytes(2).toString('hex')}`
  }

  /**
   * True once the HTTP client has gone away. Mutations consult this before they
   * touch disk: a request the user cancelled (or a tab that closed) must not
   * delete a conversation afterwards.
   */
  function clientGone(req, res) {
    // Only signals that survive a normal, fully-read request count here.
    // `req.destroyed` is NOT one of them: Node's IncomingMessage auto-destroys
    // its readable side once the body is consumed, so it is `true` on every
    // healthy POST after the body has been read (measured on Node 24:
    // `{req.destroyed:true, req.aborted:false, req.complete:true,
    // res.destroyed:false, res.socket.destroyed:false}`). Using it rejected
    // every deletion with E_ABANDONED in 0.3.8.
    if (res?.destroyed === true) return true
    if (res?.writableEnded === true) return true
    const socket = res?.socket ?? req?.socket
    if (socket !== null && socket !== undefined && socket.destroyed === true) return true
    return false
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

    // When every session is blocked there is no plan to execute, so the memory
    // count (index reads + parsing) is skipped rather than computed for nothing.
    const emptyMemory = { total: 0, bySession: Object.fromEntries(sessionIds.map((id) => [id, 0])), protected: 0, adapters: [] }
    const memory = !config.memory.enabled
      ? { ...emptyMemory, disabled: true }
      : blocked.length === 0
        ? await memoryService.countForSessions(sessionIds)
        : { ...emptyMemory, skipped: true }
    const adapterStates = await memoryService.status()
    const confirmation = blocked.length === 0 ? issueConfirmation({ sessionIds, includeMemory, mode }) : null

    // Worst-case wall time for the matching `/delete`: one lock acquisition,
    // plus per live session a bounded drain, plus per session the memory
    // export/restore under the plugin-private lock. The Client MUST use this
    // instead of its own estimate, otherwise it aborts while the Host is still
    // deleting and retries into an in-flight transaction.
    const liveCount = sessions.filter((item) => item.live === true).length
    const planTimeoutMs = Math.min(900_000, 15_000 + sessionIds.length * 16_000 + liveCount * config.liveDrainMs)

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
        planTimeoutMs,
        // How long the Client should wait for the answer: the plan's own lock
        // budget plus the queueing grace. The Client used to derive a shorter
        // number and give up 60 s before the Host finished.
        queueTimeoutMs: queueBudgetFor(planTimeoutMs),
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
          source: auditSource,
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

    // Budget is consumed per actually-attempted deletion: a failed item must
    // not silently spend the minute quota it never used. The very first item
    // still refuses outright with 429 (the existing contract); once a plan
    // has started, later exhausted items are recorded as failures.
    //
    // A refusal inside the loop uses `continue`, never `break`: `break` used
    // to drop every session after the exhausted one from both `results` and
    // `failures`, so a batch of 50 with a 20/min budget left items 22-50
    // looking like the plan never mentioned them. Under the per-plan
    // serialize this is still visible via `maxBatchSessions` > budget.
    const request = requestId()
    const results = []
    const failures = []
    for (const session of sessions) {
      const reservation = limiter.take(1)
      if (!reservation.ok) {
        const rateError = new DeleteError('E_RATE_LIMITED', `Too many deletions; retry in ${Math.ceil(reservation.retryAfterMs / 1000)}s.`, {
          retryAfterMs: reservation.retryAfterMs,
          limit: reservation.limit,
        })
        if (results.length === 0 && failures.length === 0) throw rateError
        failures.push({ sessionId: session.id, error: rateError.toJSON() })
        continue
      }
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
          source: auditSource,
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
        // The deletion never happened: refund the slot so a failed item does
        // not consume the per-minute quota of a successful one.
        reservation.release()
        const normalized = asDeleteError(error)
        failures.push({ sessionId: session.id, error: normalized.toJSON() })
        logger.error?.(`[conversation-recycle-bin] delete failed for ${session.id}: ${normalized.message}`)
      }
    }
    gateway.invalidate()
    invalidateTrashCache()

    // The token is burned only once the whole plan went through. It used to be
    // marked used before the first item, so a batch that failed halfway left the
    // user holding a dead token: the remaining sessions could not be retried
    // without previewing again and retyping the confirmation phrase. The token
    // is bound to (ids, mode, includeMemory), so a retry can only replay this
    // same plan — already-deleted sessions answer E_NOT_FOUND, never a second
    // deletion.
    if (failures.length === 0) markConfirmationUsed(validated)
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
    const result = await performRestore({ entry, ops, trash, audit, now, actor: 'local-user', source: auditSource, requestId: requestId() })
    gateway.invalidate()
    invalidateTrashCache()
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
    const result = await performPurge({ entry, ops, trash, audit, now, actor: 'local-user', source: auditSource, requestId: requestId() })
    gateway.invalidate()
    invalidateTrashCache()
    return result
  }

  /**
   * Remove an entry that never committed (failed / pending / interrupted).
   * These used to be invisible in the UI and rejected by both restore and
   * purge, so they stayed on disk forever.
   */
  async function discardEntry(trashId, confirmPhrase) {
    if (typeof trashId !== 'string' || trashId === '') throw new DeleteError('E_BAD_REQUEST', 'A recycle-bin id is required.', {})
    // Validate before anything joins it into a path. `trash.read` answers null
    // for a malformed id, which used to fall through to the "directory may
    // still be on disk" branch below and turn this into an arbitrary-path
    // existence probe.
    if (!isTrashId(trashId)) throw new DeleteError('E_BAD_REQUEST', 'The recycle-bin id is malformed.', {})
    if (typeof confirmPhrase !== 'string' || confirmPhrase.trim() !== 'DELETE') {
      throw new DeleteError('E_CONFIRM_PHRASE', 'Type “DELETE” to discard this incomplete entry.', { expected: 'DELETE' })
    }
    let entry = await trash.read(trashId)
    if (entry === null) {
      // Missing/corrupt manifest: the directory itself may still be on disk.
      // Verify it exists, then discard against the actual payload; the disk
      // checks inside performDiscard still refuse a folder holding a log or
      // memory files, so a stranded directory can be cleaned without ever
      // trusting the unreadable manifest.
      const dir = join(paths.trashDir, trashId)
      if (!(await ops.pathExists(dir))) {
        throw new DeleteError('E_TRASH_NOT_FOUND', 'The recycle-bin entry was not found.', { trashId })
      }
      entry = {
        trashId,
        sessionId: null,
        title: null,
        mode: null,
        includeMemory: false,
        deletedAt: 0,
        updatedAt: 0,
        status: 'unreadable',
        memory: { adapters: [], total: 0 },
        sessionLog: null,
        catalog: null,
      }
    }
    const result = await performDiscard({ entry, ops, trash, audit, now, actor: 'local-user', source: auditSource, requestId: requestId() })
    invalidateTrashCache()
    return result
  }

  async function state() {
    // Only wire fields the Client renders; adapter `storePath` is an absolute
    // filesystem handle and must not leave the Host.
    const adapters = (await memoryService.status()).map(({ id, label, available, reason }) => ({ id, label, available, reason }))
    return {
      enabled: config.enabled,
      version: PLUGIN_VERSION,
      // The Client cannot tell a broken deployment from a broken permission
      // otherwise: with `requireConnection` on and no service mounted, every
      // route answers 401 and the panel just looked empty.
      connectionFence: connectionFencePresent(),
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
        // Trash mutations take the fixed trash budget; the Client waits for it
        // instead of using its generic request timeout.
        queueTimeoutMs: queueBudgetFor(TRASH_LOCK_BUDGET_MS),
      },
      ui: config.ui,
      feedback: feedbackService.status(),
    }
  }

  async function sessionsForUi() {
    const sessions = await gateway.list()
    await gateway.enrichTitles(sessions)
    // Every row carries its own policy verdict: "select all" used to include
    // subagent/orphan/out-of-root conversations that `/preview` then refuses
    // as a whole batch, leaving the user with a disabled button and no hint
    // which row to uncheck. Judge with the configured default mode (the mode
    // the dialog opens in): with `stopLiveSessions: false`, hard is stricter
    // than soft for live sessions, so a fixed soft verdict would mark those
    // rows deletable only for the server to refuse later.
    return sessions.map((session) => {
      const verdict = evaluateSessionPolicy({ session, workspace: session.workspace, live: session.live, mode: config.defaultMode, config })
      return {
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
        deletable: verdict.ok,
        policy: verdict.ok
          ? { ok: true, warnings: verdict.warnings }
          : { ok: false, code: verdict.error.code, message: verdict.error.message },
      }
    })
  }

  /** Ordered map with at most `limit` filesystem probes in flight. */
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

  /** Disk payload of one entry, for the capability flags the Client renders. */
  async function entryDisk(trashId) {
    if (!isTrashId(trashId)) return { hasLogFiles: false, hasMemoryFiles: false }
    let dir
    try {
      dir = trash.entryDir(trashId)
    } catch {
      return { hasLogFiles: false, hasMemoryFiles: false }
    }
    return {
      hasLogFiles: await ops.pathExists(join(dir, 'session')),
      hasMemoryFiles: await ops.hasFiles(join(dir, 'memory')),
    }
  }

  async function serializeEntry(entry) {
    const retentionDays = config.trashRetentionDays
    // The Client must not recompute the window from `deletedAt`: a browser clock
    // that is a day off would shift the promise the Host actually keeps. The
    // countdown is therefore decided here, once, by the same predicate the sweep
    // uses (`daysUntilExpiry`), and `expiresAt` carries the absolute deadline.
    const daysLeft = daysUntilExpiry(entry, { retentionDays, now: now() })
    const disk = await entryDisk(entry.trashId)
    return {
      trashId: entry.trashId,
      sessionId: entry.sessionId,
      title: entry.title,
      mode: entry.mode,
      includeMemory: entry.includeMemory,
      deletedAt: entry.deletedAt,
      updatedAt: entry.updatedAt,
      daysLeft,
      expiresAt: daysLeft === null ? null : entry.deletedAt + Number(retentionDays) * DAY_MS,
      memory: entry.memory?.total ?? 0,
      memoryAdapters: Array.isArray(entry.memory?.adapters) ? entry.memory.adapters : [],
      hasSessionLog: entry.sessionLog !== null && entry.sessionLog !== undefined,
      status: entry.status,
      // The UI renders buttons from the same predicate the routes enforce. Disk
      // payload is part of that predicate: a manifest can be empty while the
      // moved log/memory copy is still on disk, and a status-only answer
      // advertised actions the routes refused.
      capabilities: entryCapabilities(entry, { ...disk, requirePayload: true }),
      error: entry.error ?? null,
    }
  }

  /** A folder whose manifest cannot be read still has a reliable disk payload. */
  async function serializeUnreadable(item) {
    const disk = await entryDisk(item.trashId)
    return {
      trashId: item.trashId,
      sessionId: null,
      title: null,
      mode: null,
      includeMemory: false,
      deletedAt: 0,
      updatedAt: 0,
      memory: 0,
      memoryAdapters: [],
      hasSessionLog: false,
      status: 'unreadable',
      capabilities: entryCapabilities({ status: 'unreadable' }, disk),
      error: {
        code: item.reason,
        message: 'The manifest could not be read; discard this folder only after confirming it holds no log or memory files.',
      },
    }
  }

  async function trashList() {
    // The retention sweep is kicked off, not awaited: it needs the mutation lock
    // (a purge in flight can hold it for minutes), and a GET must never block on
    // a write or delete the rows this very response is about to describe. Its
    // outcome is reported separately as `lastSweep`.
    void sweepExpiredTrash().catch(() => {})
    if (trashCache !== null && now() - trashCachedAt < TRASH_CACHE_TTL_MS) return trashCache
    // Every readable manifest is returned: `trashed` entries are the usable
    // recycle bin, while failed/pending/restoring/purging entries used to be
    // invisible and impossible to clean up at all. Directories whose manifest
    // is missing/corrupt are surfaced as `unreadable` so they are not stranded
    // on disk; the Client renders both groups separately.
    const { entries: all, unreadable } = await trash.scanAll()
    const trashed = all.filter((entry) => entry.status === 'trashed')
    const incompleteEntries = all.filter((entry) => entry.status !== 'trashed')
    const [entries, incomplete, unreadableRows] = await Promise.all([
      mapLimit(trashed, 8, serializeEntry),
      mapLimit(incompleteEntries, 8, serializeEntry),
      mapLimit(unreadable, 8, serializeUnreadable),
    ])
    const result = {
      entries,
      incomplete: [...incomplete, ...unreadableRows],
      // What the background sweep did last time, so entries that vanished can be
      // explained instead of looking like a bug. `null` until the first sweep.
      lastSweep: lastRetentionResult,
    }
    trashCache = result
    trashCachedAt = now()
    return result
  }

  /**
   * Automatic retention: purge entries that have been in the recycle bin for
   * more than `trashRetentionDays` days.
   *
   * The sweep runs under the same `serialize` lock as a user mutation, so it
   * can never interleave with a restore/purge of the same entry, and it re-reads
   * each manifest under that lock (the scan that selected the candidates ran
   * outside it). `force` exists for tests and for a Host that just started;
   * production callers use the throttle so a `/trash` poll cannot turn into a
   * scan-and-purge loop.
   *
   * Failure policy: one un-purgeable entry never aborts the sweep. The cascade
   * already wrote its own `purge:failed` audit record, and the entry stays in
   * the bin for the next run or for the user.
   */
  async function sweepExpiredTrash({ force = false } = {}) {
    // `enabled: false` is documented as the master switch, and every route
    // honours it with 503. A background chore that kept deleting entries while
    // the UI is unreachable would be the one path that contradicts it: the user
    // could neither see nor stop the deletion.
    if (config.enabled !== true) {
      return { enabled: false, purged: [], failed: [], retentionDays: 0 }
    }
    const retentionDays = config.trashRetentionDays
    if (!(Number(retentionDays) > 0)) return { enabled: false, purged: [], failed: [], retentionDays: 0 }
    if (retentionSweepInFlight !== null) return retentionSweepInFlight
    if (force !== true && now() - lastRetentionSweepAt < RETENTION_SWEEP_THROTTLE_MS) {
      return { skipped: true, purged: [], failed: [], retentionDays }
    }
    const run = (async () => {
      const scannedAt = now()
      const { entries } = await trash.scanAll()
      const expired = selectExpired(entries, { retentionDays, now: scannedAt, limit: RETENTION_MAX_PER_RUN })
        .filter((candidate) => {
          const retry = retentionRetries.get(candidate.trashId)
          return retry === undefined || retry.nextAt <= scannedAt
        })
      if (expired.length === 0) return { purged: [], failed: [], retentionDays }
      return serialize(async () => {
        const purged = []
        const failed = []
        for (const candidate of expired) {
          const entry = await trash.read(candidate.trashId)
          if (entry === null || !entryCapabilities(entry).canPurge) continue
          // A soft entry's log stays on disk, so "the session can still be
          // inspected" is its NORMAL state and must not block retention. Only a
          // conversation the user actually revived (unarchived) or one that is
          // running is left alone: purging it unattended would quiesce and
          // hard-delete the conversation the user is working in. Retention is a
          // janitor, not a killer.
          //
          // `archived` unknown (older Host shape, unreadable workspace state)
          // stays conservative: skip and let the user decide.
          if (entry.mode === 'soft' && typeof entry.sessionId === 'string' && entry.sessionId !== '') {
            let session = null
            try {
              session = await gateway.inspect(entry.sessionId)
            } catch {
              // Cannot decide whether it is back: refusing to purge is the safe
              // answer, and the retry policy keeps it out of the hot path.
              session = { unreadable: true }
            }
            if (session !== null && session !== undefined) {
              const revived = session.archived === false
              const running = session.running === true || session.live === true || session.unreadable === true
              if (revived || running || session.archived !== true) {
                failed.push({ trashId: candidate.trashId, code: 'E_SESSION_ALIVE' })
                continue
              }
            }
          }
          try {
            await performPurge({ entry, ops, trash, audit, now, actor: 'local-user', source: 'retention', requestId: requestId() })
            purged.push(entry.trashId)
            retentionRetries.delete(entry.trashId)
          } catch (error) {
            const normalized = asDeleteError(error)
            failed.push({ trashId: candidate.trashId, code: normalized.code })
            const failures = (retentionRetries.get(candidate.trashId)?.failures ?? 0) + 1
            const delay = Math.min(RETENTION_RETRY_BASE_MS * 2 ** (failures - 1), RETENTION_RETRY_MAX_MS)
            retentionRetries.set(candidate.trashId, { failures, nextAt: now() + delay })
            logger.warn?.(`[conversation-recycle-bin] retention: ${candidate.trashId} could not be purged (${normalized.code}); next attempt in ${Math.round(delay / 60_000)} min`)
          }
        }
        if (purged.length > 0) {
          gateway.invalidate()
          invalidateTrashCache()
        }
        return { purged, failed, retentionDays }
      }, { lockTimeoutMs: TRASH_LOCK_BUDGET_MS })
    })()
      .catch((error) => {
        // A busy lock or a crashed scan is not an error the user can act on:
        // record it and let the next sweep try again.
        const normalized = asDeleteError(error)
        logger.warn?.(`[conversation-recycle-bin] retention sweep skipped (${normalized.code})`)
        return { purged: [], failed: [{ trashId: null, code: normalized.code }], retentionDays }
      })
      .then((result) => {
        lastRetentionResult = { at: now(), purged: result.purged?.length ?? 0, failed: result.failed?.length ?? 0 }
        return result
      })
      .finally(() => {
        retentionSweepInFlight = null
        lastRetentionSweepAt = now()
      })
    retentionSweepInFlight = run
    return run
  }

  async function auditTail(limit) {
    const parsed = Number.parseInt(String(limit ?? '50'), 10)
    const safe = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50
    const result = await audit.tail(safe)
    // The audit file is on disk in full; the wire copy still must not carry
    // absolute host paths. `redactDetails` shortens path-like keys and strips
    // absolute paths out of prose, leaving ids/codes/counts intact.
    return { records: redactDetails(result.records), malformed: result.malformed }
  }

  /**
   * The plugin's own transport fence: loopback-only unless `allowNonLoopback`,
   * no cross-site requests, and — when `requireSameOrigin` — an Origin whose
   * full authority (hostname AND effective port) matches the request Host, or
   * the desktop `dsh-app://app` shell origin.
   *
   * This is the FIRST gate. The `connection` fence in `handler` is
   * authoritative when present; this one keeps the route safe in a composition
   * without it and produces the localized error codes the Client knows.
   */
  function transportVerdict(req) {
    return requestOriginVerdict(req.headers, config)
  }

  /** Read the connection service without declaring it a hard dependency. */
  function connectionService() {
    try {
      const value = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection
      return value ?? undefined
    } catch {
      return undefined
    }
  }

  /**
   * True when a real `connection` service is mounted. Probed rather than
   * injected: a composition without it must still load.
   */
  function connectionFencePresent() {
    const connection = connectionService()
    return connection !== undefined && typeof connection.requestRejection === 'function'
  }

  /** `/state` (or the bare prefix) as a GET — the only route readable without a connection fence. */
  function isStateProbe(req) {
    if (String(req.method ?? 'GET').toUpperCase() !== 'GET') return false
    const pathname = new URL(req.url ?? '/', 'http://host.invalid').pathname
    const path = pathname.startsWith(ROUTE_PREFIX) ? pathname.slice(ROUTE_PREFIX.length) : pathname
    return path === '' || path === '/state'
  }

  /** One request → one response. Route matching stays here, not in `apply`. */
  const handleRequest = async (req, res) => {
    const method = String(req.method ?? 'GET').toUpperCase()
    const url = new URL(req.url ?? '/', 'http://host.invalid')
    const path = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) : url.pathname

    const origin = transportVerdict(req)
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
      // A GET that matched no route is an unknown endpoint (404), not a 405:
      // 405 is reserved for non-POST verbs on a mounted prefix.
      if (method === 'GET') {
        throw new DeleteError('E_NOT_FOUND', 'Unknown endpoint.', { path: path.slice(0, 120) })
      }
      if (method !== 'POST') {
        throw new DeleteError('E_BAD_REQUEST', 'This endpoint accepts POST requests only.', {}, { httpStatus: 405 })
      }
      const header = req.headers?.[REQUIRED_HEADER]
      if (header !== '1') {
        throw new DeleteError('E_FORBIDDEN_ORIGIN', 'Missing the plugin request header.', {})
      }
      if (!config.enabled && path !== '/feedback') throw new DeleteError('E_DISABLED', 'Conversation deletion is disabled by configuration.', {})
      const body = await readJsonBody(req)

      // Feedback is available even when deletion is switched off: the two
      // switches answer different questions, and a broken mail transport
      // must not be reported as "deletion disabled".
      if (path === '/feedback') {
        const result = await feedbackService.submit(body)
        sendJson(res, 200, { ok: true, ...result })
        return
      }

      if (path === '/preview') {
        const sessionIds = normalizeSessionIds(body)
        const mode = normalizeMode(body, config)
        const includeMemory = normalizeBoolean(body, 'includeMemory')
        sendJson(res, 200, { ok: true, preview: await preview({ sessionIds, includeMemory, mode }) })
        return
      }
      if (path === '/delete') {
        // Upper-bound lock wait mirroring preview's planTimeoutMs: a 50-item
        // batch legitimately outlives the default 30s, so a second Host waiting
        // on the lock should not be told "busy" while the first is still
        // working. Per-session export/restore plus a bounded live drain each.
        const rawIds = Array.isArray(body?.sessionIds)
          ? body.sessionIds
          : typeof body?.sessionId === 'string'
            ? [body.sessionId]
            : []
        const batchCount = Math.max(1, rawIds.length)
        const lockBudget = Math.min(900_000, 15_000 + batchCount * 16_000 + batchCount * config.liveDrainMs)
        const result = await serialize(() => deletePlan(body), {
          lockTimeoutMs: lockBudget,
          shouldAbort: () => clientGone(req, res),
        })
        // `ok` means "the plan was executed", not "every item succeeded".
        // A partial batch carries `results` + `failures`; marking the whole
        // response as an error hid those results and made the Client show
        // "The Host refused the request" while rows had already been deleted.
        sendJson(res, 200, { ok: true, partial: result.failures.length > 0, ...result })
        return
      }
      if (path === '/trash/restore') {
        const result = await serialize(() => restoreEntry(body?.trashId), {
          lockTimeoutMs: TRASH_LOCK_BUDGET_MS,
          shouldAbort: () => clientGone(req, res),
        })
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      if (path === '/trash/purge') {
        const result = await serialize(() => purgeEntry(body?.trashId, body?.confirmPhrase), {
          lockTimeoutMs: TRASH_LOCK_BUDGET_MS,
          shouldAbort: () => clientGone(req, res),
        })
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      if (path === '/trash/discard') {
        const result = await serialize(() => discardEntry(body?.trashId, body?.confirmPhrase), {
          lockTimeoutMs: TRASH_LOCK_BUDGET_MS,
          shouldAbort: () => clientGone(req, res),
        })
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      throw new DeleteError('E_NOT_FOUND', 'Unknown endpoint.', { path: path.slice(0, 120) })
    } catch (error) {
      const normalized = asDeleteError(error)
      logger.error?.(`[conversation-recycle-bin] ${method} ${path}: ${normalized.code} ${normalized.message}`)
      sendJson(res, normalized.httpStatus, toWireError(normalized))
    }
  }

  /**
   * Route entry point.
   *
   * The plugin mounts a `webServer` prefix directly, so it does NOT pass
   * through `/api` and therefore bypasses DSH's `connection` layer by default.
   * That layer is not cosmetic: `connection.admit()` applies the Host/Origin
   * fence and the browser-session admission, and the desktop update task
   * control listens on `connection/request` to refuse new requests (503) and
   * drain in-flight ones while an app update installs. Without participating,
   * an update or a quit could kill a Host in the middle of a deletion
   * transaction.
   *
   * The service is probed, not injected. With `requireConnection` (the default)
   * a composition that has no `connection` service refuses every mutation
   * instead of silently degrading to the loopback/origin fence alone — that
   * fence cannot tell one local process from another, so "no connection layer"
   * means "any process on this machine can delete". Operators who deliberately
   * run such a composition set `requireConnection: false`.
   */
  const handler = (req, res) => {
    void (async () => {
      const connection = connectionService()
      const hasConnectionFence = connectionFencePresent()
      if (!hasConnectionFence && config.requireConnection !== false) {
        // `/state` stays readable: it carries no conversation data (limits,
        // adapters, switches) and it is how the panel explains why everything
        // else is refused. Every other route — including the session list and
        // the trash — stays 401, because the remaining fence cannot tell one
        // local process from another.
        if (isStateProbe(req)) {
          const origin = transportVerdict(req)
          if (!origin.ok) {
            sendJson(res, origin.error.httpStatus, toWireError(origin.error))
            return
          }
          sendJson(res, 200, { ok: true, state: await state() })
          return
        }
        logger.error?.('[conversation-recycle-bin] no connection service; refusing request because requireConnection is enabled')
        sendJson(res, 401, toWireError(new DeleteError('E_UNAUTHORIZED', 'This Host has no connection layer to authenticate the request; set requireConnection: false to allow it.', {})))
        return
      }
      if (hasConnectionFence) {
        let rejection
        try {
          rejection = connection.requestRejection(req)
        } catch (error) {
          // Fail closed. A connection layer that throws cannot be read as
          // "no opinion": letting the request through here would turn any
          // auth-layer fault into an unauthenticated delete.
          logger.error?.('[conversation-recycle-bin] connection check failed:', error)
          sendJson(res, 503, toWireError(new DeleteError('E_INTERNAL', 'The Host could not verify this request.', {})))
          return
        }
        // The documented contract is `401`, `403`, or undefined for "allowed".
        // Anything else (including a future `503`-style value) is a refusal:
        // only an explicit absence of a verdict lets the request through.
        if (rejection !== undefined && rejection !== null) {
          if (rejection === 401) {
            sendJson(res, 401, toWireError(new DeleteError('E_UNAUTHORIZED', 'This request is not authenticated with the Host.', {})))
            return
          }
          if (rejection === 403) {
            sendJson(res, 403, toWireError(new DeleteError('E_FORBIDDEN_ORIGIN', 'The Host refused this request at the connection layer.', {})))
            return
          }
          sendJson(res, 503, toWireError(new DeleteError('E_INTERNAL', 'The Host could not verify this request.', { verdict: rejection })))
          return
        }
      }
      const run = () => handleRequest(req, res)
      if (typeof ctx.waterfall === 'function') {
        // Listeners (e.g. the desktop update lock) run outermost-first and may
        // veto by never calling `next()`; when none is registered the built-in
        // `run` executes directly.
        await ctx.waterfall('connection/request', req, res, run)
      } else {
        await run()
      }
    })().catch((error) => {
      logger.error?.('[conversation-recycle-bin] route failure:', error)
      sendJson(res, 500, toWireError(asDeleteError(error)))
    })
  }

  return {
    handler,
    routePrefix: ROUTE_PREFIX,
    /**
     * Run one retention sweep. Called by the Host timer in `index.js` and by
     * `/trash` (throttled); exposed so the entry point does not need to know
     * how the sweep selects its candidates.
     */
    sweepExpiredTrash,
    handler_services: { gateway, memoryService, trash, audit, limiter, feedbackService },
    // exported for tests
    __test: { preview, deletePlan, restoreEntry, purgeEntry, discardEntry, state, sessionsForUi, trashList, auditTail, sweepExpiredTrash, issueConfirmation, validateConfirmation, markConfirmationUsed, expectedPhrase, effectiveBatchLimit, feedbackService },
  }
}
