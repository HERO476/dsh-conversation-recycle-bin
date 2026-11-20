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

// Path bodies may contain spaces: `C:\Program Files\DeepSeek Harness\…` and
// `/home/alice/my documents/…` are ordinary, and the old `[^\s…]+` rule stopped
// at the first space, returning `Program Files\DeepSeek Harness\…` — the head of
// the path removed, the rest fully exposed. The rules are greedy now and
// `trimToLastSegment` gives back anything a greedy match swallowed past the file
// name, which is what keeps `C:\a\b some prose` from eating "some prose".
const WINDOWS_ABSOLUTE = /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"'<>|]+/g
const POSIX_ABSOLUTE = /(^|[\s("'=])\/(?:[^\r\n"'<>]+\/)*[^\r\n"'<>/]+/g
/** Forward-slash UNC (`//server/share/...`) is a Windows handle too. */
const UNC_FORWARD = /(^|[\s("'=])\/\/[^\r\n"'<>/]+\/[^\r\n"'<>]+/g
/**
 * Network URLs are shielded before the path rules run. Without this, the drive
 * letter rule eats the `p:/` inside `http://` and a diagnostic string like
 * `http://evil.example` comes back as `httevil.example` — the one field an
 * operator needs to see for a cross-origin rejection. Only network schemes are
 * shielded: `file:///C:/...` still has its path shortened, because a local
 * path in a URL is still a filesystem handle.
 */
const NETWORK_URL = /\b(?:https?|wss?|ftp):\/\/[^\s"'<>|]+/gi
const URL_SLOT = /\u0000(\d+)\u0000/g

/**
 * Shorten one filesystem path to its last segment.
 *
 * Exported because two routes ship a path-shaped FIELD rather than a message:
 * `/sessions` and `/preview` both carry `cwd`, which the picker renders as a
 * subtitle. Shipping it verbatim contradicted this module's whole contract while
 * the same key sat in PATH_KEYS — the routes simply never went through
 * `redactDetails`. Callers now shorten the value instead of dropping it.
 * @param {unknown} value
 * @returns {string}
 */
export function shortPath(value) {
  const normalized = String(value).replace(/\\/g, '/').replace(/\/+$/g, '')
  if (normalized === '') return ''
  return basename(normalized)
}

/**
 * Cut a greedy path match back to its last real segment.
 *
 * A greedy rule cannot tell `C:\Program Files\App\x.json` (one path) from
 * `C:\a\b and then some prose` (a path followed by words). The difference is
 * always the same: prose appears AFTER the last separator. So keep everything up
 * to the first whitespace that follows the final separator, and hand that to
 * `shortPath`.
 */
function trimToLastSegment(match) {
  const lastSep = Math.max(match.lastIndexOf('\\'), match.lastIndexOf('/'))
  if (lastSep < 0) return match
  const tail = match.slice(lastSep + 1)
  const space = tail.search(/\s/u)
  return space === -1 ? match : match.slice(0, lastSep + 1 + space)
}

function redactText(value) {
  if (typeof value !== 'string') return value
  const urls = []
  const shielded = value.replace(NETWORK_URL, (match) => {
    urls.push(match)
    return `\u0000${urls.length - 1}\u0000`
  })
  const cleaned = shielded
    .replace(WINDOWS_ABSOLUTE, (match) => shortPath(trimToLastSegment(match)))
    .replace(UNC_FORWARD, (match, prefix) => `${prefix}${shortPath(trimToLastSegment(match.slice(prefix.length)))}`)
    .replace(POSIX_ABSOLUTE, (match, prefix) => `${prefix}${shortPath(trimToLastSegment(match.slice(prefix.length)))}`)
  if (urls.length === 0) return cleaned
  return cleaned.replace(URL_SLOT, (match, index) => urls[Number(index)] ?? match)
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
    // Every other string is redacted too. Only path-like substrings change, so
    // this cannot alter a code, an id or a count — and it is what makes a
    // diagnostic field like `reason` (the adapter's raw error text) safe
    // without every caller having to know the redactor's key list.
    result[key] = typeof item === 'string' ? redactText(item) : redactDetails(item)
  }
  return result
}
