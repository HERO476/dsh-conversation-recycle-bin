/**
 * Authorization and data-ownership policy.
 *
 * The Host is a local single-user application, so "who is the operator" is
 * answered by the transport (same-origin loopback route, user-only UI) and not
 * by a user database. What remains is *data ownership*: a session must exist,
 * must belong to a registered workspace (unless the operator opted into orphan
 * deletion), must not be a delegated subagent's private session, and must not
 * be listed as protected. Hard deletion of a live session is allowed by
 * default because the cascade quiesces it first (cancel the turn, archive with
 * `stopActivity`, then drain); `stopLiveSessions: false` restores a strict
 * refusal for operators who do not want the plugin to touch running work.
 *
 * Every check returns a `DeleteError` so route and tests share one wording.
 */
import { DeleteError } from './errors.js'

/** Normalize a Windows/Unix path for containment checks (no filesystem access). */
export function normalizePathForCompare(input) {
  if (typeof input !== 'string' || input === '') return ''
  let value = input.replace(/\\/g, '/')
  // A bare root must stay a root: trimming its trailing slash turned `/` into
  // '' and made the filesystem root fail its own containment test
  // (`isPathInside('/', '/a')` was false).
  if (/^\/+$/.test(value)) {
    value = '/'
  } else if (/^[A-Za-z]:\/+$/.test(value)) {
    value = `${value.slice(0, 2)}/`
  } else {
    value = value.replace(/\/+$/, '')
  }
  // Windows paths compare case-insensitively: drive-lettered paths and UNC
  // roots (`\\server\share`, `\\?\C:\...`). POSIX paths stay case-sensitive so
  // a root check cannot become broader than the filesystem's own identity rules.
  if (/^[A-Za-z]:\//.test(value) || value.startsWith('//')) value = value.toLowerCase()
  return value
}

/**
 * Collapse `.`/`..` segments lexically (no filesystem access).
 *
 * A prefix comparison over raw strings is not a containment test: a candidate
 * such as `<root>/../../etc` starts with `<root>/` and used to pass it. `..`
 * is clamped at the root exactly like the OS does for `/..`, and the root
 * prefix (`/`, `//server/share`, `c:`) is preserved verbatim.
 */
export function collapsePathSegments(value) {
  if (typeof value !== 'string' || value === '') return ''
  let root = ''
  let rest = value
  if (rest.startsWith('//')) {
    const unc = /^\/\/[^/]+\/[^/]+/.exec(rest)
    if (unc !== null) {
      root = unc[0]
      rest = rest.slice(root.length)
    } else {
      root = '//'
      rest = rest.slice(2)
    }
  } else if (rest.startsWith('/')) {
    root = '/'
    rest = rest.slice(1)
  } else {
    const drive = /^([a-z]):(?:\/|$)/i.exec(rest)
    if (drive !== null) {
      root = `${drive[1].toLowerCase()}:`
      rest = rest.slice(drive[0].length)
    }
  }
  const out = []
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (out.length > 0) out.pop()
      continue
    }
    out.push(segment)
  }
  const body = out.join('/')
  if (root === '') return body
  if (root === '//') return `//${body}`
  if (root === '/') return `/${body}`
  return body === '' ? `${root}/` : `${root}/${body}`
}

/** True when `candidate` equals `root` or lies below it. */
export function isPathInside(root, candidate) {
  const normalizedRoot = collapsePathSegments(normalizePathForCompare(root))
  const normalizedCandidate = collapsePathSegments(normalizePathForCompare(candidate))
  if (normalizedRoot === '' || normalizedCandidate === '') return false
  const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(prefix)
}

/**
 * Evaluate the policy for ONE session.
 *
 * @param {object} input
 * @param {{ id: string, title?: string, cwd?: string, origin?: string, blank?: boolean }} input.session
 * @param {{ id: string, path: string, title?: string } | null} input.workspace owning workspace, if any
 * @param {boolean} input.live whether the Host still knows the session at all; used
 *   only as a fallback when `session.running` is unknown
 * @param {'soft'|'hard'} input.mode requested deletion mode
 * @param {ReturnType<import('./config.js').normalizeConfig>['value']} input.config
 * @returns {{ ok: true, warnings: string[] } | { ok: false, error: DeleteError }}
 */
export function evaluateSessionPolicy({ session, workspace, live, mode, config }) {
  const warnings = []
  const id = String(session?.id ?? '')
  // "Exists" is not "busy". `live` says the Host still knows the session, which
  // is true for every idle conversation too; gating a hard delete on it made
  // `stopLiveSessions: false` refuse to delete conversations nobody was using.
  // When the Host does not report a status at all we keep the old, stricter
  // reading: unknown counts as running.
  const running = session?.running === true || (session?.running === undefined && live === true)

  if (config.protectedSessionIds.includes(id)) {
    return {
      ok: false,
      error: new DeleteError('E_POLICY_PROTECTED', 'This conversation is protected by configuration and cannot be deleted.', {
        sessionId: id,
      }),
    }
  }

  if (session?.origin === 'subagent' && !config.allowSubagentSessions) {
    return {
      ok: false,
      error: new DeleteError('E_POLICY_SUBAGENT', 'Subagent sessions cannot be deleted unless explicitly allowed.', {
        sessionId: id,
      }),
    }
  }

  if (workspace === null || workspace === undefined) {
    if (!config.allowOrphanSessions) {
      return {
        ok: false,
        error: new DeleteError('E_POLICY_ORPHAN', 'This conversation is not owned by a registered workspace.', {
          sessionId: id,
          cwd: session?.cwd ?? null,
        }),
      }
    }
    warnings.push('The conversation has no owning workspace; orphan deletion is enabled.')
  }

  if (config.allowedWorkspaceRoots.length > 0) {
    const cwd = session?.cwd ?? workspace?.path
    const allowed = config.allowedWorkspaceRoots.some((root) => isPathInside(root, cwd ?? ''))
    if (!allowed) {
      return {
        ok: false,
        error: new DeleteError('E_POLICY_ROOT', 'This conversation is outside the allowed workspace roots.', {
          sessionId: id,
          cwd: cwd ?? null,
        }),
      }
    }
  }

  if (mode === 'hard' && running) {
    if (!config.stopLiveSessions) {
      return {
        ok: false,
        error: new DeleteError('E_POLICY_LIVE', 'This conversation is still open in a live agent, and stopLiveSessions is disabled.', {
          sessionId: id,
        }),
      }
    }
    warnings.push('The conversation is open in a live agent; it will be stopped before its log is removed.')
  }

  // A soft delete also quiesces the session (`archiveSession(id, { stopActivity:
  // true })`), so it interrupts a running turn exactly like a hard delete does.
  // Say so before the click instead of after the round died.
  if (mode === 'soft' && running) {
    warnings.push('The conversation is running right now; a soft delete stops the current turn before moving it to the recycle bin.')
  }

  if (session?.blank === true) warnings.push('This is an empty conversation.')

  return { ok: true, warnings }
}
