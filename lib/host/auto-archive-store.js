/**
 * Durable state for the "archive → recycle bin" opt-in.
 *
 * One small JSON file next to the recycle bin (`<dataDir>/auto-archive.json`).
 * It is NOT config: the row config is bound once at activation and cannot be
 * written at runtime (there is no config-write route, and the patch layer
 * belongs to the Host loader), so "switch this off in Settings" had nowhere to
 * live. A plugin-owned state file is the only place a settings-page decision can
 * persist without inventing a second configuration source.
 *
 * Rules that matter:
 *   - writes are atomic (`tmp` + `rename`) and go through the caller's mutation
 *     lock, so two Hosts sharing one DSH_HOME cannot interleave a half file;
 *   - an unreadable/broken file is reported as `unasked`, which never deletes;
 *   - no in-memory cache: the file is tiny, reads are on the delete attempt and
 *     `/state` only, and a cache here would be one more copy that can disagree
 *     with the disk the other Host is writing.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { applyDecision, normalizeAutoState } from '../core/auto-archive.js'

const TEMP_SUFFIX = '.tmp'

/**
 * @param {object} options
 * @param {string} options.filePath absolute path of `auto-archive.json`
 * @param {() => number} [options.now]
 * @param {Pick<Console, 'warn'>} [options.logger]
 * @param {object} [options.fsApi] injectable for tests
 */
export function createAutoArchiveStore({ filePath, now = Date.now, logger = console, fsApi = { mkdir, readFile, rename, writeFile } }) {
  /** @returns {Promise<{ state: object, warnings: string[], exists: boolean }>} */
  async function read() {
    let raw
    try {
      raw = await fsApi.readFile(filePath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: normalizeAutoState(null).value, warnings: [], exists: false }
      // An unreadable file is not "no answer yet": it is an answer we cannot
      // read. Both are safe (neither enables anything), but the warning matters
      // for a support report.
      logger.warn?.(`[conversation-recycle-bin] auto-archive state unreadable (${error?.code ?? error}); treating the feature as unasked`)
      return { state: normalizeAutoState(null).value, warnings: ['state file unreadable'], exists: true }
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      logger.warn?.('[conversation-recycle-bin] auto-archive state is not valid JSON; treating the feature as unasked')
      return { state: normalizeAutoState(null).value, warnings: ['state file corrupt'], exists: true }
    }
    const { value, warnings } = normalizeAutoState(parsed)
    for (const warning of warnings) logger.warn?.(`[conversation-recycle-bin] ${warning}`)
    return { state: value, warnings, exists: true }
  }

  async function write(state) {
    const directory = dirname(filePath)
    await fsApi.mkdir(directory, { recursive: true })
    const temporary = join(directory, `${filePath.split(/[\\\\/]/).pop()}${TEMP_SUFFIX}`)
    await fsApi.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await fsApi.rename(temporary, filePath)
    return state
  }

  /**
   * Record the user's answer. The CALLER must hold the mutation lock: this
   * read-modify-write is the only place a decision is lost if two writers race.
   *
   * @param {{ decision: 'on'|'off', version?: string|null, decidedBy?: string|null }} input
   */
  async function decide({ decision, version = null, decidedBy = null }) {
    const { state: previous } = await read()
    const next = applyDecision({ decision, version, decidedBy, now: now(), previous })
    await write(next)
    return next
  }

  return { filePath, read, write, decide }
}
