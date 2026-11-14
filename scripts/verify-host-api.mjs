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
 * Exit code: 0 = every assertion holds, 1 = drift found, 2 = host not found.
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const quiet = args.includes('--quiet')
const hostArg = args.find((value) => value.startsWith('--host='))?.slice('--host='.length)
  ?? process.env.DSH_HOST_DIR
  ?? ''

const results = []
function record(name, ok, detail) {
  results.push({ name, ok })
  if (quiet !== true) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
function skip(name, why) {
  results.push({ name, ok: true })
  if (quiet !== true) console.log(`SKIP  ${name} — ${why}`)
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
  return {
    kind: 'dir',
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

function asarCandidates() {
  const list = []
  if (platform() === 'win32') {
    list.push(join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'))
    list.push('C:/Users/34332/AppData/Local/Programs/DeepSeek Harness/resources/app.asar')
  }
  list.push(join(homedir(), 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'app.asar'))
  list.push('/opt/DeepSeek Harness/resources/app.asar')
  return list.filter((path) => path !== '' && existsSync(path)).map((path) => resolve(path))
}

async function openHost() {
  if (hostArg !== '') {
    if (existsSync(hostArg) !== true) return null
    return openDirectory(resolve(hostArg))
  }
  for (const candidate of asarCandidates()) {
    const reader = await openAsar(candidate)
    if (await reader.read('dsh/package.json') !== null) return reader
    await reader.close()
  }
  const profileRoot = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'node_modules', '@deepseek-ai', 'dsh')
  if (existsSync(profileRoot) === true) return openDirectory(profileRoot)
  return null
}

/* ------------------------------------------------------------------ *
 * Assertions
 * ------------------------------------------------------------------ */

const PKG = (name) => `dsh/node_modules/@deepseek-ai/${name}`

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

async function main() {
  const host = await openHost()
  if (host === null) {
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
    const hostPkg = JSON.parse(hostPkgText)
    const hostVersion = String(hostPkg.version ?? '')
    record('host package.json is readable', true, `${hostPkg.name ?? 'unknown'} ${hostVersion}`)

    // 1. The declared engine must still admit the installed build. A wrong
    //    range is silent: the plugin loads and then fails per-request.
    const engine = plugin.engines?.dsh ?? ''
    if (engine === '' || hostVersion === '') {
      skip('plugin engines.dsh admits the installed host', 'no engines.dsh or host version')
    } else {
      record('plugin engines.dsh admits the installed host', satisfiesRange(hostVersion, engine), `${hostVersion} vs ${engine}`)
    }

    // 2. `webServer.register({kind:'prefix'})` — the whole Host half hangs off
    //    this one call. `handler(req, res)` owns the response lifecycle.
    const webServer = await host.readFirst([`${PKG('dsh-host-webserver')}/src/index.ts`, `${PKG('dsh-host-webserver')}/lib/index.js`])
    if (webServer === null) {
      record('host exposes dsh-host-webserver', false, 'package missing')
    } else {
      record('webServer still supports kind "prefix"', /'exact'\s*\|\s*'prefix'|"exact"\s*\|\s*"prefix"|kind===\"prefix\"|kind:'prefix'/.test(webServer))
      record('webServer handler keeps the (req, res) signature', /handler:\s*\(req,\s*res\)|handler\(req,\s*res\)/.test(webServer))
    }

    // 3. The client-module contract: `load({id, factory})` plus the
    //    `<row.id>/client.js` resource rule the bundle URL depends on.
    const clientModules = await host.readFirst([`${PKG('dsh-client-modules')}/src/client/system.ts`, `${PKG('dsh-client-modules')}/lib/index.js`])
    if (clientModules === null) {
      record('host exposes dsh-client-modules', false, 'package missing')
    } else {
      record('client module system keeps __ModuleLoader__.load', clientModules.includes('__ModuleLoader__'))
      record('client resource stays <id>/client.js', /client\.js/.test(clientModules))
    }

    // 4. Every Slot the Client renders into must still be contributed by some
    //    Host package. A renamed Slot is invisible: nothing errors, the entry
    //    simply never renders. The owner list is scanned by folder rather than
    //    by a fixed filename — a Slot can be injected from a mount module the
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
        const base = PKG(owner)
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
