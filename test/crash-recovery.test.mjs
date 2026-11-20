/**
 * Cross-process lock behaviour.
 *
 * Every other suite simulates a peer by writing a lock FILE in the same process.
 * That cannot prove the two properties users actually depend on after a crash:
 *
 *   1. a lock left behind by a KILLED process must be breakable at once — a dead
 *      pid is not a reason to tell the user to wait twenty minutes;
 *   2. a lock held by a LIVE process must not be broken by age, or two Hosts
 *      sharing one DSH_HOME would both mutate the same session log.
 *
 * Both need a real second process, so this file spawns one and kills it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFileLock } from '../lib/core/file-lock.js'

const LOCK_MODULE = new URL('../lib/core/file-lock.js', import.meta.url).href

/** A child that takes the lock, says so, and then idles until it is killed. */
const HOLDER_SOURCE = `
import { createFileLock } from ${JSON.stringify(LOCK_MODULE)}
const lock = createFileLock({ lockPath: process.argv[2], heartbeatMs: 200 })
await lock.acquire()
process.stdout.write('HELD\\n')
setInterval(() => {}, 1000)
`

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'rcb-crash-'))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

/** Spawn a holder and resolve once it reports the lock is taken. */
async function startHolder(dir, lockPath) {
  const holderPath = join(dir, 'holder.mjs')
  await writeFile(holderPath, HOLDER_SOURCE, 'utf8')
  const child = spawn(process.execPath, [holderPath, lockPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.setEncoding('utf8')
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`holder never reported HELD (stdout: ${JSON.stringify(out)})`)), 15_000)
    child.stdout.on('data', (chunk) => {
      out += chunk
      if (out.includes('HELD')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      if (!out.includes('HELD')) {
        clearTimeout(timer)
        reject(new Error(`holder exited (${code}) before taking the lock`))
      }
    })
  })
  return child
}

function waitForClose(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    child.once('close', resolve)
  })
}

test('crash: a lock left by a killed process is breakable at once', async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, 'mutation.lock')
    const holder = await startHolder(dir, lockPath)
    try {
      // The holder is alive, so this must NOT be breakable: that is the property
      // two Hosts sharing one DSH_HOME rely on.
      const blocked = createFileLock({ lockPath, timeoutMs: 400, retryMs: 50 })
      await assert.rejects(
        () => blocked.acquire(),
        (error) => error?.code === 'E_LOCK_BUSY',
        'a live holder must not be broken by age',
      )
    } finally {
      holder.kill('SIGKILL')
      await waitForClose(holder)
    }

    // Now the pid is provably gone: the next acquire must succeed immediately
    // instead of counting down a stale window the user experiences as a hang.
    const warnings = []
    const after = createFileLock({ lockPath, timeoutMs: 5_000, retryMs: 25, warn: (message) => warnings.push(message) })
    const release = await after.acquire()
    await release()
  })
})

test('crash: two processes cannot both hold the lock', async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, 'mutation.lock')
    const first = await startHolder(dir, lockPath)
    try {
      // A second real process contends and loses while the first is alive.
      const second = createFileLock({ lockPath, timeoutMs: 500, retryMs: 50 })
      await assert.rejects(() => second.acquire(), (error) => error?.code === 'E_LOCK_BUSY')
    } finally {
      first.kill('SIGKILL')
      await waitForClose(first)
    }
    // Killing the winner frees the lock for the next process.
    const next = createFileLock({ lockPath, timeoutMs: 5_000, retryMs: 25 })
    const release = await next.acquire()
    await release()
  })
})
