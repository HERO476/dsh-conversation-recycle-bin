/**
 * Small cross-process advisory lock built from an exclusively-created file.
 *
 * This is NOT a replacement for an OS byte-range lock: it coordinates writers
 * that use the same protocol (this plugin's Host processes and its memory
 * adapter). It deliberately never touches another program's lock file — the
 * 灵枢 (md_cg) store keeps a permanent, zero-byte `<index>.lock` that is
 * guarded by `msvcrt.locking`/`flock`; treating that file's existence as a
 * lock (or deleting it) breaks its writer instead of excluding it.
 *
 * Semantics:
 *   - acquisition creates `<lockPath>` with `wx`, writes `{pid, nonce, at}`;
 *   - a holder refreshes the file mtime on a heartbeat, so a long operation is
 *     never mistaken for a crashed one;
 *   - a lock is stale when its mtime is older than `staleMs`, or when the
 *     recorded pid is provably gone; a stale lock is removed and retried;
 *   - release only removes the file when it still carries this owner's nonce,
 *     so a lock broken by a peer cannot make us delete the peer's lock.
 *
 * Every wait sleeps, and the wait budget is checked on every iteration: a
 * held lock can never spin forever (the bug this module replaces).
 */
import * as defaultFs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function defaultIsProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but is owned by someone else.
    return error?.code === 'EPERM'
  }
}

function parseOwner(raw) {
  try {
    const value = JSON.parse(String(raw))
    if (value !== null && typeof value === 'object') {
      return { pid: Number.isInteger(value.pid) ? value.pid : null, nonce: typeof value.nonce === 'string' ? value.nonce : null }
    }
  } catch {
    // A legacy/foreign lock may be empty or plain text; it has no owner.
  }
  return { pid: null, nonce: null }
}

/**
 * @param {object} options
 * @param {string} options.lockPath absolute path of the lock file
 * @param {number} [options.timeoutMs] wait budget for one acquisition
 * @param {number} [options.staleMs] age after which an ownerless lock is broken
 * @param {number} [options.heartbeatMs] mtime refresh interval while held
 * @param {number} [options.retryMs] poll interval
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {(pid: number) => boolean} [options.isProcessAlive]
 * @param {object} [options.fsApi]
 * @param {number} [options.pid]
 */
export function createFileLock({
  lockPath,
  timeoutMs = 15_000,
  staleMs = 120_000,
  heartbeatMs = 5_000,
  retryMs = 50,
  now = Date.now,
  sleep = sleepDefault,
  isProcessAlive = defaultIsProcessAlive,
  fsApi = defaultFs,
  pid = process.pid,
}) {
  if (typeof lockPath !== 'string' || lockPath === '') throw new Error('file-lock: lockPath is required')

  /**
   * Acquire the lock.
   * @returns {Promise<() => Promise<void>>} release
   */
  async function acquire() {
    const nonce = randomBytes(8).toString('hex')
    const started = now()
    let handle = null

    while (handle === null) {
      try {
        handle = await fsApi.open(lockPath, 'wx')
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        let info
        try {
          info = await fsApi.stat(lockPath)
        } catch (statError) {
          if (statError?.code === 'ENOENT') continue
          throw statError
        }
        const age = Math.max(0, now() - info.mtimeMs)
        let owner = { pid: null, nonce: null }
        try {
          owner = parseOwner(await fsApi.readFile(lockPath, 'utf8'))
        } catch {
          // Unreadable owner text is treated as ownerless, not as a crash.
        }
        const deadOwner = owner.pid !== null && !isProcessAlive(owner.pid)
        if (age > staleMs || deadOwner) {
          await fsApi.rm(lockPath, { force: true }).catch(() => {})
          continue
        }
        if (now() - started >= timeoutMs) {
          const busy = new Error(`The lock ${lockPath} is held by another process.`)
          busy.code = 'E_LOCK_BUSY'
          throw busy
        }
        await sleep(retryMs)
        continue
      }

      try {
        await handle.writeFile(`${JSON.stringify({ pid, nonce, at: now() })}\n`, 'utf8')
      } catch (error) {
        await handle.close().catch(() => {})
        await fsApi.rm(lockPath, { force: true }).catch(() => {})
        throw error
      }
      break
    }

    const heartbeat = setInterval(() => {
      const stamp = new Date()
      fsApi.utimes(lockPath, stamp, stamp).catch(() => {})
    }, Math.max(250, heartbeatMs))
    if (typeof heartbeat.unref === 'function') heartbeat.unref()

    let released = false
    return async () => {
      if (released) return
      released = true
      clearInterval(heartbeat)
      try {
        const owner = parseOwner(await fsApi.readFile(lockPath, 'utf8').catch(() => ''))
        if (owner.nonce === nonce) await fsApi.rm(lockPath, { force: true }).catch(() => {})
      } finally {
        await handle?.close().catch(() => {})
      }
    }
  }

  return { acquire, lockPath }
}
