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
 *   - a lock whose recorded pid is provably gone is stale and is broken at
 *     once; an ownerless (foreign/legacy) lock is stale only by age;
 *   - a lock whose owner is still alive is NEVER broken by age alone: a long
 *     GC pause or a suspended process must not let a second writer in. The one
 *     exception is a lock that has not been heartbeated for ten stale windows
 *     (a recycled pid or a wedged holder), which is broken with a warning;
 *   - release only removes the file when it still carries this owner's nonce,
 *     so a lock broken by a peer cannot make us delete the peer's lock. If the
 *     removal fails, the lock is demoted to ownerless (pid: null) rather than
 *     left recording a live pid nobody can break.
 *
 * Every iteration sleeps and re-checks the wait budget, including the
 * stale-break path: a lock file that cannot be removed (Windows exclusive
 * handle, AV/indexer, read-only volume) used to spin without ever sleeping or
 * throwing, which hung the whole mutation chain behind it.
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
 * @param {number} [options.maxBreakFailures] consecutive failed stale-lock
 *   removals tolerated before giving up with `E_LOCK_BUSY`
 * @param {(message: string) => void} [options.warn] receives lock files that
 *   could not be cleaned up (never silently swallowed)
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
  maxBreakFailures = 3,
  warn = () => {},
  now = Date.now,
  sleep = sleepDefault,
  isProcessAlive = defaultIsProcessAlive,
  fsApi = defaultFs,
  pid = process.pid,
}) {
  if (typeof lockPath !== 'string' || lockPath === '') throw new Error('file-lock: lockPath is required')

  /**
   * Acquire the lock.
   * @param {{ timeoutMs?: number }} [options] per-call wait budget override;
   *   defaults to the lock's configured timeoutMs
   * @returns {Promise<() => Promise<void>>} release
   */
  async function acquire({ timeoutMs: waitBudget = timeoutMs } = {}) {
    const nonce = randomBytes(8).toString('hex')
    const started = now()
    const deadline = started + Math.max(0, Number(waitBudget) || 0)
    let handle = null
    let breakFailures = 0

    const busyError = () => {
      const busy = new Error(`The lock ${lockPath} is held by another process.`)
      busy.code = 'E_LOCK_BUSY'
      return busy
    }

    while (handle === null) {
      // Checked before every attempt, including the stale-break path below:
      // a lock that exists but cannot be removed must still end the wait.
      if (now() >= deadline) throw busyError()
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
        // A provably dead owner is always breakable. An ownerless file (foreign
        // or legacy lock) is only breakable by age. A live owner is never
        // broken by age alone: heartbeat refresh can lag behind a long GC pause.
        //
        // The one exception is a lock that has not been refreshed for ten stale
        // windows. That cannot be a live holder (the heartbeat runs every few
        // seconds), so it means a wedged process or — the common Windows case —
        // a dead pid the OS has since handed to an unrelated process. Waiting
        // forever on a recycled pid is worse than breaking a lock nobody owns,
        // so it is broken loudly.
        const recycledPid = owner.pid !== null && !deadOwner && age > staleMs * 10
        if (recycledPid) {
          warn(
            `file-lock: breaking ${lockPath} — pid ${owner.pid} is alive but the lock was not refreshed for ` +
              `${Math.round(age / 1000)}s (recycled pid or wedged holder)`,
          )
        }
        const stale = deadOwner || recycledPid || (owner.pid === null && age > staleMs)
        if (stale) {
          try {
            await fsApi.rm(lockPath, { force: true })
            breakFailures = 0
          } catch (rmError) {
            breakFailures += 1
            if (breakFailures >= maxBreakFailures) {
              const stuck = new Error(
                `The lock ${lockPath} is stale but could not be removed (${rmError?.code ?? 'unknown'}).`,
              )
              stuck.code = 'E_LOCK_BUSY'
              throw stuck
            }
          }
          await sleep(retryMs)
          continue
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
        if (owner.nonce === nonce) {
          try {
            await fsApi.rm(lockPath, { force: true })
          } catch (error) {
            // A lock we could not remove stays behind, and it records OUR pid —
            // which is alive — so every later acquire would find a live owner,
            // refuse to break it, and answer E_LOCK_BUSY until the process
            // restarts. Demote it to an ownerless lock instead: the next acquire
            // may still fail to delete it, but at least it can try, and a lock
            // that keeps resisting is reported rather than silently poisoning
            // the whole mutation path.
            const canRewrite = typeof fsApi.writeFile === 'function'
            const demoted = canRewrite
              ? await fsApi
                  .writeFile(lockPath, `${JSON.stringify({ pid: null, nonce: null, at: 0 })}\n`, 'utf8')
                  .then(() => true)
                  .catch(() => false)
              : false
            if (demoted === true && typeof fsApi.utimes === 'function') {
              await fsApi.utimes(lockPath, new Date(0), new Date(0)).catch(() => {})
            }
            warn(
              `file-lock: could not remove ${lockPath} (${error?.code ?? 'unknown'}); ` +
                (demoted === true ? 'marked it ownerless so the next acquire can break it' : 'it stays owned by this process'),
            )
          }
        }
      } finally {
        await handle?.close().catch(() => {})
      }
    }
  }

  return { acquire, lockPath }
}
