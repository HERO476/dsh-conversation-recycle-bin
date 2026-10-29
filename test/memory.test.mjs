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

test('lingshu adapter: the store lock is neither consulted nor deleted', async () => {
  const store = await makeStore()
  const trashDir = join(store.root, 'trash')
  try {
    const adapter = createLingshuAdapter({ rootDir: store.root })
    // md_cg's lock is a permanent zero-byte file guarded by an OS byte-range
    // lock. Treating its existence as a lock (or deleting it) was the bug.
    const storeLock = `${join(store.root, '_index.json')}.lock`
    await writeFile(storeLock, '', 'utf8')
    const bundle = await adapter.exportSession(SESSION_2, trashDir)
    assert.equal(bundle.count, 2)
    assert.equal(await readFile(storeLock, 'utf8'), '')
  } finally {
    await store.cleanup()
  }
})

test('lingshu adapter: a conversation with no linked memory takes no plugin lock', async () => {
  const store = await makeStore()
  const trashDir = join(store.root, 'trash')
  try {
    const adapter = createJsonIndexMemoryAdapter({
      id: 'lingshu',
      label: 'test',
      indexFile: join(store.root, '_index.json'),
      rootDir: store.root,
      lockTimeoutMs: 80,
    })
    const held = `${join(store.root, '_index.json')}.conversation-recycle-bin.lock`
    await writeFile(held, JSON.stringify({ pid: process.pid, nonce: 'held', at: Date.now() }), 'utf8')
    const bundle = await adapter.exportSession('session-99999999-no-memory', trashDir)
    assert.equal(bundle.count, 0)
    assert.equal(bundle.entries.length, 0)
    // The fast path must not wait for (or remove) a lock it will not use.
    assert.match(await readFile(held, 'utf8'), /"nonce":"held"/)
  } finally {
    await store.cleanup()
  }
})

test('lingshu adapter: a private lock held by a live owner fails cleanly, not forever', async () => {
  const store = await makeStore()
  try {
    const adapter = createJsonIndexMemoryAdapter({
      id: 'lingshu',
      label: 'test',
      indexFile: join(store.root, '_index.json'),
      rootDir: store.root,
      lockTimeoutMs: 120,
      staleLockMs: 600_000,
    })
    const held = `${join(store.root, '_index.json')}.conversation-recycle-bin.lock`
    await writeFile(held, JSON.stringify({ pid: process.pid, nonce: 'held', at: Date.now() }), 'utf8')
    const started = Date.now()
    await assert.rejects(adapter.exportSession(SESSION_1, join(store.root, 'trash')), (error) => {
      assert.equal(error.code, 'E_LOCK_BUSY')
      assert.match(error.message, /held by another process/)
      return true
    })
    // The wait budget is honored: no silent infinite loop.
    assert.ok(Date.now() - started < 5_000)
    const index = JSON.parse(await readFile(join(store.root, '_index.json'), 'utf8'))
    assert.equal(Object.keys(index.nodes).length, 6)
  } finally {
    await store.cleanup()
  }
})

test('lingshu adapter: a stale private lock is broken instead of blocking forever', async () => {
  const store = await makeStore()
  const trashDir = join(store.root, 'trash')
  try {
    const adapter = createJsonIndexMemoryAdapter({
      id: 'lingshu',
      label: 'test',
      indexFile: join(store.root, '_index.json'),
      rootDir: store.root,
      lockTimeoutMs: 500,
      staleLockMs: 1_000,
    })
    const held = `${join(store.root, '_index.json')}.conversation-recycle-bin.lock`
    await writeFile(held, JSON.stringify({ pid: 999_999, nonce: 'dead', at: 1 }), 'utf8')
    const old = new Date(Date.now() - 60_000)
    await utimes(held, old, old)
    const bundle = await adapter.exportSession(SESSION_2, trashDir)
    assert.equal(bundle.count, 2)
    await assert.rejects(readFile(held), { code: 'ENOENT' })
  } finally {
    await store.cleanup()
  }
})

test('lingshu adapter: a failed export removes its untracked bundle directory', async () => {
  const store = await makeStore()
  const trashDir = join(store.root, 'trash')
  try {
    const { rename, writeFile: writeFileBase } = await import('node:fs/promises')
    const fsApi = {
      ...(await import('node:fs/promises')),
      rename,
      async writeFile(file, ...rest) {
        // The index snapshot and the bundle are allowed; the md_cg shard is
        // the failing step, which happens AFTER the index was rewritten.
        if (String(file).includes('_index_log')) throw new Error('disk full')
        return writeFileBase(file, ...rest)
      },
    }
    const adapter = createJsonIndexMemoryAdapter({
      id: 'lingshu',
      label: 'test',
      indexFile: join(store.root, '_index.json'),
      rootDir: store.root,
      indexLogDir: join(store.root, '_index_log'),
      fsApi,
    })
    await assert.rejects(adapter.exportSession(SESSION_1, trashDir), (error) => {
      assert.equal(error.code, 'E_MEMORY_FAILED')
      return true
    })
    // Index and content are back; the failed bundle is gone, so an incomplete
    // trash entry can be discarded later.
    const index = JSON.parse(await readFile(join(store.root, '_index.json'), 'utf8'))
    assert.equal(Object.keys(index.nodes).length, 6)
    assert.match(await readFile(join(store.root, 'contextual', 'n1.md'), 'utf8'), /n1\.md/)
    await assert.rejects(readFile(join(trashDir, 'memory', 'lingshu', 'bundle.json')), { code: 'ENOENT' })
  } finally {
    await store.cleanup()
    await rm(trashDir, { recursive: true, force: true })
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

test('lingshu adapter: export appends tombstones and restored records to the md_cg shard log', async () => {
  const store = await makeStore()
  const trashDir = join(store.root, 'trash')
  const shardDir = join(store.root, '_index_log')
  try {
    const adapter = createLingshuAdapter({ rootDir: store.root })
    const bundle = await adapter.exportSession(SESSION_1, trashDir)
    assert.equal(bundle.count, 3)

    const readShard = async () => {
      const { readdir } = await import('node:fs/promises')
      const files = (await readdir(shardDir)).filter((name) => name.endsWith('.log'))
      const records = []
      for (const file of files) {
        for (const line of (await readFile(join(shardDir, file), 'utf8')).split('\n')) {
          if (line.trim() !== '') records.push(JSON.parse(line))
        }
      }
      // md_cg replays the merged log in `_t` order, so the observable "last
      // write" is the greatest `_t` — not the last file in directory order.
      return records.sort((left, right) => (left._t ?? 0) - (right._t ?? 0))
    }

    const afterExport = await readShard()
    const tombstoned = afterExport.filter((record) => record.e === null).map((record) => record.id).sort()
    assert.deepEqual(tombstoned, ['n1', 'n2', 'n5'])
    // The peer whose references were stripped is re-recorded with the new value.
    const peer = afterExport.find((record) => record.id === 'n6')
    assert.ok(peer !== undefined)
    assert.deepEqual(peer.e.depends_on, [])

    await adapter.restoreBundle(bundle)
    const afterRestore = await readShard()
    const restored = afterRestore.filter((record) => record.e !== null && ['n1', 'n2', 'n5'].includes(record.id))
    assert.equal(new Set(restored.map((record) => record.id)).size, 3)
    const restoredPeer = afterRestore.filter((record) => record.id === 'n6' && record.e !== null).at(-1)
    assert.deepEqual(restoredPeer.e.depends_on, ['n1'])
  } finally {
    await store.cleanup()
    await rm(trashDir, { recursive: true, force: true })
  }
})

test('memory service: a multi-adapter restore keeps every bundle until all adapters succeed', async () => {
  const root = join(process.cwd(), 'test', '.tmp', `multi-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  const aDir = join(root, 'a')
  const bDir = join(root, 'b')
  const aBundle = join(aDir, 'bundle.json')
  const bBundle = join(bDir, 'bundle.json')
  await mkdir(aDir, { recursive: true })
  await mkdir(bDir, { recursive: true })
  await writeFile(aBundle, JSON.stringify({ format: 1, entries: [{ nodeId: 'a1' }] }), 'utf8')
  await writeFile(bBundle, JSON.stringify({ format: 1, entries: [{ nodeId: 'b1' }] }), 'utf8')
  try {
    const calls = []
    let failB = true
    const adapter = (id, restore) => ({
      id,
      label: id,
      async probe() { return { available: true, reason: null, storePath: `/fake/${id}` } },
      async countSessions() { return { counts: new Map(), protected: 0 } },
      async exportSession() { return null },
      async restoreBundle(bundle) { await restore(bundle) },
    })
    const service = createMemoryService({
      adapters: [
        adapter('a', async () => { calls.push('a') }),
        adapter('b', async () => {
          if (failB) throw new Error('store busy')
          calls.push('b')
        }),
      ],
      config: normalizeConfig({}).value,
    })
    const summary = {
      total: 2,
      adapters: [
        { id: 'a', bundlePath: aBundle },
        { id: 'b', bundlePath: bBundle },
      ],
    }
    await assert.rejects(service.restoreEntry(summary), /store busy/)
    // Nothing was removed: the retry can still read both manifests.
    assert.match(await readFile(aBundle, 'utf8'), /a1/)
    assert.match(await readFile(bBundle, 'utf8'), /b1/)
    failB = false
    calls.length = 0
    await service.restoreEntry(summary)
    assert.deepEqual(calls, ['b', 'a'])
    await assert.rejects(readFile(aBundle), { code: 'ENOENT' })
    await assert.rejects(readFile(bBundle), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 })
  }
})


test('lingshu adapter: a preview reads the index once, and a rewrite invalidates the snapshot', async () => {
  // `/preview` probes the adapter and then counts nodes; both used to read and
  // parse the whole index (39 ms at 21k nodes). The stat-keyed snapshot makes
  // the second step free while still seeing a concurrent md_cg rewrite.
  const store = await makeStore()
  try {
    const fsPromises = await import('node:fs/promises')
    let indexReads = 0
    const fsApi = {
      ...fsPromises,
      async readFile(file, ...rest) {
        if (String(file).endsWith('_index.json')) indexReads += 1
        return fsPromises.readFile(file, ...rest)
      },
    }
    const adapter = createLingshuAdapter({ rootDir: store.root, fsApi })
    assert.equal((await adapter.probe()).available, true)
    assert.equal(indexReads, 1)
    const first = await adapter.countSessions([SESSION_1])
    assert.equal(indexReads, 1, 'the count must reuse the probe snapshot')
    assert.equal(first.counts.get(SESSION_1), 3)

    // A different writer adds a node without going through this adapter.
    const index = JSON.parse(await fsPromises.readFile(join(store.root, '_index.json'), 'utf8'))
    index.nodes.n7 = { session: SESSION_1, path: 'contextual/n7.md', protected: null }
    await writeFile(join(store.root, 'contextual', 'n7.md'), '# n7\n', 'utf8')
    await writeFile(join(store.root, '_index.json'), JSON.stringify(index), 'utf8')

    const second = await adapter.countSessions([SESSION_1])
    assert.equal(indexReads, 2)
    assert.equal(second.counts.get(SESSION_1), 4)
  } finally {
    await store.cleanup()
  }
})
