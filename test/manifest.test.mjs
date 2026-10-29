import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, normalizeConfig } from '../lib/core/config.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (name) => readFile(join(root, name), 'utf8')
const readJson = async (name) => JSON.parse(await read(name))

test('manifest: package identity, exports and Bundle/Client declarations', async () => {
  const pkg = await readJson('package.json')
  assert.equal(pkg.name, 'dsh-conversation-recycle-bin')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject))
  for (const packageName of [
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-workspace',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-locale',
  ]) {
    assert.ok(pkg.dsh.client.inject.includes(packageName), `missing dsh.client.inject entry ${packageName}`)
  }
  const covered = (file) => pkg.files.some((entry) => {
    if (entry === file) return true
    if (entry === 'lib' && file.startsWith('lib/')) return true
    if (entry.includes('*')) {
      const prefix = entry.slice(0, entry.indexOf('*'))
      const suffix = entry.slice(entry.lastIndexOf('*') + 1)
      return file.startsWith(prefix) && file.endsWith(suffix)
    }
    return false
  })
  for (const file of ['lib/index.js', 'client.js', 'cordis.patch.yml', 'config.schema.json', 'icon.svg']) {
    assert.ok(covered(file), `files does not cover ${file}`)
  }
})

test('manifest: the Host row patch keeps a stable id equal to the package name row', async () => {
  const pkg = await readJson('package.json')
  const patch = await read('cordis.patch.yml')
  assert.match(patch, /-\s*insert:/)
  assert.match(patch, /id:\s*conversation-recycle-bin/)
  assert.match(patch, new RegExp(`name:\\s*${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
})

test('manifest: no shipped locale resources — the Client carries both inline tables', async () => {
  const pkg = await readJson('package.json')
  assert.equal(pkg.exports['./locale/*.json'], undefined)
  assert.ok(!pkg.files.some((entry) => entry.startsWith('locale/')), 'files still ships locale resources')
  const client = await read('client.js')
  assert.match(client, /const STRINGS = \{/)
  assert.match(client, /^\s{6}en: \{$/m)
  assert.match(client, /^\s{6}zh: \{$/m)
})

test('manifest: the icon parses as an SVG document', async () => {
  const icon = (await read('icon.svg')).trim()
  assert.ok(icon.startsWith('<svg'))
  assert.match(icon, /viewBox="0 0 64 64"/)
  assert.ok(icon.length < 256 * 1024)
})

test('manifest: the Client half exports the Cordis slots injection and the loader id', async () => {
  const client = await read('client.js')
  assert.match(client, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(client, /id:\s*'conversation-recycle-bin'/)
  assert.match(client, /exports\.inject = \['slots'\]/)
  assert.match(client, /exports\.apply = apply/)
  for (const slot of [
    'sidebar.workspaces.session.menu.item',
    'conversation.session.header.actions',
    'settings.section',
    'shell.overlay',
  ]) {
    assert.ok(client.includes(slot), `client does not register ${slot}`)
  }
})

test('manifest: the Host half exports name/inject/apply and deliberately no Config schema', async () => {
  const module = await import('../lib/index.js')
  assert.equal(module.name, 'conversation-recycle-bin')
  assert.deepEqual(module.inject, ['webServer'])
  assert.equal(typeof module.apply, 'function')
  // No schema runtime is a dependency of this package, so the row config is
  // validated by normalizeConfig and documented in config.schema.json.
  assert.equal(module.Config, undefined)
})

test('manifest: config.schema.json mirrors every normalized default key', async () => {
  const schema = await readJson('config.schema.json')
  assert.equal(schema.type, 'object')
  assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(DEFAULTS).sort())
  for (const key of ['memory', 'ui']) {
    assert.deepEqual(Object.keys(schema.properties[key].properties).sort(), Object.keys(DEFAULTS[key]).sort())
  }
  assert.deepEqual(Object.keys(schema.properties.memory.properties.lingshu.properties).sort(), Object.keys(DEFAULTS.memory.lingshu).sort())
  assert.deepEqual(Object.keys(schema.properties.memory.properties.generic.properties).sort(), Object.keys(DEFAULTS.memory.generic).sort())
  const { warnings } = normalizeConfig(undefined)
  assert.deepEqual(warnings, [])
})

test('manifest: the Host version constant matches package.json', async () => {
  const pkg = await readJson('package.json')
  const module = await import('../lib/index.js')
  assert.equal(module.PLUGIN_VERSION, pkg.version)
})

test('manifest: the README/INSTALL/CHANGELOG deliverables exist and are non-trivial', async () => {
  for (const file of ['README.md', 'INSTALL.md', 'CHANGELOG.md', 'LICENSE']) {
    const content = await read(file)
    assert.ok(content.length > 400, `${file} is too short`)
  }
})
