/**
 * Host configuration: defaults, normalization and validation.
 *
 * This package intentionally has no dependency on a schema runtime, so the row
 * config is validated here instead of through an exported `Config` schema. The
 * product of this function is the ONLY config object the rest of the plugin
 * reads, which makes defaults, coercion and warnings one testable unit.
 * `config.schema.json` documents the same contract for human editors.
 */

/** Built-in defaults, also the `cordis.patch.yml` defaults layer. Deep-frozen. */
export const DEFAULTS = deepFreeze({
  enabled: true,
  requireSameOrigin: true,
  allowNonLoopback: false,
  allowOrphanSessions: false,
  allowSubagentSessions: false,
  // Hard deletion of a live session first stops it (cancel turn + archive
  // `stopActivity`) and waits up to liveDrainMs for the turn to settle. Set
  // `stopLiveSessions: false` to refuse live sessions outright instead.
  stopLiveSessions: true,
  liveDrainMs: 2_000,
  // Hard deletion is a move of the session log. A second DSH Host (desktop and
  // `dsh web` share one DSH_HOME) keeps its own live-session table, so a log
  // can be written by a process this plugin cannot see. Before moving, the
  // newest log mtime is re-checked after this grace window; a log that keeps
  // growing is refused instead of being moved under the writer.
  foreignWriterGraceMs: 1_500,
  protectedSessionIds: [],
  allowedWorkspaceRoots: [],
  defaultMode: 'soft',
  trashRetentionDays: 30,
  maxBatchSessions: 50,
  maxDeletesPerMinute: 20,
  confirmTokenTtlMs: 120_000,
  auditRetentionLines: 5_000,
  auditMaxBytes: 5 * 1024 * 1024,
  memory: {
    enabled: true,
    adapters: ['lingshu', 'generic-json', 'none'],
    lingshu: { rootDir: null },
    generic: { indexFile: null, rootDir: null, sessionField: 'session', nodesPointer: '/nodes' },
    deleteMode: 'trash',
  },
  ui: {
    showRowAction: true,
    showHeaderAction: true,
    batchDoubleConfirm: true,
  },
  // Email feedback channel. `to` is the maintainer inbox this plugin ships
  // with — a public bug-report address, exactly like a link in a README, so a
  // fresh install has somewhere to send feedback. It is stored as
  // `b64:<base64>` so a published tarball does not expose a greppable address
  // (obfuscation, not encryption: the decoder ships with the package) and is
  // decoded in host/feedback.js. `DSH_CRB_FEEDBACK_TO` / `DSH_CRB_FEEDBACK_FROM`
  // still win over it, and `from` is usually left empty so the SMTP connection
  // URL's username is reused. Credentials are environment-only by design.
  feedback: {
    enabled: true,
    to: 'b64:MzQzMzI3NjU3N0BxcS5jb20=',
    from: '',
    transport: 'auto',
    rateLimitPerHour: 5,
    // The visitor's own address always travels in `Reply-To`. Setting this to
    // true also puts it into `From`, which only works on relays that allow an
    // arbitrary sender; QQ/163/Gmail reject it because `From` must equal the
    // authenticated account.
    visitorAsFrom: false,
  },
})

const MODES = new Set(['soft', 'hard'])
const ADAPTER_IDS = new Set(['lingshu', 'generic-json', 'none'])
const MEMORY_DELETE_MODES = new Set(['trash', 'keep'])
const FEEDBACK_TRANSPORTS = new Set(['auto', 'smtp', 'http', 'off'])

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function clampInt(raw, fallback, min, max, field, warnings) {
  if (raw === undefined) return fallback
  const number = typeof raw === 'number' ? raw : Number.NaN
  if (!Number.isFinite(number)) {
    warnings.push(`${field}: expected a number, using ${fallback}`)
    return fallback
  }
  const rounded = Math.round(number)
  if (rounded < min || rounded > max) {
    warnings.push(`${field}: ${rounded} outside [${min}, ${max}], clamped`)
    return Math.min(max, Math.max(min, rounded))
  }
  return rounded
}

function readBool(raw, fallback, field, warnings) {
  if (raw === undefined) return fallback
  if (typeof raw === 'boolean') return raw
  warnings.push(`${field}: expected a boolean, using ${fallback}`)
  return fallback
}

function readString(raw, fallback, field, warnings) {
  // `null` is the documented "unset" spelling for nullable fields
  // (`memory.lingshu.rootDir`, `memory.generic.indexFile`), so it must not be
  // reported as a type error on every activation.
  if (raw === undefined || raw === null) return fallback
  if (typeof raw === 'string') return raw.trim()
  warnings.push(`${field}: expected a string, using ${fallback}`)
  return fallback
}

function readEnum(raw, fallback, allowed, field, warnings) {
  if (raw === undefined) return fallback
  if (typeof raw === 'string' && allowed.has(raw)) return raw
  warnings.push(`${field}: expected ${[...allowed].join('|')}, using ${fallback}`)
  return fallback
}

function readStringArray(raw, fallback, field, warnings) {
  if (raw === undefined) return [...fallback]
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
    warnings.push(`${field}: expected an array of strings, using the default`)
    return [...fallback]
  }
  return raw.map((item) => item.trim()).filter((item) => item !== '')
}

/**
 * Normalize one raw row config into the exact object the plugin reads.
 *
 * Never throws: a malformed row must not prevent the plugin fiber from
 * activating (an unavailable delete UI is better than a broken profile), so
 * every invalid value falls back to its default and is reported in `warnings`.
 * Security-relevant booleans are strict: a non-boolean value keeps the SAFE
 * default (e.g. `stopLiveSessions` stays true, so hard deletion still stops a
 * live session before touching its files).
 *
 * @param {unknown} raw row config from `cordis.patch.yml`
 * @returns {{ value: typeof DEFAULTS, warnings: string[], unknownKeys: string[] }}
 */
export function normalizeConfig(raw) {
  const warnings = []
  const unknownKeys = []
  const source = isPlainObject(raw) ? raw : {}
  if (raw !== undefined && !isPlainObject(raw)) {
    warnings.push('config: expected an object, using defaults')
  }

  const known = new Set(Object.keys(DEFAULTS))
  for (const key of Object.keys(source)) {
    if (!known.has(key)) unknownKeys.push(key)
  }
  if (unknownKeys.length > 0) {
    warnings.push(`config: unknown keys ignored: ${unknownKeys.join(', ')}`)
  }

  const memoryRaw = isPlainObject(source.memory) ? source.memory : {}
  const lingshuRaw = isPlainObject(memoryRaw.lingshu) ? memoryRaw.lingshu : {}
  const genericRaw = isPlainObject(memoryRaw.generic) ? memoryRaw.generic : {}
  const uiRaw = isPlainObject(source.ui) ? source.ui : {}
  const feedbackRaw = isPlainObject(source.feedback) ? source.feedback : {}

  const defaultMode = MODES.has(source.defaultMode) ? source.defaultMode : DEFAULTS.defaultMode
  if (source.defaultMode !== undefined && !MODES.has(source.defaultMode)) {
    warnings.push(`defaultMode: expected soft|hard, using ${DEFAULTS.defaultMode}`)
  }

  const adapters = Array.isArray(memoryRaw.adapters)
    ? memoryRaw.adapters.filter((id) => ADAPTER_IDS.has(id))
    : [...DEFAULTS.memory.adapters]
  if (Array.isArray(memoryRaw.adapters) && adapters.length !== memoryRaw.adapters.length) {
    warnings.push('memory.adapters: unsupported adapter ids were dropped')
  }
  if (adapters.length === 0) adapters.push('none')

  const deleteMode = MEMORY_DELETE_MODES.has(memoryRaw.deleteMode)
    ? memoryRaw.deleteMode
    : DEFAULTS.memory.deleteMode
  if (memoryRaw.deleteMode !== undefined && !MEMORY_DELETE_MODES.has(memoryRaw.deleteMode)) {
    warnings.push(`memory.deleteMode: expected trash|keep, using ${DEFAULTS.memory.deleteMode}`)
  }

  const value = {
    enabled: readBool(source.enabled, DEFAULTS.enabled, 'enabled', warnings),
    requireSameOrigin: readBool(source.requireSameOrigin, DEFAULTS.requireSameOrigin, 'requireSameOrigin', warnings),
    allowNonLoopback: readBool(source.allowNonLoopback, DEFAULTS.allowNonLoopback, 'allowNonLoopback', warnings),
    allowOrphanSessions: readBool(source.allowOrphanSessions, DEFAULTS.allowOrphanSessions, 'allowOrphanSessions', warnings),
    allowSubagentSessions: readBool(source.allowSubagentSessions, DEFAULTS.allowSubagentSessions, 'allowSubagentSessions', warnings),
    stopLiveSessions: readBool(source.stopLiveSessions, DEFAULTS.stopLiveSessions, 'stopLiveSessions', warnings),
    liveDrainMs: clampInt(source.liveDrainMs, DEFAULTS.liveDrainMs, 0, 10_000, 'liveDrainMs', warnings),
    foreignWriterGraceMs: clampInt(source.foreignWriterGraceMs, DEFAULTS.foreignWriterGraceMs, 0, 10_000, 'foreignWriterGraceMs', warnings),
    protectedSessionIds: readStringArray(source.protectedSessionIds, DEFAULTS.protectedSessionIds, 'protectedSessionIds', warnings),
    allowedWorkspaceRoots: readStringArray(source.allowedWorkspaceRoots, DEFAULTS.allowedWorkspaceRoots, 'allowedWorkspaceRoots', warnings),
    defaultMode,
    trashRetentionDays: clampInt(source.trashRetentionDays, DEFAULTS.trashRetentionDays, 0, 3650, 'trashRetentionDays', warnings),
    maxBatchSessions: clampInt(source.maxBatchSessions, DEFAULTS.maxBatchSessions, 1, 1000, 'maxBatchSessions', warnings),
    maxDeletesPerMinute: clampInt(source.maxDeletesPerMinute, DEFAULTS.maxDeletesPerMinute, 1, 1000, 'maxDeletesPerMinute', warnings),
    confirmTokenTtlMs: clampInt(source.confirmTokenTtlMs, DEFAULTS.confirmTokenTtlMs, 5_000, 3_600_000, 'confirmTokenTtlMs', warnings),
    auditRetentionLines: clampInt(source.auditRetentionLines, DEFAULTS.auditRetentionLines, 100, 1_000_000, 'auditRetentionLines', warnings),
    auditMaxBytes: clampInt(source.auditMaxBytes, DEFAULTS.auditMaxBytes, 65_536, 1 << 30, 'auditMaxBytes', warnings),
    memory: {
      enabled: readBool(memoryRaw.enabled, DEFAULTS.memory.enabled, 'memory.enabled', warnings),
      adapters,
      lingshu: {
        rootDir: readString(lingshuRaw.rootDir, DEFAULTS.memory.lingshu.rootDir, 'memory.lingshu.rootDir', warnings) || null,
      },
      generic: {
        indexFile: readString(genericRaw.indexFile, DEFAULTS.memory.generic.indexFile, 'memory.generic.indexFile', warnings) || null,
        rootDir: readString(genericRaw.rootDir, DEFAULTS.memory.generic.rootDir, 'memory.generic.rootDir', warnings) || null,
        sessionField: readString(genericRaw.sessionField, DEFAULTS.memory.generic.sessionField, 'memory.generic.sessionField', warnings) || 'session',
        nodesPointer: readString(genericRaw.nodesPointer, DEFAULTS.memory.generic.nodesPointer, 'memory.generic.nodesPointer', warnings) || '/nodes',
      },
      deleteMode,
    },
    ui: {
      showRowAction: readBool(uiRaw.showRowAction, DEFAULTS.ui.showRowAction, 'ui.showRowAction', warnings),
      showHeaderAction: readBool(uiRaw.showHeaderAction, DEFAULTS.ui.showHeaderAction, 'ui.showHeaderAction', warnings),
      batchDoubleConfirm: readBool(uiRaw.batchDoubleConfirm, DEFAULTS.ui.batchDoubleConfirm, 'ui.batchDoubleConfirm', warnings),
    },
    feedback: {
      enabled: readBool(feedbackRaw.enabled, DEFAULTS.feedback.enabled, 'feedback.enabled', warnings),
      to: readString(feedbackRaw.to, DEFAULTS.feedback.to, 'feedback.to', warnings),
      from: readString(feedbackRaw.from, DEFAULTS.feedback.from, 'feedback.from', warnings),
      transport: readEnum(feedbackRaw.transport, DEFAULTS.feedback.transport, FEEDBACK_TRANSPORTS, 'feedback.transport', warnings),
      // A tight floor is deliberate: the route is reachable by any page the
      // Host serves, and every message is an outbound mail from the operator's
      // account. One message a minute is plenty for a human.
      rateLimitPerHour: clampInt(feedbackRaw.rateLimitPerHour, DEFAULTS.feedback.rateLimitPerHour, 1, 100, 'feedback.rateLimitPerHour', warnings),
      visitorAsFrom: readBool(feedbackRaw.visitorAsFrom, DEFAULTS.feedback.visitorAsFrom, 'feedback.visitorAsFrom', warnings),
    },
  }

  return { value, warnings, unknownKeys }
}

/**
 * Resolve a JSON pointer (`/nodes`, `/a/b`) against a parsed JSON document.
 * Returns `undefined` for a missing path; used by the generic memory adapter.
 */
export function resolveJsonPointer(document, pointer) {
  if (typeof pointer !== 'string' || pointer === '' || pointer === '/') return document
  if (!pointer.startsWith('/')) return undefined
  let cursor = document
  for (const rawSegment of pointer.slice(1).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~')
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = cursor[segment]
  }
  return cursor
}

/** Deep clone of the defaults; exported for tests and documentation. */
export function defaultConfig() {
  return clone(DEFAULTS)
}
