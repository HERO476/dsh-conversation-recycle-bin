#!/usr/bin/env node
/**
 * Run every test file, even after one fails.
 *
 * `npm test` used to chain the suites with `&&`, so the first failure aborted
 * the run and the remaining files were never executed. That is exactly how a
 * locale-dependent assertion in `client-module.test.mjs` could make CI look
 * "mostly green" while eight suites had not run at all. This runner spawns each
 * file in order, streams its output, and exits non-zero if any file failed.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const testDir = resolve(here, '..', 'test')

// The historical order: cheap manifest/contract checks first, the slow HTTP
// suite last. Files not listed here still run, appended alphabetically.
const PREFERRED_ORDER = [
  'manifest',
  'client-module',
  'core',
  'retention',
  'cascade',
  'memory',
  'trash-audit',
  'feedback',
  'api',
]

const available = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .map((name) => name.slice(0, -'.test.mjs'.length))

const ordered = [
  ...PREFERRED_ORDER.filter((name) => available.includes(name)),
  ...available.filter((name) => !PREFERRED_ORDER.includes(name)).sort(),
]

let failed = 0
const failedFiles = []
for (const name of ordered) {
  const file = join(testDir, `${name}.test.mjs`)
  process.stdout.write(`\n▶ test/${name}.test.mjs\n`)
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit', env: process.env })
  if (result.status !== 0) {
    failed += 1
    failedFiles.push(name)
    process.stdout.write(`✖ test/${name}.test.mjs exited with ${result.status ?? result.signal}\n`)
  }
}

process.stdout.write(`\n${ordered.length - failed}/${ordered.length} test files passed\n`)
if (failed > 0) {
  process.stdout.write(`failed: ${failedFiles.join(', ')}\n`)
  process.exit(1)
}
