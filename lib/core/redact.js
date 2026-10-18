/**
 * Redact host filesystem paths from error details before they cross the HTTP
 * boundary.
 *
 * The Client contract is "ids, counts and status — no filesystem handles".
 * Deleting and memory failures legitimately carry diagnostic paths in their
 * `details`/`cause`; those are useful in the Host log, not in the browser.
 */
import { basename } from 'node:path'

const PATH_KEYS = new Set([
  'indexFile',
  'lockFile',
  'bundlePath',
  'filePath',
  'path',
  'from',
  'to',
  'cwd',
  'trashDir',
  'auditFile',
  'dataDir',
  'rootDir',
])

const WINDOWS_ABSOLUTE = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]+/g
const POSIX_ABSOLUTE = /(^|[\s("'=])\/(?:[^\s"'<>/]+\/)+[^\s"'<>]+/g

function shortPath(value) {
  const normalized = String(value).replace(/\\/g, '/').replace(/\/+$/g, '')
  if (normalized === '') return ''
  return basename(normalized)
}

function redactText(value) {
  if (typeof value !== 'string') return value
  return value
    .replace(WINDOWS_ABSOLUTE, (match) => shortPath(match))
    .replace(POSIX_ABSOLUTE, (match, prefix) => `${prefix}${shortPath(match.slice(prefix.length))}`)
}

/**
 * Recursively redact path-like values. Unknown keys are preserved so the
 * Client can still branch on structured fields (counts, ids, codes).
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactDetails(value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map((item) => (typeof item === 'string' ? redactText(item) : redactDetails(item)))
  if (typeof value !== 'object') return value
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    if (PATH_KEYS.has(key) && typeof item === 'string') {
      result[key] = shortPath(item)
      continue
    }
    if (key === 'cause' || key === 'message') {
      result[key] = typeof item === 'string' ? redactText(item) : redactDetails(item)
      continue
    }
    result[key] = typeof item === 'string' ? item : redactDetails(item)
  }
  return result
}
