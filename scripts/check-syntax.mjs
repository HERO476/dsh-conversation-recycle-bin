// Parse-only syntax check for every shipped JS file (every .js under lib/,
// plus client.js). `node --check` per file keeps the same semantics as the old
// explicit chain but no longer drifts when a module is added or renamed.
// Run via `npm run check`; exits non-zero when any file fails to parse.

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
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    failed += 1
    console.error(`SYNTAX FAIL ${file}\n${result.stderr ?? result.stdout}`)
  } else {
    console.log(`ok ${relative('.', file)}`)
  }
}
process.exit(failed === 0 ? 0 : 1)
