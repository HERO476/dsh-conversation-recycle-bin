// Parse-only syntax check for every shipped JS file (every .js under lib/,
// plus client.js). `node --check` per file keeps the same semantics as the old
// explicit chain but no longer drifts when a module is added or renamed.
// Run via `npm run check`.
//
// Exit codes are distinct on purpose:
//   0  every file parsed
//   1  at least one file has a syntax error
//   2  the checker could not be spawned, so syntax status is UNKNOWN
// (2 used to be indistinguishable from 1: a sandbox EPERM on spawnSync came out
// as `SYNTAX FAIL <file>` with `stderr` undefined, sending readers after a typo
// that did not exist.)

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const files = []
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.js')) files.push(full)
  }
}
walk('lib')
files.push('client.js')

let failed = 0
let unspawned = 0
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.error) {
    unspawned += 1
    const code = result.error.code ?? 'unknown'
    console.error(`CHECK UNAVAILABLE ${relative('.', file)}: ${code} ${result.error.message}`)
    continue
  }
  if (result.status !== 0) {
    failed += 1
    const detail = result.stderr || result.stdout || `exited with status ${String(result.status)}`
    console.error(`SYNTAX FAIL ${file}\n${detail}`)
  } else {
    console.log(`ok ${relative('.', file)}`)
  }
}

if (unspawned > 0) {
  console.error(`\n${unspawned}/${files.length} files could not be checked: node --check never started.`)
  console.error('This is an environment/spawn restriction, not a syntax error. Re-run outside the sandbox.')
  process.exit(2)
}
process.exit(failed === 0 ? 0 : 1)