/**
 * Append-only audit trail (JSONL under the plugin's data directory).
 *
 * The trail is written *after* each terminal outcome (success, rollback,
 * restore, purge) so it can never claim a deletion that did not commit. Every
 * line is one self-contained JSON object; a torn tail line is ignored on read
 * rather than corrupting the whole trail, and the file is compacted in place
 * when it exceeds the configured size, keeping the most recent lines.
 *
 * The audit file is also the durable evidence a user can hand to support:
 * actor (the local Web UI), session ids, mode, the memory checkbox, per-adapter
 * counts, and whether a failed transaction was rolled back.
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * @param {object} options
 * @param {string} options.filePath absolute path of the JSONL file
 * @param {number} [options.maxBytes] compact threshold
 * @param {number} [options.retentionLines] lines kept after compaction
 * @param {() => number} [options.now]
 * @param {Pick<typeof import('node:fs/promises'), 'readFile'|'writeFile'|'mkdir'|'appendFile'|'rename'|'stat'>} [options.fsApi]
 */
export function createAuditLog({ filePath, maxBytes = 5 * 1024 * 1024, retentionLines = 5_000, now = Date.now, fsApi = { readFile, writeFile, mkdir, appendFile, rename, stat } }) {
  let pending = Promise.resolve()

  function serialize(operation) {
    // Serialize appends inside one Host process: concurrent deletions must not
    // interleave partial lines. Compaction also runs under this same chain.
    const next = pending.then(operation, operation)
    pending = next.then(() => undefined, () => undefined)
    return next
  }

  async function compactIfNeeded(nextLineBytes) {
    let size = 0
    try {
      size = (await fsApi.stat(filePath)).size
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    if (size + nextLineBytes <= maxBytes) return

    let lines = []
    try {
      const content = await fsApi.readFile(filePath, 'utf8')
      lines = content.split('\n').filter((line) => line.trim() !== '')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const kept = lines.slice(-retentionLines)
    const temporary = `${filePath}.compacting`
    await fsApi.writeFile(temporary, kept.length === 0 ? '' : `${kept.join('\n')}\n`, 'utf8')
    await fsApi.rename(temporary, filePath)
  }

  return {
    filePath,

    /**
     * Append one record. Never throws for an audit failure? It DOES throw: a
     * deletion whose audit write fails must be reported as a failed operation,
     * because "traceable" is part of the contract. Callers run the audit write
     * inside the same transaction step so a failure rolls the deletion back.
     */
    append(record) {
      return serialize(async () => {
        const line = JSON.stringify({ ...record, at: record.at ?? now() })
        await fsApi.mkdir(dirname(filePath), { recursive: true })
        await compactIfNeeded(Buffer.byteLength(line, 'utf8') + 1)
        await fsApi.appendFile(filePath, `${line}\n`, 'utf8')
        return line
      })
    },

    /** Read the most recent `limit` records; malformed lines are counted, not thrown. */
    async tail(limit = 50) {
      let content = ''
      try {
        content = await fsApi.readFile(filePath, 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') return { records: [], malformed: 0 }
        throw error
      }
      const lines = content.split('\n').filter((line) => line.trim() !== '')
      const records = []
      let malformed = 0
      for (const line of lines) {
        try {
          records.push(JSON.parse(line))
        } catch {
          malformed += 1
        }
      }
      return { records: records.slice(-limit), malformed }
    },
  }
}
