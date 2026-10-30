import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../lib/core/config.js'
import { createFileLock } from '../lib/core/file-lock.js'
import { createDeleteApi, QUEUE_GRACE_MS, ROUTE_PREFIX, TRASH_LOCK_BUDGET_MS } from '../lib/host/api.js'
import { createSessionLogOps } from '../lib/host/catalog.js'
import { createSessionGateway } from '../lib/host/gateway.js'
import { createLifecycleOps } from '../lib/host/lifecycle.js'
import { projectKey, readSessionLogCwd, resolveDataPaths } from '../lib/host/paths.js'
import { callRoute, makeHttpPair, makeTempHome, makeWorkspaceRegistry, pathExists, seedSession } from './helpers.mjs'

const S1 = 'session-aaaaaaaa-1111'
const S2 = 'session-bbbbbbbb-2222'
const S3 = 'session-dddddddd-4444'
const ORPHAN = 'session-cccccccc-3333'
const HEADERS = {
  'x-conversation-recycle-bin': '1',
  origin: 'http://127.0.0.1:14968',
  'content-type': 'application/json',
  'sec-fetch-site': 'same-origin',
}

async function seedMemory(home, counts) {
  const root = join(home.root, '.dsh-memory', 'data', 'mdcg')
  await mkdir(join(root, 'contextual'), { recursive: true })
  const nodes = {}
  let serial = 0
  for (const [sessionId, count] of Object.entries(counts)) {
    for (let index = 0; index < count; index += 1) {
      serial += 1
      const id = `mem_${serial}`
      nodes[id] = { session: sessionId, path: `contextual/${id}.md`, protected: null }
      await writeFile(join(root, 'contextual', `${id}.md`), `# ${sessionId} memory ${index}\n`, 'utf8')
    }
  }
  await writeFile(join(root, '_index.json'), JSON.stringify({ schema: 2, nodes }), 'utf8')
  return root
}

async function makeFixture({
  configOverrides = {},
  sessionIds = [S1, S2, ORPHAN],
  memoryCounts = { [S1]: 2, [S2]: 1 },
  liveSessionIds = [],
  ctxExtra = {},
  mutationLock = null,
  connection = null,
} = {}) {
  const home = await makeTempHome()
  const workspaceRegistry = makeWorkspaceRegistry([
    { id: 'ws-1', path: 'D:\\Work', title: 'Work', sessionIds: [S1] },
    { id: 'ws-2', path: 'D:\\Other', title: 'Other', sessionIds: [S2, S3] },
  ])
  const seeded = new Map()
  const items = []
  const cancelledIds = new Set()
  for (const sessionId of sessionIds) {
    const meta = {
      [S1]: { cwd: 'D:\\Work', title: 'Alpha chat', eventCount: 12 },
      [S2]: { cwd: 'D:\\Other', title: 'Beta chat', eventCount: 8 },
      [S3]: { cwd: 'D:\\Other', title: 'Gamma chat', eventCount: 5 },
      [ORPHAN]: { cwd: 'D:\\Unregistered', title: 'Orphan chat', eventCount: 3 },
    }[sessionId]
    seeded.set(sessionId, await seedSession(home, {
      sessionId,
      cwd: meta.cwd,
      title: meta.title,
      eventCount: meta.eventCount,
    }))
    // A session with a live agent is running; the two used to be unrelated
    // signals, and policy gated on "exists" instead of "busy". `running` is a
    // getter because the fixture has to model both "a turn started between
    // preview and confirm" (liveSessionIds grows) and "cancel stopped it".
    const row = { sessionId, updatedAt: Date.now(), blank: false, cwd: meta.cwd }
    Object.defineProperty(row, 'running', {
      enumerable: true,
      get: () => liveSessionIds.includes(sessionId) && !cancelledIds.has(sessionId),
    })
    items.push(row)
  }
  const memoryRoot = await seedMemory(home, memoryCounts)
  const services = {
    workspaceRegistry,
    sessionPersistence: {
      async stat(sessionId) {
        const record = seeded.get(sessionId)
        if (record === undefined) {
          const error = new Error('not found')
          error.code = 'not-found'
          throw error
        }
        // 0.2.1 (rc.2/rc.3) shape: `stat()` reports header/revision/sizeBytes and
        // carries NO `eventCount`. The fixture mirrors that, so a regression that
        // reads `snapshot.eventCount` fails here instead of only on a real Host.
        return { header: record.header, revision: 'rev-1', sizeBytes: record.sizeBytes }
      },
    },
    // The live agent registry is the uncached signal: `controller.list()` is
    // cached for a few seconds, so a turn that starts between preview and
    // confirm would otherwise read as stopped and the delete would fail deep in
    // quiesce instead of being refused with E_POLICY_LIVE.
    agents: {
      get: (sessionId) => (liveSessionIds.includes(sessionId) && !cancelledIds.has(sessionId)
        ? { status: 'running' }
        : undefined),
    },
    sessionController: {
      list: async () => ({ items }),
      // Quiesce waits for the session to report "not running"; the fixture has
      // to actually stop it, or every live delete would hang until the drain
      // window expires and then fail.
      async cancel({ sessionId } = {}) {
        if (typeof sessionId === 'string') cancelledIds.add(sessionId)
      },
    },
    // A live entry exposes `seq`, which the session store defines as the log
    // length (the exact event count).
    sessions: {
      get: (sessionId) => (liveSessionIds.includes(sessionId)
        ? { id: sessionId, seq: seeded.get(sessionId)?.eventCount ?? 0 }
        : undefined),
    },
    // The `connection` service is probed, not injected: a fixture without it
    // keeps the route behind its own fence, exactly like a Host composition
    // that does not publish the service.
    ...(connection === null ? {} : { connection }),
  }
  const config = normalizeConfig({
    // Every fixture below deliberately omits the `connection` service, so it
    // has to opt out of the (default-on) requirement. The refusal path itself
    // is covered by `connection: a Host without a connection service refuses
    // by default`.
    requireConnection: connection !== null,
    ...configOverrides,
  }).value
  const paths = resolveDataPaths(home.root)
  const logs = []
  const api = createDeleteApi({
    ctx: { get: (name) => services[name], ...ctxExtra },
    config,
    paths,
    logger: { error: (...args) => logs.push(args.join(' ')), warn() {}, info() {} },
    mutationLock,
  })
  return { home, api, config, paths, services, workspaceRegistry, seeded, memoryRoot, logs, items }
}

function call(api, path, { method = 'POST', body = null, headers = {}, abortBody = false } = {}) {
  return callRoute(api.handler, {
    method,
    path: `${ROUTE_PREFIX}${path}`,
    headers: { ...HEADERS, ...headers },
    body,
    abortBody,
  })
}

test('preview: counts messages + associated memory and issues a single-use token', async () => {
  const fixture = await makeFixture()
  try {
    const result = await call(fixture.api, '/preview', { body: { sessionIds: [S1], includeMemory: true, mode: 'soft' } })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    const preview = result.body.preview
    // Stored, non-live session: the Host exposes no cheap exact count, so the
    // field is an honest `null` (the Client renders "—") instead of a number
    // the Host never provided.
    assert.equal(preview.sessions[0].events, null)
    assert.equal(preview.sessions[0].policy.ok, true)
    assert.equal(preview.memory.total, 2)
    assert.equal(preview.memory.adapters.find((adapter) => adapter.id === 'lingshu').available, true)
    assert.equal(preview.confirmation.phrase, '')
    assert.equal(typeof preview.confirmation.token, 'string')
  } finally {
    await fixture.home.cleanup()
  }
})

test('preview: a live session reports its exact event count from the session seq', async () => {
  const fixture = await makeFixture({ sessionIds: [S1, S2], liveSessionIds: [S1] })
  try {
    const result = await call(fixture.api, '/preview', { body: { sessionIds: [S1], includeMemory: true, mode: 'soft' } })
    assert.equal(result.status, 200)
    assert.equal(result.body.preview.sessions[0].events, 12)
    assert.equal(result.body.preview.sessions[0].live, true)
  } finally {
    await fixture.home.cleanup()
  }
})

test('lifecycle: a composition without sessionController still archives instead of throwing a cordis error', async () => {
  const archives = []
  const registry = {
    archiveSession: async (sessionId, options) => { archives.push([sessionId, options]) },
    unarchiveSession: async () => {},
  }
  const ctx = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }
  // cordis' Proxy trap throws on a property read for a service this composition
  // never provided; the old `?? ctx.sessionController` fallback re-raised it.
  Object.defineProperty(ctx, 'sessionController', {
    get() { throw new Error('cannot get property "sessionController" without inject') },
  })
  const ops = createLifecycleOps({ ctx, gateway: { isRunning: () => false }, config: { liveDrainMs: 0 } })
  const undo = await ops.quiesce({ id: S1, live: true, running: true, archived: false })
  assert.equal(typeof undo, 'function')
  assert.deepEqual(archives, [[S1, { stopActivity: true }]])
})

test('gateway: the running probe reads the agent status', async () => {
  const home = await makeTempHome()
  try {
    const agents = { get: (sessionId) => (sessionId === S1 ? { status: 'running' } : sessionId === S2 ? { status: 'idle' } : undefined) }
    const sessions = { get: (sessionId) => (sessionId === S1 ? { id: sessionId, seq: 9 } : undefined) }
    const gateway = createSessionGateway({
      ctx: { get: (name) => ({ agents, sessions })[name] },
      paths: resolveDataPaths(home.root),
    })
    assert.equal(gateway.isRunning(S1), true)
    assert.equal(gateway.isRunning(S2), false)
    // No agent entry at all means "not running" — the same answer the Host's own
    // list rows give when `agents.get(id)` is undefined.
    assert.equal(gateway.isRunning(S3), false)
    const inspected = await gateway.inspect(S1)
    assert.equal(inspected.events, 9)
  } finally {
    await home.cleanup()
  }
})

test('soft delete: archives the conversation, trashes its memory and keeps the log on disk', async () => {
  const fixture = await makeFixture()
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S1], includeMemory: true, mode: 'soft' } })
    const token = preview.body.preview.confirmation.token
    const result = await call(fixture.api, '/delete', { body: { sessionIds: [S1], includeMemory: true, mode: 'soft', confirmToken: token } })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(result.body.results[0].memory, 2)
    assert.equal(fixture.workspaceRegistry.globalState.archived.has(S1), true)

    const index = JSON.parse(await readFile(join(fixture.memoryRoot, '_index.json'), 'utf8'))
    assert.equal(Object.values(index.nodes).some((node) => node.session === S1), false)

    const trash = await call(fixture.api, '/trash', { method: 'GET' })
    assert.equal(trash.body.entries.length, 1)
    assert.equal(trash.body.entries[0].mode, 'soft')
    assert.equal(trash.body.entries[0].memory, 2)

    const seededDir = fixture.seeded.get(S1).dir
    assert.equal(await pathExists(join(seededDir, 'session.jsonl.zstd')), true)

    const audit = await call(fixture.api, '/audit?limit=10', { method: 'GET' })
    assert.equal(audit.body.records.at(-1).action, 'delete')
    assert.equal(audit.body.records.at(-1).includeMemory, true)
  } finally {
    await fixture.home.cleanup()
  }
})

test('restore: unarchives the conversation and puts its memory back', async () => {
  const fixture = await makeFixture()
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S1], includeMemory: true, mode: 'soft' } })
    await call(fixture.api, '/delete', { body: { sessionIds: [S1], includeMemory: true, mode: 'soft', confirmToken: preview.body.preview.confirmation.token } })
    const trash = await call(fixture.api, '/trash', { method: 'GET' })
    const restore = await call(fixture.api, '/trash/restore', { body: { trashId: trash.body.entries[0].trashId } })
    assert.equal(restore.status, 200)
    assert.equal(fixture.workspaceRegistry.globalState.archived.has(S1), false)
    const index = JSON.parse(await readFile(join(fixture.memoryRoot, '_index.json'), 'utf8'))
    assert.equal(Object.values(index.nodes).filter((node) => node.session === S1).length, 2)
    const emptyTrash = await call(fixture.api, '/trash', { method: 'GET' })
    assert.equal(emptyTrash.body.entries.length, 0)
  } finally {
    await fixture.home.cleanup()
  }
})

test('hard delete: no typed confirmation, moves the log into the recycle bin, and restore re-attaches it', async () => {
  const fixture = await makeFixture()
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S2], includeMemory: false, mode: 'hard' } })
    assert.equal(preview.body.preview.confirmation.phrase, '')
    const token = preview.body.preview.confirmation.token

    const result = await call(fixture.api, '/delete', { body: { sessionIds: [S2], includeMemory: false, mode: 'hard', confirmToken: token } })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(await pathExists(fixture.seeded.get(S2).dir), false)
    assert.equal(fixture.workspaceRegistry.get('ws-2').sessionIds.includes(S2), false)

    const trash = await call(fixture.api, '/trash', { method: 'GET' })
    assert.equal(trash.body.entries[0].hasSessionLog, true)
    const restore = await call(fixture.api, '/trash/restore', { body: { trashId: trash.body.entries[0].trashId } })
    assert.equal(restore.status, 200)
    assert.equal(await pathExists(join(fixture.seeded.get(S2).dir, 'session.jsonl.zstd')), true)
    assert.equal(fixture.workspaceRegistry.get('ws-2').sessionIds.includes(S2), true)
  } finally {
    await fixture.home.cleanup()
  }
})

test('hard delete: a live session is stopped and removed instead of being refused', async () => {
  const fixture = await makeFixture({ liveSessionIds: [S1] })
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S1], includeMemory: false, mode: 'hard' } })
    assert.equal(preview.body.preview.sessions[0].live, true)
    assert.equal(preview.body.preview.blocked.length, 0)
    assert.equal(preview.body.preview.sessions[0].policy.ok, true)
    assert.match(preview.body.preview.sessions[0].policy.warnings[0], /live agent/)
    const token = preview.body.preview.confirmation.token
    assert.equal(preview.body.preview.confirmation.phrase, '')

    const result = await call(fixture.api, '/delete', {
      body: { sessionIds: [S1], includeMemory: false, mode: 'hard', confirmToken: token },
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(await pathExists(fixture.seeded.get(S1).dir), false)
    assert.equal(fixture.workspaceRegistry.get('ws-1').sessionIds.includes(S1), false)
    // A live Agent keeps an archive tombstone so a pending wake cannot
    // recreate the moved log; restoring the trash entry clears it.
    assert.equal(fixture.workspaceRegistry.globalState.archived.has(S1), true)

    const trash = await call(fixture.api, '/trash', { method: 'GET' })
    assert.equal(trash.body.entries[0].mode, 'hard')
    const restore = await call(fixture.api, '/trash/restore', { body: { trashId: trash.body.entries[0].trashId } })
    assert.equal(restore.status, 200)
    assert.equal(fixture.workspaceRegistry.globalState.archived.has(S1), false)
    assert.equal(await pathExists(join(fixture.seeded.get(S1).dir, 'session.jsonl.zstd')), true)

    const audit = await call(fixture.api, '/audit?limit=10', { method: 'GET' })
    assert.ok(audit.body.records.some((record) => record.action === 'delete' && record.result === 'success'))
  } finally {
    await fixture.home.cleanup()
  }
})

test('hard delete: a live session refused when stopLiveSessions is disabled', async () => {
  const fixture = await makeFixture({ liveSessionIds: [S1], configOverrides: { stopLiveSessions: false } })
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S1], includeMemory: false, mode: 'hard' } })
    assert.equal(preview.body.preview.blocked[0].policy.code, 'E_POLICY_LIVE')
    assert.equal(preview.body.preview.confirmation, null)
  } finally {
    await fixture.home.cleanup()
  }
})

test('authorization: an orphan conversation is refused with a readable policy error', async () => {
  const fixture = await makeFixture()
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [ORPHAN], includeMemory: false, mode: 'soft' } })
    assert.equal(preview.status, 200)
    assert.equal(preview.body.preview.blocked[0].policy.code, 'E_POLICY_ORPHAN')
    assert.equal(preview.body.preview.confirmation, null)

    // A token minted for S1 must not authorize ORPHAN (plan binding).
    const s1Preview = await call(fixture.api, '/preview', { body: { sessionIds: [S1], includeMemory: false, mode: 'soft' } })
    const swapped = await call(fixture.api, '/delete', {
      body: { sessionIds: [ORPHAN], includeMemory: false, mode: 'soft', confirmToken: s1Preview.body.preview.confirmation.token },
    })
    assert.equal(swapped.status, 409)
    assert.equal(swapped.body.error.code, 'E_CONFIRM_INVALID')
  } finally {
    await fixture.home.cleanup()
  }
})

test('authorization: a configured protected session is refused', async () => {
  const fixture = await makeFixture({ configOverrides: { protectedSessionIds: [S1] } })
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S1], includeMemory: false, mode: 'soft' } })
    assert.equal(preview.body.preview.blocked[0].policy.code, 'E_POLICY_PROTECTED')
  } finally {
    await fixture.home.cleanup()
  }
})

test('rollback: a missing log fails the delete and restores the memory it had already moved', async () => {
  const fixture = await makeFixture()
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S2], includeMemory: true, mode: 'hard' } })
    assert.equal(preview.body.preview.memory.total, 1)
    const token = preview.body.preview.confirmation.token
    // Simulate an external loss of the log between preview and confirmation.
    await rm(fixture.seeded.get(S2).dir, { recursive: true, force: true })

    const result = await call(fixture.api, '/delete', {
      body: { sessionIds: [S2], includeMemory: true, mode: 'hard', confirmToken: token },
    })
    assert.equal(result.status, 500)
    assert.equal(result.body.ok, false)
    assert.equal(result.body.error.code, 'E_TRANSACTION_FAILED')
    assert.equal(result.body.error.details.failedStep, 'messages')
    assert.equal(result.body.error.details.rolledBack, true)

    // Memory is back in the live store and the catalog was never mutated.
    const index = JSON.parse(await readFile(join(fixture.memoryRoot, '_index.json'), 'utf8'))
    assert.equal(Object.values(index.nodes).filter((node) => node.session === S2).length, 1)
    assert.equal(fixture.workspaceRegistry.get('ws-2').sessionIds.includes(S2), true)

    const audit = await call(fixture.api, '/audit?limit=10', { method: 'GET' })
    const failed = audit.body.records.find((record) => record.action === 'delete' && record.result === 'rolled-back')
    assert.ok(failed !== undefined)
    assert.equal(failed.rollback.ok, true)
  } finally {
    await fixture.home.cleanup()
  }
})

test('batch: double confirmation with the batch size, then per-session results', async () => {
  const fixture = await makeFixture({ configOverrides: { maxDeletesPerMinute: 10 } })
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S1, S2], includeMemory: false, mode: 'soft' } })
    assert.equal(preview.body.preview.confirmation.phrase, '2')
    const token = preview.body.preview.confirmation.token

    const wrong = await call(fixture.api, '/delete', { body: { sessionIds: [S1, S2], includeMemory: false, mode: 'soft', confirmToken: token, confirmPhrase: '1' } })
    assert.equal(wrong.status, 400)
    assert.equal(wrong.body.error.code, 'E_CONFIRM_PHRASE')

    const ok = await call(fixture.api, '/delete', { body: { sessionIds: [S1, S2], includeMemory: false, mode: 'soft', confirmToken: token, confirmPhrase: '2' } })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.ok, true)
    assert.equal(ok.body.results.length, 2)
    assert.equal(fixture.workspaceRegistry.globalState.archived.size, 2)
  } finally {
    await fixture.home.cleanup()
  }
})

test('batch: permanent deletion is one click, with no batch-size phrase', async () => {
  const fixture = await makeFixture()
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S1, S2], includeMemory: false, mode: 'hard' } })
    assert.equal(preview.body.preview.confirmation.phrase, '')
    const result = await call(fixture.api, '/delete', {
      body: { sessionIds: [S1, S2], includeMemory: false, mode: 'hard', confirmToken: preview.body.preview.confirmation.token },
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(result.body.results.length, 2)
    const trash = await call(fixture.api, '/trash', { method: 'GET' })
    assert.equal(trash.body.entries.length, 2)
  } finally {
    await fixture.home.cleanup()
  }
})

test('rate limit: the per-minute budget is enforced across requests', async () => {
  const fixture = await makeFixture({ configOverrides: { maxDeletesPerMinute: 1 } })
  try {
    // Both plans are minted while the budget is still available.
    const first = await call(fixture.api, '/preview', { body: { sessionIds: [S1], includeMemory: false, mode: 'soft' } })
    const second = await call(fixture.api, '/preview', { body: { sessionIds: [S2], includeMemory: false, mode: 'soft' } })
    const firstDelete = await call(fixture.api, '/delete', { body: { sessionIds: [S1], includeMemory: false, mode: 'soft', confirmToken: first.body.preview.confirmation.token } })
    assert.equal(firstDelete.status, 200)

    const secondDelete = await call(fixture.api, '/delete', { body: { sessionIds: [S2], includeMemory: false, mode: 'soft', confirmToken: second.body.preview.confirmation.token } })
    assert.equal(secondDelete.status, 429)
    assert.equal(secondDelete.body.error.code, 'E_RATE_LIMITED')
    assert.ok(secondDelete.body.error.details.retryAfterMs > 0)

    // With no budget left, preview refuses before the user fills a dialog.
    const blockedPreview = await call(fixture.api, '/preview', { body: { sessionIds: [S2], includeMemory: false, mode: 'soft' } })
    assert.equal(blockedPreview.status, 429)
    assert.equal(blockedPreview.body.error.code, 'E_RATE_LIMITED')
  } finally {
    await fixture.home.cleanup()
  }
})

test('security: the private header and same-origin check are enforced', async () => {
  const fixture = await makeFixture()
  try {
    const noHeader = await call(fixture.api, '/preview', { body: { sessionIds: [S1] }, headers: { 'x-conversation-recycle-bin': '' } })
    assert.equal(noHeader.status, 403)
    assert.equal(noHeader.body.error.code, 'E_FORBIDDEN_ORIGIN')

    const crossSite = await call(fixture.api, '/preview', {
      body: { sessionIds: [S1] },
      headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
    })
    assert.equal(crossSite.status, 403)

    const foreignOrigin = await call(fixture.api, '/preview', {
      body: { sessionIds: [S1] },
      headers: { origin: 'http://evil.example' },
    })
    assert.equal(foreignOrigin.status, 403)
    assert.equal(foreignOrigin.body.error.code, 'E_FORBIDDEN_ORIGIN')
  } finally {
    await fixture.home.cleanup()
  }
})

test('confirmation: a token cannot be replayed', async () => {
  const fixture = await makeFixture()
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S1], includeMemory: false, mode: 'soft' } })
    const body = { sessionIds: [S1], includeMemory: false, mode: 'soft', confirmToken: preview.body.preview.confirmation.token }
    assert.equal((await call(fixture.api, '/delete', { body })).status, 200)
    const replay = await call(fixture.api, '/delete', { body })
    assert.equal(replay.status, 409)
    assert.equal(replay.body.error.code, 'E_CONFIRM_INVALID')
  } finally {
    await fixture.home.cleanup()
  }
})

test('preview: batch size limit is enforced', async () => {
  const fixture = await makeFixture({ configOverrides: { maxBatchSessions: 1 } })
  try {
    const result = await call(fixture.api, '/preview', { body: { sessionIds: [S1, S2], includeMemory: false, mode: 'soft' } })
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'E_BATCH_TOO_LARGE')
  } finally {
    await fixture.home.cleanup()
  }
})

test('state: reports memory adapter availability and the current rate budget', async () => {
  const fixture = await makeFixture()
  try {
    const state = await call(fixture.api, '/state', { method: 'GET' })
    assert.equal(state.status, 200)
    assert.equal(state.body.state.memory.adapters.find((adapter) => adapter.id === 'lingshu').available, true)
    assert.equal(state.body.state.limits.rate.limit, fixture.config.maxDeletesPerMinute)
    assert.equal(typeof state.body.state.version, 'string')
    assert.equal(state.body.state.limits.effectiveBatch, Math.min(fixture.config.maxBatchSessions, fixture.config.maxDeletesPerMinute))
    // The response must not hand the browser absolute filesystem paths.
    assert.equal('storage' in state.body.state, false)
  } finally {
    await fixture.home.cleanup()
  }
})

test('batch: a partial failure is a result with results and failures, not a refusal', async () => {
  const fixture = await makeFixture({ configOverrides: { maxDeletesPerMinute: 10 } })
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S1, S2], includeMemory: false, mode: 'hard' } })
    const token = preview.body.preview.confirmation.token
    // Only the second item fails at its catalog step.
    fixture.workspaceRegistry.get('ws-2').detachSession = async () => { throw new Error('writer busy') }
    const result = await call(fixture.api, '/delete', {
      body: { sessionIds: [S1, S2], includeMemory: false, mode: 'hard', confirmToken: token },
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(result.body.partial, true)
    assert.equal(result.body.error, undefined)
    assert.equal(result.body.results.length, 1)
    assert.equal(result.body.results[0].sessionId, S1)
    assert.equal(result.body.failures.length, 1)
    assert.equal(result.body.failures[0].sessionId, S2)
    // The failed item was rolled back: its log is still on disk.
    assert.equal(await pathExists(join(fixture.seeded.get(S2).dir, 'session.jsonl.zstd')), true)
  } finally {
    await fixture.home.cleanup()
  }
})

test('authorization: the refusal keeps the real policy code', async () => {
  const live = []
  const fixture = await makeFixture({ configOverrides: { stopLiveSessions: false }, liveSessionIds: live })
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S1], includeMemory: false, mode: 'hard' } })
    const token = preview.body.preview.confirmation.token
    // The conversation is opened in a live agent between preview and confirm.
    live.push(S1)
    const result = await call(fixture.api, '/delete', {
      body: { sessionIds: [S1], includeMemory: false, mode: 'hard', confirmToken: token },
    })
    assert.equal(result.status, 409)
    assert.equal(result.body.error.code, 'E_POLICY_LIVE')
    assert.equal(result.body.error.details.refusals[0].code, 'E_POLICY_LIVE')
  } finally {
    await fixture.home.cleanup()
  }
})

test('batch: the effective limit is capped by the remaining minute budget', async () => {
  const fixture = await makeFixture({ configOverrides: { maxBatchSessions: 10, maxDeletesPerMinute: 2 } })
  try {
    const result = await call(fixture.api, '/preview', { body: { sessionIds: [S1, S2, ORPHAN], includeMemory: false, mode: 'soft' } })
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'E_BATCH_TOO_LARGE')
    assert.equal(result.body.error.details.limit, 2)
    assert.equal(result.body.error.details.maxBatchSessions, 10)
  } finally {
    await fixture.home.cleanup()
  }
})

test('trash: an entry that never committed is listed and can be discarded', async () => {
  const fixture = await makeFixture()
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S2], includeMemory: false, mode: 'hard' } })
    const token = preview.body.preview.confirmation.token
    await rm(fixture.seeded.get(S2).dir, { recursive: true, force: true })
    const failed = await call(fixture.api, '/delete', { body: { sessionIds: [S2], includeMemory: false, mode: 'hard', confirmToken: token } })
    assert.equal(failed.status, 500)

    const trash = await call(fixture.api, '/trash', { method: 'GET' })
    assert.equal(trash.body.entries.length, 0)
    assert.equal(trash.body.incomplete.length, 1)
    assert.equal(trash.body.incomplete[0].status, 'failed')
    // The failed entry has no payload anywhere: restoring it would be refused,
    // so the advertised capability must say so (previously it was `true`).
    assert.equal(trash.body.incomplete[0].capabilities.canRestore, false)
    assert.equal(trash.body.incomplete[0].capabilities.canDiscard, true)
    const trashId = trash.body.incomplete[0].trashId

    const wrongPhrase = await call(fixture.api, '/trash/discard', { body: { trashId, confirmPhrase: 'no' } })
    assert.equal(wrongPhrase.status, 400)
    assert.equal(wrongPhrase.body.error.code, 'E_CONFIRM_PHRASE')

    const discarded = await call(fixture.api, '/trash/discard', { body: { trashId, confirmPhrase: 'DELETE' } })
    assert.equal(discarded.status, 200)
    assert.equal(await pathExists(join(fixture.paths.trashDir, trashId)), false)
    const after = await call(fixture.api, '/trash', { method: 'GET' })
    assert.equal(after.body.incomplete.length, 0)

    const audit = await call(fixture.api, '/audit?limit=10', { method: 'GET' })
    assert.ok(audit.body.records.some((record) => record.action === 'discard'))
  } finally {
    await fixture.home.cleanup()
  }
})

test('trash: a failed delete that had moved memory is cleanable once the put-back succeeded', async () => {
  const fixture = await makeFixture()
  try {
    // Only the catalog step fails; the memory stage already moved its nodes and
    // the rollback puts them back, so the entry holds nothing anymore.
    fixture.workspaceRegistry.archiveSession = async () => { throw new Error('catalog exploded') }
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S1], includeMemory: true, mode: 'soft' } })
    const failed = await call(fixture.api, '/delete', {
      body: { sessionIds: [S1], includeMemory: true, mode: 'soft', confirmToken: preview.body.preview.confirmation.token },
    })
    assert.equal(failed.status, 500)
    assert.equal(failed.body.error.details.rolledBack, true)

    const index = JSON.parse(await readFile(join(fixture.memoryRoot, '_index.json'), 'utf8'))
    assert.equal(Object.values(index.nodes).filter((node) => node.session === S1).length, 2)

    const trash = await call(fixture.api, '/trash', { method: 'GET' })
    assert.equal(trash.body.entries.length, 0)
    assert.equal(trash.body.incomplete.length, 1)
    const trashId = trash.body.incomplete[0].trashId
    // The consumed bundle must not be left behind: a leftover `bundle.json`
    // used to make the entry look like it still held memory payload, so
    // discard refused it forever while restore/purge refused its status.
    assert.equal(await pathExists(join(fixture.paths.trashDir, trashId, 'memory', 'lingshu', 'bundle.json')), false)

    const discarded = await call(fixture.api, '/trash/discard', { body: { trashId, confirmPhrase: 'DELETE' } })
    assert.equal(discarded.status, 200)
    assert.equal(await pathExists(join(fixture.paths.trashDir, trashId)), false)
  } finally {
    await fixture.home.cleanup()
  }
})

test('hard delete: a catalog step refused halfway puts the archive flag back', async () => {
  const fixture = await makeFixture()
  try {
    // The conversation was archived before the delete; `unarchiveSession` runs
    // first and the detach is then refused, so the rollback must re-archive it
    // instead of leaving a "failed" deletion with a visibly unarchived row.
    await writeFile(
      join(fixture.home.root, 'storages', 'workspace.json'),
      JSON.stringify({ global: { archivedSessionIds: [S1], pinnedSessionIds: [] } }),
      'utf8',
    )
    await fixture.workspaceRegistry.archiveSession(S1)
    fixture.workspaceRegistry.get('ws-1').detachSession = async () => { throw new Error('writer busy') }

    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S1], includeMemory: false, mode: 'hard' } })
    assert.equal(preview.body.preview.sessions[0].archived, true)
    const failed = await call(fixture.api, '/delete', {
      body: { sessionIds: [S1], includeMemory: false, mode: 'hard', confirmToken: preview.body.preview.confirmation.token },
    })
    assert.equal(failed.status, 500)
    assert.equal(failed.body.error.details.failedStep, 'session')
    assert.equal(fixture.workspaceRegistry.globalState.archived.has(S1), true)
    assert.equal(fixture.workspaceRegistry.get('ws-1').sessionIds.includes(S1), true)
    assert.equal(await pathExists(join(fixture.seeded.get(S1).dir, 'session.jsonl.zstd')), true)
  } finally {
    await fixture.home.cleanup()
  }
})

test('lifecycle: a session that will not stop is un-archived when the delete rolls back', async () => {
  const registry = makeWorkspaceRegistry([{ id: 'ws-1', path: 'D:\\Work', sessionIds: [] }])
  const controller = { async cancel() {} }
  const lifecycle = createLifecycleOps({
    ctx: { get: (name) => (name === 'workspaceRegistry' ? registry : controller) },
    // The turn never settles, so the bounded drain expires.
    gateway: { invalidate() {}, async inspect() { return { id: S1, running: true, archived: false } } },
    config: normalizeConfig({ liveDrainMs: 0 }).value,
  })
  await assert.rejects(
    () => lifecycle.quiesce({ id: S1, live: true, running: true, archived: false }),
    (error) => error.code === 'E_POLICY_LIVE',
  )
  // The archive this stage performed must not survive the rolled back delete.
  assert.equal(registry.globalState.archived.has(S1), false)
  assert.ok(registry.events.some((event) => event[0] === 'archive' && event[1] === S1))
  assert.ok(registry.events.some((event) => event[0] === 'unarchive' && event[1] === S1))
})

test('hard delete: a log being written by another instance is not moved', async () => {
  const home = await makeTempHome()
  try {
    const seeded = await seedSession(home, { sessionId: S1, cwd: 'D:\\Work' })
    const ops = createSessionLogOps({
      gateway: { findSessionDir: async () => seeded.dir },
      paths: resolveDataPaths(home.root),
      config: normalizeConfig({ foreignWriterGraceMs: 120 }).value,
      // Simulate the second Host appending during the grace window.
      delay: async () => { await writeFile(join(seeded.dir, 'session.jsonl.zstd'), Buffer.alloc(32, 3)) },
      logger: { warn() {} },
    })
    await assert.rejects(
      () => ops.moveToTrash({ id: S1, live: false }, join(home.root, 'entry')),
      (error) => error.code === 'E_POLICY_FOREIGN_WRITER',
    )
    assert.equal(await pathExists(seeded.dir), true)
  } finally {
    await home.cleanup()
  }
})

test('hard delete: an idle log is moved after the grace window', async () => {
  const home = await makeTempHome()
  try {
    const seeded = await seedSession(home, { sessionId: S1, cwd: 'D:\\Work' })
    const ops = createSessionLogOps({
      gateway: { findSessionDir: async () => seeded.dir },
      paths: resolveDataPaths(home.root),
      config: normalizeConfig({ foreignWriterGraceMs: 40 }).value,
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      logger: { warn() {} },
    })
    const moved = await ops.moveToTrash({ id: S1, live: false }, join(home.root, 'entry'))
    assert.equal(await pathExists(moved.to), true)
    assert.equal(await pathExists(seeded.dir), false)
  } finally {
    await home.cleanup()
  }
})

test('security: the full origin authority is compared, not just the hostname', async () => {
  const fixture = await makeFixture()
  try {
    // A second loopback process serving http://127.0.0.1:9999 used to pass a
    // hostname-only comparison and could drive deletions against this Host.
    const foreignPort = await call(fixture.api, '/preview', {
      body: { sessionIds: [S1] },
      headers: { origin: 'http://127.0.0.1:9999' },
    })
    assert.equal(foreignPort.status, 403)
    assert.equal(foreignPort.body.error.code, 'E_FORBIDDEN_ORIGIN')

    // A missing port is normalized against the Origin's own scheme: the Host
    // header carries no scheme, so `https://host` and `Host: host:443` agree.
    const httpsDefault = await call(fixture.api, '/preview', {
      body: { sessionIds: [S1] },
      headers: { origin: 'https://127.0.0.1', host: '127.0.0.1:443' },
    })
    assert.equal(httpsDefault.status, 200)

    const httpDefault = await call(fixture.api, '/preview', {
      body: { sessionIds: [S1] },
      headers: { origin: 'http://127.0.0.1', host: '127.0.0.1:80' },
    })
    assert.equal(httpDefault.status, 200)

    // ...but an https Origin on the plaintext port is still a different origin.
    const schemeMismatch = await call(fixture.api, '/preview', {
      body: { sessionIds: [S1] },
      headers: { origin: 'https://127.0.0.1', host: '127.0.0.1:14968' },
    })
    assert.equal(schemeMismatch.status, 403)

    // A Host header WITHOUT a port defaults to the Origin's scheme port; it
    // must not match an arbitrary foreign port (that used to pass any port).
    const noPortForeign = await call(fixture.api, '/preview', {
      body: { sessionIds: [S1] },
      headers: { origin: 'http://127.0.0.1:9999', host: '127.0.0.1' },
    })
    assert.equal(noPortForeign.status, 403)
    assert.equal(noPortForeign.body.error.code, 'E_FORBIDDEN_ORIGIN')

    const noPortDefault = await call(fixture.api, '/preview', {
      body: { sessionIds: [S1] },
      headers: { origin: 'http://127.0.0.1', host: '127.0.0.1' },
    })
    assert.equal(noPortDefault.status, 200)

    // The desktop shell origin is trusted as same-origin (the Host's own fence
    // compares against exactly `dsh-app://app`); any other host under that
    // scheme is not.
    const appShell = await call(fixture.api, '/preview', {
      body: { sessionIds: [S1] },
      headers: { origin: 'dsh-app://app' },
    })
    assert.equal(appShell.status, 200)

    const appShellImpostor = await call(fixture.api, '/preview', {
      body: { sessionIds: [S1] },
      headers: { origin: 'dsh-app://evil' },
    })
    assert.equal(appShellImpostor.status, 403)
    assert.equal(appShellImpostor.body.error.code, 'E_FORBIDDEN_ORIGIN')
  } finally {
    await fixture.home.cleanup()
  }
})

test('security: allowedHosts admits exactly the configured proxy authorities', async () => {
  // A prefix-stripping reverse proxy presents its own hostname in `Host`; the
  // only alternative used to be allowNonLoopback, which admits every hostname
  // the machine is reachable by. The allowlist must be exact: a lookalike
  // suffix or an unlisted port stays refused.
  const blockedFixture = await makeFixture()
  try {
    const blocked = await call(blockedFixture.api, '/preview', {
      body: { sessionIds: [S1] },
      headers: { host: 'app.example', origin: 'https://app.example' },
    })
    assert.equal(blocked.status, 403)
    assert.equal(blocked.body.error.code, 'E_FORBIDDEN_HOST')
    assert.deepEqual(blocked.body.error.details.allowedHosts, [])
  } finally {
    await blockedFixture.home.cleanup()
  }

  const bareHost = await makeFixture({ configOverrides: { allowedHosts: ['APP.Example.'] } })
  try {
    const httpDefault = await call(bareHost.api, '/preview', {
      body: { sessionIds: [S1] },
      headers: { host: 'app.example', origin: 'https://app.example' },
    })
    assert.equal(httpDefault.status, 200)

    // A bare entry admits any port, but the Origin still has to agree with it.
    const withPort = await call(bareHost.api, '/preview', {
      body: { sessionIds: [S1] },
      headers: { host: 'app.example:8443', origin: 'https://app.example:8443' },
    })
    assert.equal(withPort.status, 200)

    const lookalike = await call(bareHost.api, '/preview', {
      body: { sessionIds: [S1] },
      headers: { host: 'app.example.evil', origin: 'https://app.example.evil' },
    })
    assert.equal(lookalike.status, 403)
    assert.equal(lookalike.body.error.code, 'E_FORBIDDEN_HOST')
  } finally {
    await bareHost.home.cleanup()
  }

  const pinnedPort = await makeFixture({ configOverrides: { allowedHosts: ['app.example:8443'] } })
  try {
    const match = await call(pinnedPort.api, '/preview', {
      body: { sessionIds: [S1] },
      headers: { host: 'app.example:8443', origin: 'https://app.example:8443' },
    })
    assert.equal(match.status, 200)

    const otherPort = await call(pinnedPort.api, '/preview', {
      body: { sessionIds: [S1] },
      headers: { host: 'app.example:9443', origin: 'https://app.example:9443' },
    })
    assert.equal(otherPort.status, 403)
    assert.equal(otherPort.body.error.code, 'E_FORBIDDEN_HOST')
  } finally {
    await pinnedPort.home.cleanup()
  }
})

test('connection: requestRejection short-circuits 401 and 403 before the route runs', async () => {
  for (const [rejection, status, code] of [[401, 401, 'E_UNAUTHORIZED'], [403, 403, 'E_FORBIDDEN_ORIGIN']]) {
    const fixture = await makeFixture({ connection: { requestRejection: () => rejection } })
    try {
      const result = await call(fixture.api, '/state', { method: 'GET' })
      assert.equal(result.status, status)
      assert.equal(result.body.error.code, code)
      // The route itself never ran: no session work happened behind a refusal.
      assert.equal(fixture.logs.length, 0)
    } finally {
      await fixture.home.cleanup()
    }
  }
})

test('connection: a waterfall veto (the desktop update lock) returns 503 without touching the transaction', async () => {
  // The desktop app-update control listens on `connection/request` and refuses
  // new requests while it drains in-flight ones. A listener that never calls
  // `next()` is a veto; the route must not run and must not answer twice.
  const fixture = await makeFixture({
    ctxExtra: {
      waterfall: (name, req, res, next) => {
        assert.equal(name, 'connection/request')
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: { code: 'E_UNAVAILABLE', message: 'An update is installing.' } }))
      },
    },
  })
  try {
    const result = await call(fixture.api, '/state', { method: 'GET' })
    assert.equal(result.status, 503)
    assert.equal(result.body.error.code, 'E_UNAVAILABLE')
    assert.equal(fixture.logs.length, 0)
  } finally {
    await fixture.home.cleanup()
  }
})

test('mutation lock: a busy cross-process lock is E_LOCK_BUSY, not a corrupted manifest', async () => {
  const lockPath = join(process.cwd(), 'test', '.tmp', `mutation-busy-${randomBytes(6).toString('hex')}.lock`)
  const holder = createFileLock({ lockPath, timeoutMs: 2_000, staleMs: 60_000, retryMs: 10 })
  const fixture = await makeFixture({
    // A short wait budget keeps the test fast; production waits 30s because a
    // deletion transaction legitimately takes a while.
    mutationLock: createFileLock({ lockPath, timeoutMs: 60, staleMs: 60_000, retryMs: 10 }),
  })
  const release = await holder.acquire()
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S1], includeMemory: false, mode: 'soft' } })
    const body = { sessionIds: [S1], includeMemory: false, mode: 'soft', confirmToken: preview.body.preview.confirmation.token }
    const result = await call(fixture.api, '/delete', { body })
    assert.equal(result.status, 409)
    assert.equal(result.body.error.code, 'E_LOCK_BUSY')
    // Refused BEFORE any mutation: the log is still in place, the recycle bin
    // is still empty, and the session is not archived.
    assert.equal(await pathExists(fixture.seeded.get(S1).dir), true)
    assert.equal(await pathExists(join(fixture.paths.trashDir)).then((exists) => (exists ? 'dir' : 'none')), 'none')
    assert.equal(fixture.workspaceRegistry.globalState.archived.has(S1), false)
  } finally {
    await release()
    await fixture.home.cleanup()
  }
})

test('preview: the plan timeout grows with the batch so a long delete is not aborted client-side', async () => {
  const fixture = await makeFixture({ configOverrides: { maxBatchSessions: 50, maxDeletesPerMinute: 50 } })
  try {
    const single = await call(fixture.api, '/preview', { body: { sessionIds: [S1], includeMemory: false, mode: 'soft' } })
    assert.equal(typeof single.body.preview.limits.planTimeoutMs, 'number')
    assert.ok(single.body.preview.limits.planTimeoutMs >= 15_000)
    assert.ok(single.body.preview.limits.planTimeoutMs <= 900_000)

    const many = await call(fixture.api, '/preview', { body: { sessionIds: [S1, S2], includeMemory: false, mode: 'soft' } })
    assert.ok(many.body.preview.limits.planTimeoutMs > single.body.preview.limits.planTimeoutMs)

    // A live session adds its drain window to the budget.
    const live = await makeFixture({ liveSessionIds: [S1] })
    try {
      const livePreview = await call(live.api, '/preview', { body: { sessionIds: [S1], includeMemory: false, mode: 'hard' } })
      assert.ok(livePreview.body.preview.limits.planTimeoutMs > single.body.preview.limits.planTimeoutMs)
    } finally {
      await live.home.cleanup()
    }
  } finally {
    await fixture.home.cleanup()
  }
})

test('sessions: each row carries a deletable verdict and the reason when it is not', async () => {
  const fixture = await makeFixture({ configOverrides: { allowOrphanSessions: false } })
  try {
    const result = await call(fixture.api, '/sessions', { method: 'GET' })
    assert.equal(result.status, 200)
    const rows = result.body.sessions
    const orphan = rows.find((row) => row.id === ORPHAN)
    const owned = rows.find((row) => row.id === S1)
    assert.equal(owned.deletable, true)
    assert.deepEqual(owned.policy.ok, true)
    assert.equal(orphan.deletable, false)
    assert.equal(orphan.policy.ok, false)
    assert.equal(orphan.policy.code, 'E_POLICY_ORPHAN')
    assert.equal(typeof orphan.policy.message, 'string')
  } finally {
    await fixture.home.cleanup()
  }
})

test('audit: the source records which shell asked (web UI vs the desktop app)', async () => {
  const readAuditSources = async (fixture) => {
    const raw = await readFile(fixture.paths.auditFile, 'utf8')
    return raw.trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line).source)
  }
  // A valid plan whose session turns out to be a subagent's private
  // conversation before the delete is confirmed is exactly the "denied" path:
  // the token is fine, the policy is not, and the refusal is written to the
  // audit trail with its provenance.
  const deniedFixture = async () => {
    const fixture = await makeFixture({ configOverrides: { maxDeletesPerMinute: 50 } })
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S1], includeMemory: false, mode: 'soft' } })
    // `inspect` re-reads the header on every call, so this lands after the
    // token was issued — the same race a live Host can produce.
    fixture.seeded.get(S1).header.origin = 'subagent'
    const denied = await call(fixture.api, '/delete', {
      body: { sessionIds: [S1], includeMemory: false, mode: 'soft', confirmToken: preview.body.preview.confirmation.token },
    })
    assert.equal(denied.status, 403)
    assert.equal(denied.body.error.code, 'E_POLICY_SUBAGENT')
    return fixture
  }
  // Plain node: the web UI.
  const web = await deniedFixture()
  try {
    assert.ok((await readAuditSources(web)).includes('web-ui'))
  } finally {
    await web.home.cleanup()
  }
  // The Electron shell: same code, different provenance.
  const hadElectron = process.versions.electron
  process.versions.electron = '99.0.0'
  try {
    const desktop = await deniedFixture()
    try {
      assert.ok((await readAuditSources(desktop)).includes('desktop-ui'))
    } finally {
      await desktop.home.cleanup()
    }
  } finally {
    if (hadElectron === undefined) delete process.versions.electron
    else process.versions.electron = hadElectron
  }
})

test('body: a client that disconnects mid-body gets a 400, not a parked mutation chain', async () => {
  const fixture = await makeFixture()
  try {
    // `aborted` fires and `end` never does. The body promise used to stay
    // pending, which parked every later mutation behind it until a restart.
    const aborted = await call(fixture.api, '/delete', { body: { sessionIds: [S1] }, abortBody: true })
    assert.equal(aborted.status, 400)
    assert.equal(aborted.body.error.code, 'E_BAD_REQUEST')
    // The chain is not parked: a well-formed request still completes.
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S1], includeMemory: false, mode: 'soft' } })
    assert.equal(preview.status, 200)
  } finally {
    await fixture.home.cleanup()
  }
})

test('body: a client that disconnects mid-body gets a 400, not a parked mutation chain', async () => {
  const fixture = await makeFixture()
  try {
    // `aborted` fires and `end` never does. The body promise used to stay
    // pending, which parked every later mutation behind it until a restart.
    const aborted = await call(fixture.api, '/delete', { body: { sessionIds: [S1] }, abortBody: true })
    assert.equal(aborted.status, 400)
    assert.equal(aborted.body.error.code, 'E_BAD_REQUEST')
    // The chain is not parked: a well-formed request still completes.
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S1], includeMemory: false, mode: 'soft' } })
    assert.equal(preview.status, 200)
  } finally {
    await fixture.home.cleanup()
  }
})

test('routing: an unknown path answers 404 for both GET and POST, not a misleading 405', async () => {
  const fixture = await makeFixture()
  try {
    const get = await call(fixture.api, '/does-not-exist', { method: 'GET', headers: {} })
    assert.equal(get.status, 404)
    assert.equal(get.body.error.code, 'E_NOT_FOUND')
    const post = await call(fixture.api, '/does-not-exist', { body: {} })
    assert.equal(post.status, 404)
    assert.equal(post.body.error.code, 'E_NOT_FOUND')
  } finally {
    await fixture.home.cleanup()
  }
})

test('trash: a corrupt manifest is surfaced as unreadable and discardable once empty', async () => {
  const fixture = await makeFixture()
  try {
    const corruptId = 'abc-123456'
    const corruptDir = join(fixture.paths.trashDir, corruptId)
    await mkdir(join(corruptDir, 'memory'), { recursive: true })
    await writeFile(join(corruptDir, 'manifest.json'), '{ broken json', 'utf8')

    const listed = await call(fixture.api, '/trash', { method: 'GET' })
    const row = listed.body.incomplete.find((item) => item.trashId === corruptId)
    assert.ok(row !== undefined)
    assert.equal(row.status, 'unreadable')

    const discarded = await call(fixture.api, '/trash/discard', { body: { trashId: corruptId, confirmPhrase: 'DELETE' } })
    assert.equal(discarded.status, 200)
    assert.equal(await pathExists(corruptDir), false)

    // A log with no readable manifest has no session id, so there is no path it
    // could ever be restored to: discard is the only way to reclaim it, and the
    // phrase confirms the user knows it is gone for good.
    const heldId = 'def-654321'
    const heldDir = join(fixture.paths.trashDir, heldId)
    await mkdir(join(heldDir, 'session'), { recursive: true })
    await writeFile(join(heldDir, 'session', 'session.jsonl.zstd'), Buffer.alloc(8, 7), 'utf8')
    await writeFile(join(heldDir, 'manifest.json'), 'junk', 'utf8')
    const discardedLog = await call(fixture.api, '/trash/discard', { body: { trashId: heldId, confirmPhrase: 'DELETE' } })
    assert.equal(discardedLog.status, 200)
    assert.equal(await pathExists(heldDir), false)

    // Memory bundles are the exception: they can be restored once the manifest
    // is repaired, so discard stays refused while one is on disk.
    const memoryId = 'ghi-111111'
    const memoryDir = join(fixture.paths.trashDir, memoryId)
    await mkdir(join(memoryDir, 'memory', 'codex'), { recursive: true })
    await writeFile(join(memoryDir, 'memory', 'codex', 'bundle.json'), '{"count":1,"entries":[]}', 'utf8')
    await writeFile(join(memoryDir, 'manifest.json'), 'junk', 'utf8')
    const refused = await call(fixture.api, '/trash/discard', { body: { trashId: memoryId, confirmPhrase: 'DELETE' } })
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error.code, 'E_TRASH_CONFLICT')
    assert.equal(await pathExists(memoryDir), true)
  } finally {
    await fixture.home.cleanup()
  }
})

test('sessions: the list verdict follows the configured default mode (hard refuses live when stopping is off)', async () => {
  const fixture = await makeFixture({
    liveSessionIds: [S1],
    configOverrides: { stopLiveSessions: false, defaultMode: 'hard' },
  })
  try {
    const result = await call(fixture.api, '/sessions', { method: 'GET' })
    const row = result.body.sessions.find((item) => item.id === S1)
    assert.equal(row.deletable, false)
    assert.equal(row.policy.code, 'E_POLICY_LIVE')
  } finally {
    await fixture.home.cleanup()
  }
})

test('rate limit: a failed item refunds its slot; only successes count against the cap', async () => {
  const fixture = await makeFixture({
    configOverrides: { maxDeletesPerMinute: 2 },
    sessionIds: [S1, S2],
  })
  try {
    // S1 fails at its catalog detach step; S2 succeeds. The failed S1 must
    // refund its slot, so the window holds one used deletion, not two.
    fixture.workspaceRegistry.get('ws-1').detachSession = async () => { throw new Error('writer busy') }
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S1, S2], includeMemory: false, mode: 'hard' } })
    const result = await call(fixture.api, '/delete', {
      body: { sessionIds: [S1, S2], includeMemory: false, mode: 'hard', confirmToken: preview.body.preview.confirmation.token },
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.partial, true)
    assert.equal(result.body.results[0].sessionId, S2)
    assert.equal(result.body.failures[0].sessionId, S1)
    assert.notEqual(result.body.failures[0].error.code, 'E_RATE_LIMITED')

    const state = await call(fixture.api, '/state', { method: 'GET' })
    assert.equal(state.body.state.limits.rate.used, 1)
  } finally {
    await fixture.home.cleanup()
  }
})

test('rate limit: a mid-plan refusal records every remaining session as a failure', async () => {
  // Pre-0.3.4 the loop `break`ed after pushing the first exhausted item, so a
  // batch of 3 that ran out mid-loop produced {results:[S1], failures:[S2]}
  // and S3 silently disappeared from both arrays. The fix `continue`s: each
  // remaining session gets its own rate-limited failure record.
  //
  // Both /preview and /delete enforce `sessions.length <= limiter.remaining`,
  // so the natural HTTP path never sees a shrinking budget mid-loop. This
  // test monkey-patches the live limiter to succeed once then refuse, which
  // is what a second Host process consuming the same window would do.
  const fixture = await makeFixture({
    configOverrides: { maxDeletesPerMinute: 3 },
    sessionIds: [S1, S2, S3],
  })
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S1, S2, S3], includeMemory: false, mode: 'hard' } })
    assert.equal(preview.status, 200)
    assert.equal(preview.body.preview.confirmation?.token !== undefined, true)

    const limiter = fixture.api.handler_services.limiter
    const realTake = limiter.take.bind(limiter)
    let callCount = 0
    limiter.take = (cost) => {
      callCount += 1
      if (callCount === 1) return realTake(cost)
      return { ok: false, retryAfterMs: 42_000, limit: limiter.status().limit }
    }

    try {
      const batch = await call(fixture.api, '/delete', {
        body: { sessionIds: [S1, S2, S3], includeMemory: false, mode: 'hard', confirmToken: preview.body.preview.confirmation.token },
      })
      assert.equal(batch.status, 200)
      assert.equal(batch.body.results.length, 1)
      assert.equal(batch.body.results[0].sessionId, S1)
      assert.equal(batch.body.failures.length, 2)
      assert.deepEqual(
        batch.body.failures.map((failure) => failure.sessionId).sort(),
        [S2, S3].sort(),
      )
      assert.ok(batch.body.failures.every((failure) => failure.error.code === 'E_RATE_LIMITED'))
    } finally {
      limiter.take = realTake
    }
  } finally {
    await fixture.home.cleanup()
  }
})

test('trash mutations ask the file lock for the long batch budget, not the generic default', async () => {
  // restore / purge / discard can queue behind a whole batch delete, so the
  // generic 15s lock timeout made the Host answer E_LOCK_BUSY for a request
  // that only needed to wait. The Client budget (client.js
  // TRASH_MUTATION_TIMEOUT_MS = 195s) is deliberately larger, so this lock
  // budget - not the browser's AbortController - decides the outcome.
  const waits = []
  const mutationLock = {
    async acquire(options = {}) {
      waits.push(options.timeoutMs)
      return async () => {}
    },
  }
  const fixture = await makeFixture({ mutationLock })
  try {
    const deleteOne = async (sessionId, mode) => {
      const preview = await call(fixture.api, '/preview', { body: { sessionIds: [sessionId], includeMemory: false, mode } })
      const deleted = await call(fixture.api, '/delete', {
        body: { sessionIds: [sessionId], includeMemory: false, mode, confirmToken: preview.body.preview.confirmation.token },
      })
      assert.equal(deleted.status, 200)
      const trash = await call(fixture.api, '/trash', { method: 'GET' })
      return trash.body.entries[0].trashId
    }

    // restore
    const restoreId = await deleteOne(S1, 'soft')
    waits.length = 0
    const restore = await call(fixture.api, '/trash/restore', { body: { trashId: restoreId } })
    assert.equal(restore.status, 200)
    assert.deepEqual(waits, [TRASH_LOCK_BUDGET_MS])

    // purge
    const purgeId = await deleteOne(S2, 'hard')
    waits.length = 0
    const purge = await call(fixture.api, '/trash/purge', { body: { trashId: purgeId, confirmPhrase: 'DELETE' } })
    assert.equal(purge.status, 200)
    assert.deepEqual(waits, [TRASH_LOCK_BUDGET_MS])

    // discard
    //
    // A soft entry deliberately keeps its log on disk (that is what makes it
    // restorable), so `discard` — which is for entries that never committed —
    // refuses it with E_TRASH_CONFLICT. Discarding a real deletion is not a
    // thing the API offers, so seed the kind discard exists for: a manifest
    // with no session/ and no memory/ directory.
    const pendingId = `pending${Date.now().toString(36)}-e1`
    const pendingDir = join(fixture.paths.trashDir, pendingId)
    await mkdir(pendingDir, { recursive: true })
    await writeFile(join(pendingDir, 'manifest.json'), JSON.stringify({
      format: 1,
      trashId: pendingId,
      sessionId: S3,
      title: 'never committed',
      mode: 'hard',
      includeMemory: false,
      deletedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'pending',
      sessionLog: null,
      memory: { total: 0, adapters: [] },
      catalog: {},
      error: null,
    }, null, 2), 'utf8')
    waits.length = 0
    const discard = await call(fixture.api, '/trash/discard', { body: { trashId: pendingId, confirmPhrase: 'DELETE' } })
    assert.equal(discard.status, 200)
    assert.deepEqual(waits, [TRASH_LOCK_BUDGET_MS])
  } finally {
    await fixture.home.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * 0.3.8 regressions
 * ------------------------------------------------------------------ */

test('mutation lock: a stale lock that cannot be removed ends in E_LOCK_BUSY, not an endless spin', async () => {
  const dir = join(process.cwd(), 'test', '.tmp')
  await mkdir(dir, { recursive: true })
  const lockPath = join(dir, `stale-stuck-${randomBytes(6).toString('hex')}.lock`)
  await writeFile(lockPath, `${JSON.stringify({ pid: 999_999, nonce: 'dead', at: 0 })}\n`, 'utf8')
  // A provably dead owner makes the lock stale; the failing `rm` is the Windows
  // case (a handle the lock cannot see holds the file). Before 0.3.8 this loop
  // had no sleep and no deadline, so it never returned.
  const realRm = rm
  const lock = createFileLock({
    lockPath,
    timeoutMs: 300,
    staleMs: 1,
    retryMs: 5,
    isProcessAlive: () => false,
    fsApi: {
      open: (await import('node:fs/promises')).open,
      stat: (await import('node:fs/promises')).stat,
      readFile: (await import('node:fs/promises')).readFile,
      utimes: (await import('node:fs/promises')).utimes,
      rm: async () => {
        const error = new Error('EPERM: operation not permitted')
        error.code = 'EPERM'
        throw error
      },
    },
  })
  const started = Date.now()
  await assert.rejects(() => lock.acquire(), (error) => error.code === 'E_LOCK_BUSY')
  // Bounded by the budget, not by luck.
  assert.ok(Date.now() - started < 5_000)
  await realRm(lockPath, { force: true })
})

test('trash: a malformed id is a 400 before any path is built', async () => {
  const fixture = await makeFixture()
  try {
    for (const trashId of ['../../etc', 'a/b', '', 'x'.repeat(200), 'not a valid id']) {
      const result = await call(fixture.api, '/trash/discard', { body: { trashId, phrase: '' } })
      assert.equal(result.status, 400, `expected 400 for ${JSON.stringify(trashId)}`)
      assert.equal(result.body.error.code, 'E_BAD_REQUEST')
    }
  } finally {
    await fixture.home.cleanup()
  }
})

test('connection: a throwing connection layer fails closed with 503', async () => {
  const fixture = await makeFixture({
    connection: {
      requestRejection() {
        throw new Error('auth store unavailable')
      },
    },
  })
  try {
    const result = await call(fixture.api, '/preview', { body: { sessionIds: [S1], includeMemory: false, mode: 'soft' } })
    assert.equal(result.status, 503)
    assert.equal(result.body.error.code, 'E_INTERNAL')
    // The transaction never started.
    assert.equal(await pathExists(fixture.seeded.get(S1).dir), true)
  } finally {
    await fixture.home.cleanup()
  }
})

test('queue: a fully read body is not a disconnect', async () => {
  // Regression for 0.3.8: Node auto-destroys the readable side of an
  // IncomingMessage once the body has been consumed, so `req.destroyed` is true
  // on every healthy POST. Treating it as "client gone" rejected every
  // deletion with E_ABANDONED. The socket, not the request stream, is the
  // signal that survives a normal request.
  const fixture = await makeFixture()
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S1], includeMemory: false, mode: 'soft' } })
    const pair = makeHttpPair({
      path: `${ROUTE_PREFIX}/delete`,
      headers: HEADERS,
      body: {
        sessionIds: [S1],
        includeMemory: false,
        mode: 'soft',
        confirmToken: preview.body.preview.confirmation.token,
      },
    })
    pair.request.destroyed = true
    pair.request.readableEnded = true
    pair.request.complete = true
    fixture.api.handler(pair.request, pair.response)
    await pair.done
    assert.equal(pair.response.statusCode, 200, pair.response.body)
    assert.equal(JSON.parse(pair.response.body).ok, true)
    // The deletion actually ran: the conversation is now in the recycle bin.
    const trash = await call(fixture.api, '/trash', { method: 'GET' })
    assert.equal(trash.body.entries.length, 1)
  } finally {
    await fixture.home.cleanup()
  }
})

test('queue: a request whose client is already gone is not applied', async () => {
  const fixture = await makeFixture()
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S1], includeMemory: false, mode: 'soft' } })
    const pair = makeHttpPair({
      path: `${ROUTE_PREFIX}/delete`,
      headers: HEADERS,
      body: {
        sessionIds: [S1],
        includeMemory: false,
        mode: 'soft',
        confirmToken: preview.body.preview.confirmation.token,
      },
    })
    // The tab closed while the request was queued.
    pair.response.destroyed = true
    fixture.api.handler(pair.request, pair.response)
    await pair.done
    assert.equal(pair.response.statusCode, 409)
    assert.equal(JSON.parse(pair.response.body).error.code, 'E_ABANDONED')
    // The transaction never ran: the log is still in place and nothing moved.
    assert.equal(await pathExists(fixture.seeded.get(S1).dir), true)
    assert.equal(fixture.workspaceRegistry.globalState.archived.has(S1), false)
  } finally {
    await fixture.home.cleanup()
  }
})

test('retention: an entry older than trashRetentionDays is purged by the next listing', async () => {
  const fixture = await makeFixture()
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S2], includeMemory: false, mode: 'hard' } })
    const deleted = await call(fixture.api, '/delete', {
      body: { sessionIds: [S2], includeMemory: false, mode: 'hard', confirmToken: preview.body.preview.confirmation.token },
    })
    assert.equal(deleted.status, 200)

    const listed = await fixture.api.__test.trashList()
    assert.equal(listed.entries.length, 1)
    const trashId = listed.entries[0].trashId
    assert.equal(await pathExists(join(fixture.paths.trashDir, trashId)), true)

    // Age the manifest past the 30-day window, then let the listing sweep it.
    const manifestPath = join(fixture.paths.trashDir, trashId, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.deletedAt = Date.now() - 31 * 86_400_000
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

    const swept = await fixture.api.__test.sweepExpiredTrash({ force: true })
    assert.deepEqual(swept.purged, [trashId])
    assert.equal(await pathExists(join(fixture.paths.trashDir, trashId)), false)

    const after = await call(fixture.api, '/trash', { method: 'GET' })
    assert.equal(after.body.entries.length, 0)
    // The session stays deleted: retention purges the bundle, it never restores.
    assert.equal(await pathExists(fixture.seeded.get(S2).dir), false)

    const audit = await call(fixture.api, '/audit?limit=20', { method: 'GET' })
    const record = audit.body.records.find((item) => item.action === 'purge' && item.trashId === trashId)
    assert.ok(record, 'the automatic purge is audited')
    assert.equal(record.source, 'retention')
  } finally {
    await fixture.home.cleanup()
  }
})

test('retention: an archived soft entry is purged when expired', async () => {
  const fixture = await makeFixture()
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S2], includeMemory: false, mode: 'soft' } })
    const deleted = await call(fixture.api, '/delete', {
      body: { sessionIds: [S2], includeMemory: false, mode: 'soft', confirmToken: preview.body.preview.confirmation.token },
    })
    assert.equal(deleted.status, 200)
    const trashId = (await readdir(fixture.paths.trashDir))[0]
    const entryDir = join(fixture.paths.trashDir, trashId)

    // The fixture registry keeps archive state in memory; the gateway reads the
    // Host's workspace document, so mirror the soft delete's archive marker.
    await writeFile(join(fixture.home.root, 'storages', 'workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [], archivedSessionIds: [S2], pinnedSessionIds: [] },
      tables: { workspaces: {} },
    }), 'utf8')
    const manifestPath = join(entryDir, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.deletedAt = Date.now() - 31 * 86_400_000
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

    const swept = await fixture.api.__test.sweepExpiredTrash({ force: true })
    assert.deepEqual(swept.purged, [trashId])
    assert.deepEqual(swept.failed, [])
    assert.equal(await pathExists(entryDir), false)
    // Soft delete keeps the log until the purge actually happens.
    assert.equal(await pathExists(fixture.seeded.get(S2).dir), false)
  } finally {
    await fixture.home.cleanup()
  }
})

test('retention: a revived soft entry is kept for the user', async () => {
  const fixture = await makeFixture()
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S2], includeMemory: false, mode: 'soft' } })
    await call(fixture.api, '/delete', {
      body: { sessionIds: [S2], includeMemory: false, mode: 'soft', confirmToken: preview.body.preview.confirmation.token },
    })
    const trashId = (await readdir(fixture.paths.trashDir))[0]
    const entryDir = join(fixture.paths.trashDir, trashId)
    const manifestPath = join(entryDir, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.deletedAt = Date.now() - 31 * 86_400_000
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

    // No archive marker: the user unarchived the conversation after deleting it.
    const swept = await fixture.api.__test.sweepExpiredTrash({ force: true })
    assert.deepEqual(swept.purged, [])
    assert.deepEqual(swept.failed, [{ trashId, code: 'E_SESSION_ALIVE' }])
    assert.equal(await pathExists(entryDir), true)
    assert.equal(await pathExists(fixture.seeded.get(S2).dir), true)
  } finally {
    await fixture.home.cleanup()
  }
})

test('recovery: projectKey and the zstd log header rebuild the original path', async (t) => {
  const zstd = await import('node:zlib')
  if (typeof zstd.zstdCompressSync !== 'function') {
    t.skip('this Node runtime has no zstd codec')
    return
  }
  const home = await makeTempHome()
  try {
    const dir = join(home.root, 'sessions', 'scratch', 'session-aaaaaaaa-1111')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), zstd.zstdCompressSync(
      Buffer.from(`${JSON.stringify({ type: 'session', version: 4, cwd: 'D:\\Work' })}\n`, 'utf8'),
    ))
    assert.equal(projectKey('D:\\Work'), '--D-Work--')
    assert.equal(await readSessionLogCwd(dir), 'D:\\Work')
  } finally {
    await home.cleanup()
  }
})

test('retention: trashRetentionDays 0 keeps entries forever', async () => {
  const fixture = await makeFixture({ configOverrides: { trashRetentionDays: 0 } })
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S2], includeMemory: false, mode: 'hard' } })
    await call(fixture.api, '/delete', {
      body: { sessionIds: [S2], includeMemory: false, mode: 'hard', confirmToken: preview.body.preview.confirmation.token },
    })
    const listed = await fixture.api.__test.trashList()
    const trashId = listed.entries[0].trashId
    const manifestPath = join(fixture.paths.trashDir, trashId, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.deletedAt = Date.now() - 400 * 86_400_000
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

    const swept = await fixture.api.__test.sweepExpiredTrash({ force: true })
    assert.equal(swept.enabled, false)
    assert.deepEqual(swept.purged, [])
    assert.equal(await pathExists(join(fixture.paths.trashDir, trashId)), true)
  } finally {
    await fixture.home.cleanup()
  }
})

test('retention: an entry that never committed is not swept, however old', async () => {
  const fixture = await makeFixture()
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S2], includeMemory: false, mode: 'hard' } })
    await rm(fixture.seeded.get(S2).dir, { recursive: true, force: true })
    const failed = await call(fixture.api, '/delete', {
      body: { sessionIds: [S2], includeMemory: false, mode: 'hard', confirmToken: preview.body.preview.confirmation.token },
    })
    assert.equal(failed.status, 500)

    const listed = await fixture.api.__test.trashList()
    assert.equal(listed.entries.length, 0)
    assert.equal(listed.incomplete.length, 1)
    const trashId = listed.incomplete[0].trashId
    const manifestPath = join(fixture.paths.trashDir, trashId, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.deletedAt = Date.now() - 400 * 86_400_000
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

    const swept = await fixture.api.__test.sweepExpiredTrash({ force: true })
    assert.deepEqual(swept.purged, [])
    // Still listed as incomplete so the user can inspect and discard it.
    assert.equal(await pathExists(join(fixture.paths.trashDir, trashId)), true)
    const after = await fixture.api.__test.trashList()
    assert.equal(after.incomplete.length, 1)
  } finally {
    await fixture.home.cleanup()
  }
})

test('retention: a disabled plugin never sweeps, and the bin stays unreachable', async () => {
  const source = await makeFixture()
  const disabled = await makeFixture({ configOverrides: { enabled: false } })
  try {
    const preview = await call(source.api, '/preview', { body: { sessionIds: [S2], includeMemory: false, mode: 'hard' } })
    await call(source.api, '/delete', {
      body: { sessionIds: [S2], includeMemory: false, mode: 'hard', confirmToken: preview.body.preview.confirmation.token },
    })
    const trashId = (await source.api.__test.trashList()).entries[0].trashId
    // Same manifest, different Host config: this is the "user turned the plugin
    // off" case, and the timer used to keep deleting entries anyway.
    await cp(join(source.paths.trashDir, trashId), join(disabled.paths.trashDir, trashId), { recursive: true })
    const manifestPath = join(disabled.paths.trashDir, trashId, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.deletedAt = Date.now() - 400 * 86_400_000
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

    const swept = await disabled.api.__test.sweepExpiredTrash({ force: true })
    assert.equal(swept.enabled, false)
    assert.deepEqual(swept.purged, [])
    assert.equal(await pathExists(join(disabled.paths.trashDir, trashId)), true)

    // Reads stay available so the user can see what is in the bin; only the
    // janitor is switched off, which is the whole point of the gate.
    const route = await call(disabled.api, '/trash', { method: 'GET' })
    assert.equal(route.status, 200)
    assert.deepEqual(route.body.entries.map((entry) => entry.trashId), [trashId])
    assert.equal(route.body.lastSweep, null)
  } finally {
    await source.home.cleanup()
    await disabled.home.cleanup()
  }
})

test('retention: listing never waits for the mutation lock', async () => {
  const fixture = await makeFixture()
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S2], includeMemory: false, mode: 'hard' } })
    await call(fixture.api, '/delete', {
      body: { sessionIds: [S2], includeMemory: false, mode: 'hard', confirmToken: preview.body.preview.confirmation.token },
    })
    // Read the id from disk: calling `trashList()` here would run a sweep and
    // start the five-minute throttle, so the listing below would skip it.
    const trashId = (await readdir(fixture.paths.trashDir))[0]
    const entryDir = join(fixture.paths.trashDir, trashId)
    const manifestPath = join(entryDir, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.deletedAt = Date.now() - 31 * 86_400_000
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

    // A live owner holds the cross-process lock, so a sweep that ran inline
    // would sit in `acquire` for the full 180 s lock budget.
    const lockPath = join(fixture.paths.dataDir, 'mutation.lock')
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, nonce: 'held-by-test', at: Date.now() })}
`, 'utf8')

    const started = Date.now()
    const listed = await call(fixture.api, '/trash', { method: 'GET' })
    const elapsed = Date.now() - started
    assert.equal(listed.status, 200)
    assert.ok(elapsed < 1500, `listing took ${elapsed} ms`)
    // The entry is still there: the response describes the bin as it was, and
    // the sweep is a background concern.
    assert.deepEqual(listed.body.entries.map((entry) => entry.trashId), [trashId])

    // Let the background sweep finish so the fixture can be cleaned up.
    await rm(lockPath, { force: true })
    await fixture.api.__test.sweepExpiredTrash()
    assert.equal(await pathExists(entryDir), false)
  } finally {
    await fixture.home.cleanup()
  }
})

test('retention: every entry carries the Host countdown', async () => {
  const fixture = await makeFixture()
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S2], includeMemory: false, mode: 'hard' } })
    await call(fixture.api, '/delete', {
      body: { sessionIds: [S2], includeMemory: false, mode: 'hard', confirmToken: preview.body.preview.confirmation.token },
    })
    const listed = await call(fixture.api, '/trash', { method: 'GET' })
    const entry = listed.body.entries[0]
    assert.equal(entry.daysLeft, 30)
    assert.equal(entry.expiresAt, entry.deletedAt + 30 * 86_400_000)
    // The Client greys out what the Host would refuse; without these flags it
    // only finds out after the click.
    assert.equal(entry.capabilities.canRestore, true)
    assert.equal(entry.capabilities.canPurge, true)
    assert.equal(listed.body.lastSweep !== undefined, true)
  } finally {
    await fixture.home.cleanup()
  }
})

test('mutation lock: a lock that cannot be removed on release is demoted instead of poisoning the next acquire', async () => {
  const home = await makeTempHome()
  try {
    const lockPath = join(home.root, 'mutation.lock')
    const fsp = await import('node:fs/promises')
    let refuseRemoval = true
    const lock = createFileLock({
      lockPath,
      timeoutMs: 500,
      staleMs: 60_000,
      retryMs: 5,
      warn: () => {},
      fsApi: {
        open: fsp.open,
        stat: fsp.stat,
        readFile: fsp.readFile,
        writeFile: fsp.writeFile,
        utimes: fsp.utimes,
        rm: async (target, options) => {
          if (refuseRemoval) {
            const error = new Error('EPERM: operation not permitted')
            error.code = 'EPERM'
            throw error
          }
          return fsp.rm(target, options)
        },
      },
    })
    const release = await lock.acquire()
    // The release cannot delete the file (a handle it cannot see holds it).
    await release()
    refuseRemoval = false
    // 0.3.11 left the lock owned by this live pid, so this acquire waited out
    // its whole budget and every later mutation failed with E_LOCK_BUSY.
    const again = await lock.acquire()
    await again()
    assert.equal(await pathExists(lockPath), false)
  } finally {
    await home.cleanup()
  }
})

test('mutation lock: a lock held by a live pid with no heartbeat for ten windows is broken', async () => {
  const home = await makeTempHome()
  try {
    const lockPath = join(home.root, 'mutation.lock')
    const fsp = await import('node:fs/promises')
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, nonce: 'held', at: Date.now() })}
`, 'utf8')
    const stale = new Date(Date.now() - 21 * 60_000)
    await fsp.utimes(lockPath, stale, stale)
    const lock = createFileLock({
      lockPath,
      timeoutMs: 1_000,
      staleMs: 120_000,
      retryMs: 5,
      // The pid is alive, so only the missing heartbeat can prove it is not the
      // process that took the lock (pid recycling, or a wedged holder).
      isProcessAlive: () => true,
      warn: () => {},
    })
    const release = await lock.acquire()
    await release()
  } finally {
    await home.cleanup()
  }
})

test('limits: the Host publishes the queue budget it actually enforces', async () => {
  const fixture = await makeFixture()
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S2], includeMemory: false, mode: 'hard' } })
    const planTimeoutMs = preview.body.preview.limits.planTimeoutMs
    // The Client used to derive its own budget from the lock budget alone, which
    // is 60 s short of the moment the Host actually gives up.
    assert.equal(preview.body.preview.limits.queueTimeoutMs, planTimeoutMs + QUEUE_GRACE_MS)
    const state = await call(fixture.api, '/state', { method: 'GET' })
    assert.equal(state.body.state.limits.queueTimeoutMs, TRASH_LOCK_BUDGET_MS + QUEUE_GRACE_MS)
  } finally {
    await fixture.home.cleanup()
  }
})

test('connection: a Host without a fence still answers the state probe, and nothing else', async () => {
  const fixture = await makeFixture({ configOverrides: { requireConnection: true } })
  try {
    // Without this one read the panel can only say "unauthorized", and the user
    // has no way to learn that the Host needs a connection layer.
    const state = await call(fixture.api, '/state', { method: 'GET' })
    assert.equal(state.status, 200)
    assert.equal(state.body.state.connectionFence, false)
    for (const path of ['/sessions', '/trash', '/audit']) {
      const refused = await call(fixture.api, path, { method: 'GET' })
      assert.equal(refused.status, 401, path)
      assert.equal(refused.body.error.code, 'E_UNAUTHORIZED')
    }
  } finally {
    await fixture.home.cleanup()
  }
})

test('confirmation: a failed plan leaves the token usable for the retry', async () => {
  const fixture = await makeFixture()
  try {
    const preview = await call(fixture.api, '/preview', { body: { sessionIds: [S1, S2], includeMemory: false, mode: 'hard' } })
    const token = preview.body.preview.confirmation.token
    // Both plans fail once their logs are gone (the same way a hand-cleaned
    // DSH_HOME does), which is exactly the case where burning the token forced
    // the user to re-preview everything just to retry.
    for (const sessionId of [S1, S2]) {
      await rm(fixture.seeded.get(sessionId).dir, { recursive: true, force: true })
    }
    const first = await call(fixture.api, '/delete', {
      body: { sessionIds: [S1, S2], includeMemory: false, mode: 'hard', confirmToken: token },
    })
    assert.equal(first.status, 500)

    const retry = await call(fixture.api, '/delete', {
      body: { sessionIds: [S1, S2], includeMemory: false, mode: 'hard', confirmToken: token },
    })
    assert.notEqual(retry.status, 410)
    assert.notEqual(retry.body.error?.code, 'E_CONFIRMATION_USED')
  } finally {
    await fixture.home.cleanup()
  }
})
