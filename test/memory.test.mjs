import assert from 'node:assert/strict'
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../lib/core/config.js'
import { createLingshuAdapter } from '../lib/core/memory/lingshu.js'
import { createJsonIndexMemoryAdapter } from '../lib/core/memory/json-index-adapter.js'
import { createMemoryService } from '../lib/core/memory/registry.js'

const SESSION_1 = 'session-11111111-aaaa'
const SESSION_2 = 'session-22222222-bbbb'

async function makeStore() {
  const root = join(process.cwd(), 'test', '.tmp', `md-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  await mkdir(join(root, 'contextual'), { recursive: true })
  const index = {
    schema: 2,
    nodes: {
      n1: { session: SESSION_1, path: 'contextual/n1.md', protected: null },
      n2: { session: SESSION_1, path: 'contextual/n2.md', protected: null },
      n3: { session: SESSION_2, path: 'contextual/n3.md', protected: null },
      n4: { session: SESSION_1, path: 'contextual/n4.md', protected: true },
      n5: { session: SESSION_1, path: 'contextual/n5.md', protected: null, edges: [{ target: 'n1', type: 'derived_from' }] },
      n6: { session: SESSION_2, path: 'contextual/n6.md', protected: null, depends_on: ['n1'], derived_from: [] },
    },
  }
  for (const node of Object.values(index.nodes)) {
    await writeFile(join(root, node.path), `# ${node.path}\n`, 'utf8')
  }
  await writeFile(join(root, '_index.json'), JSON.stringify(index), 'utf8')
  return { root, index, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }) }
}

test('lingshu adapter: counts only deletable nodes and reports protected ones', async () => {
  const store = await makeStore()
  try {
    const adapter = createLingshuAdapter({ rootDir: store.root })
    const probe = await adapter.probe()
    assert.equal(probe.available, true)
    const result = await adapter.countSessions([SESSION_1, SESSION_2])
    assert.equal(result.counts.get(SESSION_1), 3)
    assert.equal(result.counts.get(SESSION_2), 2)
    assert.equal(result.protected, 1)
  } finally {
    await store.cleanup()
  }
})

test('lingshu adapter: export moves entries + content and strips dangling references', async () => {
  const store = await makeStore()
  const trashDir = join(store.root, '..', `trash-${Date.now()}`)
  try {
    const adapter = createLingshuAdapter({ rootDir: store.root })
    const bundle = await adapter.exportSession(SESSION_1, trashDir)

    assert.equal(bundle.count, 3)
    assert.equal(bundle.entries.length, 3)
    assert.ok(bundle.bundlePath.endsWith('bundle.json'))
    const after = JSON.parse(await readFile(join(store.root, '_index.json'), 'utf8'))
    assert.deepEqual(Object.keys(after.nodes).sort(), ['n3', 'n4', 'n6'])
    assert.deepEqual(after.nodes.n6.depends_on, [])
    assert.equal(bundle.links.length, 1)
    assert.equal(bundle.links[0].nodeId, 'n6')

    // Content moved out of the live store, into the bundle.
    await assert.rejects(readFile(join(store.root, 'contextual', 'n1.md')), { code: 'ENOENT' })
    const stored = await readFile(join(trashDir, 'memory', 'lingshu', 'files', 'n1.content'), 'utf8')
    assert.match(stored, /n1\.md/)
  } finally {
    await store.cleanup()
    await rm(trashDir, { recursive: true, force: true })
  }
})

test('lingshu adapter: restore rebuilds the index and content exactly', async () => {
  const store = await makeStore()
  const trashDir = join(store.root, '..', `trash-${Date.now()}`)
  try {
    const adapter = createLingshuAdapter({ rootDir: store.root })
    const bundle = await adapter.exportSession(SESSION_1, trashDir)
    await adapter.restoreBundle(bundle)

    const restored = JSON.parse(await readFile(join(store.root, '_index.json'), 'utf8'))
    assert.deepEqual(Object.keys(restored.nodes).sort(), ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'])
    assert.deepEqual(restored.nodes.n6.depends_on, ['n1'])
    assert.match(await readFile(join(store.root, 'contextual', 'n1.md'), 'utf8'), /n1\.md/)
    // Protected node never moved.
    assert.match(await readFile(join(store.root, 'contextual', 'n4.md'), 'utf8'), /n4\.md/)
  } finally {
    await store.cleanup()
    await rm(trashDir, { recursive: true, force: true })
  }
})

test('lingshu adapter: a foreign fresh lock makes the operation fail cleanly (no lost update)', async () => {
  const store = await makeStore()
  try {
    const adapter = createJsonIndexMemoryAdapter({
      id: 'lingshu',
      label: 'test',
      indexFile: join(store.root, '_index.json'),
      rootDir: store.root,
      useStoreLock: true,
      lockTimeoutMs: 60,
      staleLockMs: 600_000,
    })
    await writeFile(`${join(store.root, '_index.json')}.lock`, 'busy', 'utf8')
    await assert.rejects(adapter.exportSession(SESSION_1, join(store.root, 'trash')), (error) => {
      assert.equal(error.code, 'E_MEMORY_FAILED')
      assert.match(error.message, /busy/)
      return true
    })
    // Store untouched.
    const index = JSON.parse(await readFile(join(store.root, '_index.json'), 'utf8'))
    assert.equal(Object.keys(index.nodes).length, 6)
  } finally {
    await store.cleanup()
  }
})

test('lingshu adapter: a conversation with no linked memory does not need the store lock', async () => {
  const store = await makeStore()
  const trashDir = join(store.root, 'trash')
  try {
    const adapter = createJsonIndexMemoryAdapter({
      id: 'lingshu',
      label: 'test',
      indexFile: join(store.root, '_index.json'),
      rootDir: store.root,
      useStoreLock: true,
      lockTimeoutMs: 60,
      staleLockMs: 600_000,
    })
    // A stale foreign lock (e.g. left by a crashed memory writer) must not make
    // deleting a conversation with zero linked memories fail.
    await writeFile(`${join(store.root, '_index.json')}.lock`, '', 'utf8')
    const bundle = await adapter.exportSession('session-99999999-no-memory', trashDir)
    assert.equal(bundle.count, 0)
    assert.equal(bundle.entries.length, 0)
    assert.equal(await readFile(`${join(store.root, '_index.json')}.lock`, 'utf8'), '')
  } finally {
    await store.cleanup()
  }
})

test('lingshu adapter: an ownerless stale lock is broken instead of blocking forever', async () => {
  const store = await makeStore()
  const trashDir = join(store.root, 'trash')
  try {
    const adapter = createJsonIndexMemoryAdapter({
      id: 'lingshu',
      label: 'test',
      indexFile: join(store.root, '_index.json'),
      rootDir: store.root,
      useStoreLock: true,
      lockTimeoutMs: 60,
      staleLockMs: 600_000,
      ownerlessLockStaleMs: 1_000,
    })
    const lock = `${join(store.root, '_index.json')}.lock`
    await writeFile(lock, '', 'utf8')
    const old = new Date(Date.now() - 60_000)
    await utimes(lock, old, old)
    const bundle = await adapter.exportSession(SESSION_2, trashDir)
    assert.equal(bundle.count, 2)
    await assert.rejects(readFile(lock), { code: 'ENOENT' })
  } finally {
    await store.cleanup()
  }
})

test('lingshu adapter: a fresh ownerless lock is waited out, not failed early', async () => {
  const store = await makeStore()
  const trashDir = join(store.root, 'trash')
  try {
    const adapter = createJsonIndexMemoryAdapter({
      id: 'lingshu',
      label: 'test',
      indexFile: join(store.root, '_index.json'),
      rootDir: store.root,
      useStoreLock: true,
      // The caller's timeout is shorter than the ownerless grace; the adapter
      // must extend the wait for a zero-byte lock instead of failing at 60ms.
      lockTimeoutMs: 60,
      staleLockMs: 600_000,
      ownerlessLockStaleMs: 150,
    })
    const lock = `${join(store.root, '_index.json')}.lock`
    await writeFile(lock, '', 'utf8')
    const bundle = await adapter.exportSession(SESSION_2, trashDir)
    assert.equal(bundle.count, 2)
    await assert.rejects(readFile(lock), { code: 'ENOENT' })
  } finally {
    await store.cleanup()
  }
})

test('lingshu adapter: an unsupported schema is reported as unavailable', async () => {
  const store = await makeStore()
  try {
    await writeFile(join(store.root, '_index.json'), JSON.stringify({ schema: 99, nodes: {} }), 'utf8')
    const adapter = createLingshuAdapter({ rootDir: store.root })
    const probe = await adapter.probe()
    assert.equal(probe.available, false)
    assert.match(probe.reason, /schema 99/)
  } finally {
    await store.cleanup()
  }
})

test('memory service: overlapping stores are counted once and protected totals are aggregated', async () => {
  const store = await makeStore()
  try {
    const { createGenericJsonAdapter } = await import('../lib/core/memory/generic-json.js')
    const config = normalizeConfig({ memory: { adapters: ['lingshu', 'generic-json'] } }).value
    const service = createMemoryService({
      adapters: [
        createLingshuAdapter({ rootDir: store.root }),
        createGenericJsonAdapter({ indexFile: join(store.root, '_index.json'), rootDir: store.root }),
      ],
      config,
    })
    const result = await service.countForSessions([SESSION_1])
    assert.equal(result.total, 3)
    assert.equal(result.protected, 1)
    // The per-adapter count must agree with the total: it used to be summed
    // with Object.values(Map) and therefore always reported 0.
    const lingshu = result.adapters.find((adapter) => adapter.id === 'lingshu')
    assert.equal(lingshu.count, 3)
    assert.equal(result.adapters.reduce((sum, adapter) => sum + adapter.count, 0), result.total)
    const stores = await service.status()
    assert.equal(stores.filter((state) => state.available).length, 1)
  } finally {
    await store.cleanup()
  }
})
