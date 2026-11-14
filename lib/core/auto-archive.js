/**
 * "Archive → recycle bin" policy.
 *
 * Archived conversations used to be only *hidden*: the Host keeps the log, the
 * session stays in the workspace ledger, and nothing ever deletes it. This
 * module describes the opt-in that turns an archive into a recycle-bin entry,
 * which the existing retention sweep then purges after `trashRetentionDays`.
 *
 * Everything here is PURE — no clock, no filesystem, no Host service — because
 * the two decisions that matter (is the feature allowed to run at all, and is
 * this conversation already represented in the bin) must be testable without a
 * running Host, and must be identical in every caller.
 *
 * ## Why the switch is tri-state, not boolean
 *
 * The product requirement is "on by default, but ask the user once after the
 * upgrade, and never enable it silently". Those two halves contradict each
 * other if the switch is a boolean: a boolean cannot tell "the user chose on"
 * from "nobody was ever asked", so `true` would start an irreversible 30-day
 * countdown before the question was answered. The state file therefore records
 * `unasked | on | off`, and `unasked` NEVER acts:
 *
 *   effective = config veto ? off : (unasked ? off : state === 'on')
 *
 * "On by default" is expressed as the pre-selected answer in the prompt and as
 * the `autoArchive.enabled: true` default, not as an action taken on the
 * user's behalf. `config.autoArchive.enabled: false` is an operator VETO: it
 * wins over any stored decision, so a deployment can switch the feature off
 * regardless of what a previous user answered.
 */

/** Manifest marker: this entry was created by archiving, not by a user delete. */
export const AUTO_ORIGIN = 'auto-archive'

/** `format` of the state file. A different value is reset to `unasked`. */
export const AUTO_STATE_SCHEMA = 1

/** Decisions the ack route accepts. */
export const AUTO_DECISIONS = Object.freeze(['on', 'off'])

/** Every stored state. `unasked` is the only one that never acts. */
export const AUTO_STATES = Object.freeze(['unasked', 'on', 'off'])

/**
 * Statuses that already represent this conversation in the bin.
 *
 * The set decides idempotency. At-least-once delivery is the norm for a Host
 * lifecycle event, and a second entry for the same session would let the sweep
 * purge the same conversation twice under two `deletedAt` values.
 *
 * `purging` counts as occupied on purpose: an entry created while its
 * predecessor is being deleted would be processed by the same sweep under the
 * older timestamp — "one delete, two rows, one of them unexplained".
 *
 * `failed` does NOT count: an automatic attempt that failed must be retryable,
 * otherwise one unwritable audit line permanently costs that conversation its
 * 30-day promise.
 *
 * `restored`/`restored`-adjacent terminal states do not count either: the log
 * is back in place, so a new archive is a new decision.
 */
export const ACTIVE_STATUSES = Object.freeze(['pending', 'trashed', 'restoring', 'purging'])

/** The state file before anything was ever written. */
export const EMPTY_STATE = Object.freeze({
  schema: AUTO_STATE_SCHEMA,
  state: 'unasked',
  decidedAt: null,
  decidedBy: null,
  ackedVersion: null,
  baseArchivedAt: null,
})

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readTimestamp(raw) {
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Normalize one parsed state file.
 *
 * Fail-safe direction: anything unusable becomes `unasked`, which never deletes.
 * The one translation that must NOT be fail-safe-by-accident is `schema`: a
 * file written by a future version is reset to `unasked` with a warning rather
 * than interpreted by a version that cannot know its meaning.
 *
 * @param {unknown} raw
 * @returns {{ value: typeof EMPTY_STATE, warnings: string[] }}
 */
export function normalizeAutoState(raw) {
  const warnings = []
  if (raw === undefined || raw === null) return { value: { ...EMPTY_STATE }, warnings }
  if (!isPlainObject(raw)) {
    warnings.push('auto-archive state: expected an object, treating the feature as unasked')
    return { value: { ...EMPTY_STATE }, warnings }
  }
  if (raw.schema !== AUTO_STATE_SCHEMA) {
    warnings.push(`auto-archive state: unsupported schema ${String(raw.schema)}, treating the feature as unasked`)
    return { value: { ...EMPTY_STATE }, warnings }
  }
  const state = AUTO_STATES.includes(raw.state) ? raw.state : 'unasked'
  if (raw.state !== undefined && !AUTO_STATES.includes(raw.state)) {
    warnings.push(`auto-archive state: unknown state ${String(raw.state)}, treating the feature as unasked`)
  }
  const decidedAt = readTimestamp(raw.decidedAt)
  // A decision without a timestamp cannot be audited, so it is not a decision.
  if (state !== 'unasked' && decidedAt === null) {
    warnings.push('auto-archive state: a decision without a timestamp, treating the feature as unasked')
    return { value: { ...EMPTY_STATE }, warnings }
  }
  return {
    value: {
      schema: AUTO_STATE_SCHEMA,
      state,
      decidedAt: state === 'unasked' ? null : decidedAt,
      decidedBy: state === 'unasked' || typeof raw.decidedBy !== 'string' ? null : raw.decidedBy.slice(0, 64),
      ackedVersion: state === 'unasked' || typeof raw.ackedVersion !== 'string' ? null : raw.ackedVersion.slice(0, 64),
      baseArchivedAt: readTimestamp(raw.baseArchivedAt),
    },
    warnings,
  }
}

/**
 * Whether archiving should currently create a recycle-bin entry.
 *
 * @param {object} input
 * @param {boolean} input.pluginEnabled `config.enabled`
 * @param {boolean} input.configEnabled `config.autoArchive.enabled` (operator veto)
 * @param {{ state: string }} input.autoState normalized state file
 * @returns {{ mode: 'on'|'off', reason: string }}
 */
export function effectiveAutoArchive({ pluginEnabled, configEnabled, autoState }) {
  if (pluginEnabled !== true) return { mode: 'off', reason: 'plugin-disabled' }
  if (configEnabled !== true) return { mode: 'off', reason: 'config-disabled' }
  const state = autoState?.state ?? 'unasked'
  if (state === 'on') return { mode: 'on', reason: 'user-enabled' }
  if (state === 'off') return { mode: 'off', reason: 'user-disabled' }
  // `unasked` is off, not on: the question has not been answered yet.
  return { mode: 'off', reason: 'unasked' }
}

/**
 * Whether the Settings page should ask the user now.
 *
 * Asked exactly once per install/upgrade. `unasked` is the only state that
 * prompts, so answering either way ends the prompt for good; a later upgrade
 * does not re-ask (the answer still stands).
 *
 * @param {object} input
 * @param {boolean} input.pluginEnabled
 * @param {boolean} input.configEnabled
 * @param {boolean} input.askOnUpgrade `config.autoArchive.askOnUpgrade`
 * @param {{ state: string }} input.autoState
 */
export function shouldPromptForDecision({ pluginEnabled, configEnabled, askOnUpgrade, autoState }) {
  if (pluginEnabled !== true) return false
  if (configEnabled !== true) return false
  if (askOnUpgrade === false) return false
  return (autoState?.state ?? 'unasked') === 'unasked'
}

/**
 * The state file after the user answers the prompt.
 *
 * `baseArchivedAt` is the start of the 30-day promise for FUTURE archives. It
 * exists so a report can say "this has been on since X" and so the answer
 * itself is auditable; it is deliberately NOT used to find historical archives,
 * because the Host ledger stores archived ids without per-id timestamps and the
 * archive event is not replayed for sessions that were archived before the
 * feature existed.
 *
 * @param {object} input
 * @param {'on'|'off'} input.decision
 * @param {string|null} input.version plugin version the decision was made with
 * @param {string|null} input.decidedBy transport label (`web-ui`, `desktop-ui`, …)
 * @param {number} input.now
 * @param {{ baseArchivedAt?: number|null }} [input.previous]
 */
export function applyDecision({ decision, version = null, decidedBy = null, now, previous = null }) {
  if (!AUTO_DECISIONS.includes(decision)) {
    throw new RangeError(`auto-archive: unknown decision ${String(decision)}`)
  }
  return {
    schema: AUTO_STATE_SCHEMA,
    state: decision,
    decidedAt: now,
    decidedBy: typeof decidedBy === 'string' ? decidedBy.slice(0, 64) : null,
    ackedVersion: typeof version === 'string' ? version.slice(0, 64) : null,
    // Turning the feature ON starts a new promise; turning it off keeps the old
    // start so the audit trail can still explain entries already in the bin.
    baseArchivedAt: decision === 'on' ? now : (previous?.baseArchivedAt ?? null),
  }
}

/** True when the manifest says this entry came from an archive. */
export function isAutoEntry(entry) {
  return entry !== null && typeof entry === 'object' && entry.origin === AUTO_ORIGIN
}

/** True for a status that already represents this conversation in the bin. */
export function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(status)
}

/**
 * Find the entry already representing `sessionId`, if any.
 *
 * Idempotency lives here rather than in `trash.allocate()`: allocation only
 * mints a random id and has no global view, while `scanAll()` is already the
 * single source of truth `/trash` and the retention sweep read from.
 *
 * A `pending` entry is REPORTED (so the caller can finish or reuse it) rather
 * than skipped: a crash between "manifest written" and "status trashed" would
 * otherwise block this conversation forever.
 *
 * @param {object[]} entries every readable manifest
 * @param {string} sessionId
 * @returns {object|null}
 */
export function findActiveEntryForSession(entries, sessionId) {
  if (!Array.isArray(entries) || typeof sessionId !== 'string' || sessionId === '') return null
  return entries.find((entry) => entry !== null && typeof entry === 'object'
    && entry.sessionId === sessionId
    && isActiveStatus(entry.status)) ?? null
}

/**
 * Audit actor for the autonomous path.
 *
 * The retention sweep labels itself `local-user`; that is wrong for a path no
 * user triggered, and it made "who deleted this" unanswerable after the fact.
 */
export const AUTO_ACTOR = 'system:archive-auto'

/** Audit `source` for the autonomous path (distinct from `web-ui`/`desktop-ui`). */
export const AUTO_SOURCE = 'auto-archive'
