#!/usr/bin/env node
/**
 * Host-API contract snapshot: does THIS dsh build still look like the one this
 * plugin was written against?
 *
 * `test/` runs against a fake Host, so it cannot answer that. `verify-host-contract.mjs`
 * answers it for a RUNNING Host, but needs a session and a live process. This
 * probe sits in between: it reads the installed Host package and asserts the
 * few shapes the plugin actually depends on, so a runtime upgrade that renames
 * a route kind, changes a handler signature or drops a Slot fails here instead
 * of as "the delete button vanished" on one of the two carriers.
 *
 * It never writes, never mounts, and needs no session.
 *
 * Usage:
 *   node scripts/verify-host-api.mjs [--host=<dir>] [--quiet]
 *
 *   --host  a dsh package directory (the one containing dsh-host-webserver).
 *           Defaults to $DSH_HOST_DIR; otherwise the probe looks for
 *           <app.asar>/dsh (Windows desktop), then
 *           $DSH_HOME/profiles/node_modules/@deepseek-ai/dsh.
 *
 *   --allow-missing-host  exit 0 (with an explicit SKIP line) when no Host
 *                         installation is present. For CI runners, which never
 *                         have a desktop Host: a red build there says nothing
 *                         about drift, and a silent green says nothing at all 鈥? *                         so the skip is printed.
 *
 * Exit code: 0 = every assertion holds, 1 = drift found, 2 = host not found.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const quiet = args.includes('--quiet')
const allowMissingHost = args.includes('--allow-missing-host')
/** Release-time mode: a missing Host is a FAILURE, never a skip. */
const requireHost = args.includes('--require-host')
/** Record the assertion list for this Host build (used to refresh the snapshot). */
const writeSnapshotPath = args.find((value) => value.startsWith('--write-snapshot='))?.slice('--write-snapshot='.length) ?? ''
/**
 * Compare against a committed assertion list. Only the NAMES are compared: the
 * pass/fail values depend on the Host that is installed, while the list of
 * assertions is what a refactor can silently drop. This is what lets a
 * Host-less CI runner notice that someone deleted a contract check.
 */
const snapshotPath = args.find((value) => value.startsWith('--snapshot='))?.slice('--snapshot='.length) ?? ''
const hostArg = args.find((value) => value.startsWith('--host='))?.slice('--host='.length)
  ?? process.env.DSH_HOST_DIR
  ?? ''

/**
 * The assertion names this probe must run, whether or not a Host is installed.
 *
 * The snapshot check used to live after the "no Host" early return, so the one
 * runner that cannot read a Host — CI — was also the runner where the check was
 * unreachable. A Host-less run compared nothing and exited 0 while assertions
 * were being deleted. Comparing against this fixed list makes the deletion
 * visible without a Host; comparing `results` against it makes a silently
 * skipped assertion visible when a Host IS present.
 */
const DECLARED_ASSERTIONS = [
  'host package.json is readable',
  'plugin engines.dsh admits the installed host',
  'webServer still supports kind "prefix"',
  'webServer handler keeps the (req, res) signature',
  'client module system keeps __ModuleLoader__.load',
  'client resource stays <id>/client.js',
  'slot sidebar.workspaces.session.menu.item is still contributed',
  'slot conversation.session.header.actions is still contributed',
  'slot shell.overlay is still contributed',
  'slot settings.section is still contributed',
  'client bundle registers under the package name',
  'dsh-workspace still publishes workspace/session-archived',
  'dsh-workspace still publishes workspace/session-unarchiving',
  'host project keys stay bounded at 251 chars',
  'host escapes unsafe code units as ~XXXX',
  'host still ships the projection cache the checkpoint shape belongs to',
  'plugin projectKey reproduces the golden vector',
  'plugin session segment passes a plain id through',
  'plugin session segment escapes a separator',
  'plugin projection version matches the Host checkpoint spec',
]

const results = []
function record(name, ok, detail) {
  results.push({ name, ok })
  if (quiet !== true) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` 鈥?${detail}` : ''}`)
}
function skip(name, why) {
  results.push({ name, ok: true })
  if (quiet !== true) console.log(`SKIP  ${name} 鈥?${why}`)
}

/* ------------------------------------------------------------------ *
 * Host location
 * ------------------------------------------------------------------ */

/** Minimal read-only asar reader: header JSON, then uncompressed entries. */
async function openAsar(path) {
  const { open } = await import('node:fs/promises')
  const handle = await open(path, 'r')
  const head = Buffer.alloc(16)
  await handle.read(head, 0, 16, 0)
  const headerSize = head.readUInt32LE(12)
  const headerBuffer = Buffer.alloc(headerSize)
  await handle.read(headerBuffer, 0, headerSize, 16)
  const header = JSON.parse(headerBuffer.toString('utf8'))
  // The pickle pads the JSON string to a 4-byte boundary; treating the declared
  // length as the data offset shifts every entry by up to 3 bytes and yields
  // "Unexpected token '}'" from an otherwise valid package.json.
  const base = 16 + Math.ceil(headerSize / 4) * 4
  const entry = (relPath) => {
    let node = header
    for (const segment of relPath.split('/').filter(Boolean)) {
      if (!node.files || !node.files[segment]) return null
      node = node.files[segment]
    }
    return node
  }
  return {
    kind: 'asar',
    // An app.asar always nests the runtime under `dsh/`.
    pkgPrefix: 'dsh',
    label: path,
    async read(relPath) {
      const node = entry(relPath)
      if (node === null || node.files) return null
      const buffer = Buffer.alloc(node.size)
      await handle.read(buffer, 0, node.size, base + Number(node.offset))
      return buffer.toString('utf8')
    },
    async readFirst(candidates) {
      for (const candidate of candidates) {
        const text = await this.read(candidate)
        if (text !== null) return text
      }
      return null
    },
    /** Every file path under `prefix` (recursive), as host-relative paths. */
    async list(prefix) {
      const root = entry(prefix)
      if (root === null || !root.files) return []
      const out = []
      const walk = (node, path) => {
        for (const [name, child] of Object.entries(node.files ?? {})) {
          const next = `${path}/${name}`
          if (child.files) walk(child, next)
          else out.push(next)
        }
      }
      walk(root, prefix.replace(/\/+$/, ''))
      return out
    },
    async close() { await handle.close() },
  }
}

function openDirectory(root) {
  // The `dsh/` nesting is an asar-layout detail, not a rule. Inside app.asar the
  // Host packages sit at `dsh/node_modules/@deepseek-ai`; a `--host` package
  // directory or the unpacked `resources/app` tree puts them one level up. A
  // wrong prefix turns every assertion into a false "package missing", which is
  // exactly how this probe used to report 9 phantom drifts.
  const pkgPrefix = existsSync(join(root, 'dsh', 'node_modules', '@deepseek-ai'))
    ? 'dsh'
    : ''
  return {
    kind: 'dir',
    pkgPrefix,
    label: root,
    async read(relPath) {
      const path = join(root, relPath)
      if (existsSync(path) !== true) return null
      return readFile(path, 'utf8')
    },
    async readFirst(candidates) {
      for (const candidate of candidates) {
        const text = await this.read(candidate)
        if (text !== null) return text
      }
      return null
    },
    async list(prefix) {
      const { readdir } = await import('node:fs/promises')
      const out = []
      const walk = async (absolute, relative) => {
        let entries
        try {
          entries = await readdir(absolute, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          const nextAbsolute = join(absolute, entry.name)
          const nextRelative = `${relative}/${entry.name}`
          if (entry.isDirectory()) await walk(nextAbsolute, nextRelative)
          else out.push(nextRelative)
        }
      }
      await walk(join(root, prefix), prefix.replace(/\/+$/, ''))
      return out
    },
    async close() {},
  }
}

/**
 * Every path an installed desktop Host can live at, most-authoritative first.
 *
 * The old list only knew `app.asar`. Once anything renames that file 鈥?the
 * community purge tool does exactly that, leaving `app.asar.dshpurge-disabled`
 * 鈥?the probe skipped the real Host, fell back to a profile copy of the CLI and
 * reported ten phantom drifts against the wrong package. The unpacked `app/`
 * directory comes first because that is what Electron actually runs whenever
 * app.asar is absent.
 */
function hostCandidates() {
  const resourcesDirs = []
  if (platform() === 'win32') {
    resourcesDirs.push(join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources'))
    resourcesDirs.push('C:/Users/34332/AppData/Local/Programs/DeepSeek Harness/resources')
  }
  resourcesDirs.push(join(homedir(), 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources'))
  resourcesDirs.push('/opt/DeepSeek Harness/resources')
  const candidates = []
  for (const resources of resourcesDirs) {
    if (resources === '' || existsSync(resources) !== true) continue
    for (const name of ['app', 'app.asar', 'app.asar.dshpurge-disabled']) {
      const path = join(resources, name)
      if (existsSync(path) === true) candidates.push(resolve(path))
    }
  }
  return candidates
}

/** Open one candidate as a Host reader, or null when it is not a dsh package tree. */
async function probeHost(path) {
  let reader = null
  try {
    reader = statSync(path).isDirectory() ? openDirectory(path) : await openAsar(path)
  } catch {
    return null
  }
  const text = await reader.readFirst(['dsh/package.json', 'package.json'])
  if (text !== null) return reader
  await reader.close?.()
  return null
}

async function openHost() {
  if (hostArg !== '') {
    if (existsSync(hostArg) !== true) return null
    return probeHost(resolve(hostArg))
  }
  for (const candidate of hostCandidates()) {
    const reader = await probeHost(candidate)
    if (reader !== null) return reader
  }
  // Last resort, and loudly: a profile copy of `@deepseek-ai/dsh` is usually the
  // CLI, not the desktop runtime this plugin ships against. Silence here is what
  // made the default invocation look like real Host drift.
  const profileRoot = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'node_modules', '@deepseek-ai', 'dsh')
  if (existsSync(profileRoot) === true) {
    console.log(`WARN  no desktop Host tree found; falling back to a profile copy at ${profileRoot}.`)
    console.log('      That is usually the CLI package, not the desktop runtime. Pass --host=<鈥?resources/app> to check the desktop tree.')
    return openDirectory(profileRoot)
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Assertions
 * ------------------------------------------------------------------ */

/**
 * Resolve a Host package path inside whichever layout was opened. An app.asar
 * nests everything under `dsh/`; an unpacked tree or a package directory does
 * not. Getting this wrong is indistinguishable from real contract drift.
 */
function hostPkg(host, name) {
  const prefix = host?.pkgPrefix ?? 'dsh'
  const inner = `node_modules/@deepseek-ai/${name}`
  return prefix === '' ? inner : `${prefix}/${inner}`
}

/** Compare a version against the plugin's `engines.dsh` without a dependency. */
function satisfiesRange(version, range) {
  // Only the operator the plugin ships is needed: `>=A <B || >=C <D`.
  const alternatives = range.split('||').map((part) => part.trim()).filter(Boolean)
  const parse = (text) => text.split(/[.\-+]/).slice(0, 3).map((piece) => (piece === '' ? 0 : Number.isFinite(Number(piece)) ? Number(piece) : piece))
  const compare = (left, right) => {
    for (let index = 0; index < 3; index += 1) {
      const a = left[index] ?? 0
      const b = right[index] ?? 0
      if (typeof a === 'number' && typeof b === 'number') {
        if (a !== b) return a < b ? -1 : 1
      } else if (String(a) !== String(b)) {
        return String(a) < String(b) ? -1 : 1
      }
    }
    return 0
  }
  for (const alternative of alternatives) {
    const bounds = alternative.match(/(>=|<=|>|<|=)?\s*([0-9][0-9A-Za-z.\-+]*)/g) ?? []
    let holds = true
    for (const bound of bounds) {
      const operator = bound.match(/^(>=|<=|>|<|=)/)?.[0] ?? '='
      const target = parse(bound.replace(/^(>=|<=|>|<|=)/, '').trim())
      const verdict = compare(parse(version), target)
      const ok = operator === '>=' ? verdict >= 0
        : operator === '<=' ? verdict <= 0
          : operator === '>' ? verdict > 0
            : operator === '<' ? verdict < 0
              : verdict === 0
      if (ok !== true) { holds = false; break }
    }
    if (holds) return true
  }
  return false
}

/** Read a committed assertion snapshot, tolerating a missing or malformed file. */
async function readSnapshotQuietly(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.assertions)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * How a snapshot comparison failed, or null when it holds.
 *
 * Three directions, because each one is a different accident:
 *   missing  — the snapshot names an assertion that no longer runs (deleted).
 *   skipped  — a declared assertion produced no result on this run.
 *   stale    — the snapshot is older than the declaration list, i.e. it would
 *              NOT notice a future deletion. A snapshot that is missing entries
 *              must be refreshed, not silently accepted.
 */
function snapshotProblem(recorded, names) {
  if (recorded === null) return 'the recorded assertion list is not readable'
  const missing = recorded.assertions.filter((name) => !names.includes(name))
  if (missing.length > 0) return `missing: ${missing.join(', ')}`
  const skipped = DECLARED_ASSERTIONS.filter((name) => !names.includes(name))
  if (skipped.length > 0) return `declared but never ran: ${skipped.join(', ')}`
  const stale = DECLARED_ASSERTIONS.filter((name) => !recorded.assertions.includes(name))
  if (stale.length > 0) return `snapshot is stale; it does not record: ${stale.join(', ')}`
  return null
}

/** Host-less variant: compare the snapshot to the fixed declaration list. */
async function checkSnapshotAgainst(names) {
  if (snapshotPath === '') return true
  const recorded = await readSnapshotQuietly(snapshotPath)
  const problem = snapshotProblem(recorded, names)
  console.log(`${problem === null ? 'PASS' : 'FAIL'}  snapshot: every recorded contract assertion still runs — ${problem ?? `${recorded.assertions.length} assertion(s)`}`)
  return problem === null
}

async function main() {
  const host = await openHost()
  if (host === null) {
    if (requireHost === true) {
      console.log('FAIL  --require-host was passed but no dsh installation was found.')
      console.log('      Run this where the desktop app is installed, or set DSH_HOST_DIR.')
      return 2
    }
    if (allowMissingHost === true) {
      // Loud on purpose: a CI run that quietly passes without reading a Host is
      // worse than no gate, because it looks like coverage. Say exactly how much
      // coverage was NOT executed, and against which build it was last proven.
      const recorded = snapshotPath === '' ? null : await readSnapshotQuietly(snapshotPath)
      if (recorded !== null) {
        console.log(`SKIP  no dsh installation found in this runner; ${recorded.assertions.length} host-API assertion(s) were NOT executed.`)
        console.log(`      Last proven on ${recorded.hostVersion}; refresh with:`)
        console.log(`      npm run check:host-api -- --write-snapshot=${snapshotPath}`)
      } else {
        console.log('SKIP  no dsh installation found in this runner; host-API assertions were NOT executed.')
      }
      console.log('      Run this on a machine with the desktop app (or set DSH_HOST_DIR) before releasing.')
      // Deleting an assertion is the one drift a Host-less runner can still
      // detect — which is exactly why it must not sit behind this early return.
      if (await checkSnapshotAgainst(DECLARED_ASSERTIONS) !== true) return 1
      return 0
    }
    console.log('FAIL  host package not found; pass --host=<dir> or set DSH_HOST_DIR')
    return 2
  }

  try {
    const plugin = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const hostPkgText = await host.readFirst(['dsh/package.json', 'package.json'])
    if (hostPkgText === null) {
      record('host package.json is readable', false, 'no dsh/package.json in the selected host')
      return 1
    }
    // `hostPackage`, not `hostPkg`: the latter is the path-resolver function.
    const hostPackage = JSON.parse(hostPkgText)
    const hostVersion = String(hostPackage.version ?? '')
    record('host package.json is readable', true, `${hostPackage.name ?? 'unknown'} ${hostVersion} (${host.label})`)

    // `engines.dsh` no longer stops at 0.3.0: a hard upper bound made the Host
    // REFUSE to load the plugin on an upgrade (a throw, not a warning), which is
    // worse than a build this release was never run against. The trade is that
    // the range now covers untested lines, so say so instead of implying
    // support.
    const hostLine = hostVersion.split('.').slice(0, 2).join('.')
    if (hostLine !== '0.2') {
      console.log(`WARN  host ${hostVersion} is outside the regression-tested 0.2.x line: run the full suites and a real delete on this build before shipping.`)
    }

    // 1. The declared engine must still admit the installed build. A wrong
    //    range is silent: the plugin loads and then fails per-request.
    const engine = plugin.engines?.dsh ?? ''
    if (engine === '' || hostVersion === '') {
      skip('plugin engines.dsh admits the installed host', 'no engines.dsh or host version')
    } else {
      record('plugin engines.dsh admits the installed host', satisfiesRange(hostVersion, engine), `${hostVersion} vs ${engine}`)
    }

    // 2. `webServer.register({kind:'prefix'})` 鈥?the whole Host half hangs off
    //    this one call. `handler(req, res)` owns the response lifecycle.
    const webServer = await host.readFirst([`${hostPkg(host, 'dsh-host-webserver')}/src/index.ts`, `${hostPkg(host, 'dsh-host-webserver')}/lib/index.js`])
    if (webServer === null) {
      record('host exposes dsh-host-webserver', false, 'package missing')
    } else {
      record('webServer still supports kind "prefix"', /'exact'\s*\|\s*'prefix'|"exact"\s*\|\s*"prefix"|kind===\"prefix\"|kind:'prefix'/.test(webServer))
      record('webServer handler keeps the (req, res) signature', /handler:\s*\(req,\s*res\)|handler\(req,\s*res\)/.test(webServer))
    }

    // 3. The client-module contract: `load({id, factory})` plus the
    //    `<row.id>/client.js` resource rule the bundle URL depends on.
    const clientModules = await host.readFirst([`${hostPkg(host, 'dsh-client-modules')}/src/client/system.ts`, `${hostPkg(host, 'dsh-client-modules')}/lib/index.js`])
    if (clientModules === null) {
      record('host exposes dsh-client-modules', false, 'package missing')
    } else {
      record('client module system keeps __ModuleLoader__.load', clientModules.includes('__ModuleLoader__'))
      record('client resource stays <id>/client.js', /client\.js/.test(clientModules))
    }

    // 4. Every Slot the Client renders into must still be contributed by some
    //    Host package. A renamed Slot is invisible: nothing errors, the entry
    //    simply never renders. The owner list is scanned by folder rather than
    //    by a fixed filename 鈥?a Slot can be injected from a mount module the
    //    package adds at any point in its life.
    const slots = [
      { slot: 'sidebar.workspaces.session.menu.item', owners: ['dsh-client-ui-workspace'] },
      { slot: 'conversation.session.header.actions', owners: ['dsh-client-ui-agent-preset', 'dsh-client-ui-conversation'] },
      { slot: 'shell.overlay', owners: ['dsh-client-ui-shell', 'dsh-client-ui-agent-team', 'dsh-client-ui-settings'] },
      { slot: 'settings.section', owners: ['dsh-client-ui-settings', 'dsh-client-ui-settings-plugins'] },
    ]
    const TEXT_FILE = /\.(ts|tsx|js|mjs|md|json)$/u
    for (const { slot, owners } of slots) {
      let found = false
      for (const owner of owners) {
        const base = hostPkg(host, owner)
        const paths = [
          ...await host.list(`${base}/src/client`),
          ...await host.list(`${base}/lib`),
          `${base}/README.md`,
        ].filter((path) => TEXT_FILE.test(path))
        for (const path of paths.slice(0, 60)) {
          const text = await host.read(path)
          if (text !== null && text.includes(slot)) { found = true; break }
        }
        if (found) break
      }
      record(`slot ${slot} is still contributed`, found)
    }

    // 5. The Client registers under the package name: the boot graph keys rows
    //    by `package.json#name`, and a mismatch aborts web boot outright.
    const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
    const declaredId = clientSource.match(/id:\s*'([^']+)'/)?.[1] ?? ''
    record('client bundle registers under the package name', declaredId === plugin.name, `id=${declaredId || 'missing'} name=${plugin.name}`)

    // 6. The archive lifecycle events the "archive 鈫?recycle bin" path hangs off.
    //    `ctx.on` ACCEPTS an event name nobody publishes (Cordis creates the hook
    //    list on demand), so a rename would not throw: the feature would simply
    //    never fire while the UI kept promising a 30-day cleanup. Assert the
    //    publisher, not our own listener.
    const workspaceRegistry = await host.readFirst([
      `${hostPkg(host, 'dsh-workspace')}/src/index.ts`,
      `${hostPkg(host, 'dsh-workspace')}/lib/index.js`,
    ])
    if (workspaceRegistry === null) {
      record('host exposes dsh-workspace (archive events)', false, 'package missing')
    } else {
      // Plain substring checks on purpose: the assertion is "this package still
      // names the events", and a regex here would be one more thing to escape
      // wrong on the two source layouts the probe has to read.
      record(
        'dsh-workspace still publishes workspace/session-archived',
        workspaceRegistry.includes('workspace/session-archived'),
      )
      record(
        'dsh-workspace still publishes workspace/session-unarchiving',
        workspaceRegistry.includes('workspace/session-unarchiving'),
      )
    }

    // 7. Data-layout golden vectors. The plugin reimplements Host-PRIVATE
    //    encodings 鈥?project directory keys, session path segments, the
    //    projection checkpoint shape 鈥?and none of that is a public API. A
    //    silent change there restores a conversation into the wrong directory,
    //    or titles every row blank, with no error anywhere. Assert both sides:
    //    the Host source still contains the rules, and this plugin still
    //    produces the documented output for a fixed input set.
    const format = await host.readFirst([
      `${hostPkg(host, 'dsh-session-persistence-jsonl')}/src/format.ts`,
      `${hostPkg(host, 'dsh-session-persistence-jsonl')}/lib/index.js`,
    ])
    if (format === null) {
      record('host exposes dsh-session-persistence-jsonl', false, 'package missing')
    } else {
      record('host project keys stay bounded at 251 chars', format.includes('251'))
      record('host escapes unsafe code units as ~XXXX', /padStart\(4,\s*'0'\)|~[0-9A-F]{4}/.test(format))
      const projectionCache = await host.readFirst([
        `${hostPkg(host, 'dsh-session-projection-cache')}/src/index.ts`,
        `${hostPkg(host, 'dsh-session-projection-cache')}/lib/index.js`,
      ])
      record(
        'host still ships the projection cache the checkpoint shape belongs to',
        projectionCache !== null,
        projectionCache === null ? 'dsh-session-projection-cache missing' : undefined,
      )
    }
    const { projectKey, encodeSessionSegment } = await import('../lib/host/paths.js')
    const keyVector = projectKey('D:\\Work')
    record('plugin projectKey reproduces the golden vector', keyVector === '--D-Work--', keyVector)
    record('plugin session segment passes a plain id through', encodeSessionSegment('session-1') === 'session-1')
    record('plugin session segment escapes a separator', encodeSessionSegment('a/b') === 'a~002Fb', encodeSessionSegment('a/b'))
    const gatewaySource = await readFile(new URL('../lib/host/gateway.js', import.meta.url), 'utf8')
    const pluginProjection = Number((gatewaySource.match(/PROJECTION_VERSION\s*=\s*(\d+)/) ?? [])[1])
    // The previous version of this assertion only grepped the PLUGIN's own
    // source for `= 7`, so a Host bump to 8 left it green while every row
    // silently lost its title. Compare against the Host's own checkpoint spec.
    const projectionSpec = await host.readFirst([
      `${hostPkg(host, 'dsh-session-projection-cache')}/src/spec.ts`,
      `${hostPkg(host, 'dsh-session-projection-cache')}/lib/index.js`,
    ])
    const hostProjection = projectionSpec === null
      ? null
      : Number(((projectionSpec.match(/version:\s*(\d+)/) ?? [])[1]))
    record(
      'plugin projection version matches the Host checkpoint spec',
      Number.isFinite(pluginProjection) && hostProjection !== null && pluginProjection === hostProjection,
      `host ${hostProjection} vs plugin ${pluginProjection}`,
    )

    if (writeSnapshotPath !== '') {
      const snapshot = { hostVersion, assertions: results.map((item) => item.name) }
      await writeFile(writeSnapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
      if (quiet !== true) console.log(`\nsnapshot written: ${writeSnapshotPath} (${snapshot.assertions.length} assertion(s), host ${hostVersion})`)
    }
    if (snapshotPath !== '') {
      const names = results.map((item) => item.name)
      const recorded = await readSnapshotQuietly(snapshotPath)
      const problem = snapshotProblem(recorded, names)
      record(
        'snapshot: every recorded contract assertion still runs',
        problem === null,
        problem ?? `${recorded.assertions.length} assertion(s)`,
      )
    }

    const failed = results.filter((item) => item.ok !== true)
    if (failed.length > 0) {
      console.log(`\n${failed.length} contract assertion(s) drifted. Re-read the plugin against this host build before releasing.`)
      return 1
    }
    if (quiet !== true) console.log('\nHost API contract holds.')
    return 0
  } finally {
    await host.close()
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('probe error:', error?.message ?? error)
    process.exit(2)
  })
