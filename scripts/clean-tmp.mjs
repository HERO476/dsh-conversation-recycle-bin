#!/usr/bin/env node
/**
 * Remove `test/.tmp` before a tarball is built.
 *
 * The suites create their fixtures under `test/.tmp/<random>` and clean up
 * afterwards, but on Windows a lingering handle (antivirus, a still-open log
 * file, a lock file whose owner process is slow to exit) makes `rm` fail
 * silently. `files` in package.json used to whitelist the whole `test/`
 * directory, and npm's `files` whitelist wins over `.gitignore`, so a
 * `npm pack` after `npm test` shipped those leftovers: a real session log, a
 * memory index and a `mutation-busy-*.lock`. The tarball then differed between
 * two runs of the same commit.
 *
 * `files` now names `test/*.mjs` explicitly, which already excludes the
 * directory; this script is the second line of defence (and keeps `npm pack`
 * output identical whether or not the tests ran in the same checkout).
 *
 * Best effort on purpose: a leftover fixture must never block a release. The
 * failure is printed so it is visible instead of silent.
 */
import { readdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const tmpDir = resolve(here, '..', 'test', '.tmp')

try {
  readdirSync(tmpDir)
} catch (error) {
  if (error?.code === 'ENOENT') process.exit(0)
  console.warn(`[pack] could not read ${tmpDir}: ${error?.code ?? error}`)
  process.exit(0)
}

try {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  console.log(`[pack] removed leftover test fixtures at ${tmpDir}`)
} catch (error) {
  console.warn(`[pack] could not remove ${tmpDir} (${error?.code ?? error}); check "files" in package.json`)
}
process.exit(0)
