import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../lib/core/config.js'
import { createFileLock } from '../lib/core/file-lock.js'
import { createDeleteApi, ROUTE_PREFIX } from '../lib/host/api.js'
import { createSessionLogOps } from '../lib/host/catalog.js'
import { createLifecycleOps } from '../lib/host/lifecycle.js'
import { resolveDataPaths } from '../lib/host/paths.js'
import { callRoute, makeTempHome, makeWorkspaceRegistry, pathExists, seedSession } from './helpers.mjs'

const S1 = 'session-aaaaaaaa-1111'
const S2 = 'session-bbbbbbbb-2222'
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
    { id: 'ws-2', path: 'D:\\Other', title: 'Other', sessionIds: [S2] },
  ])
  const seeded = new Map()
  const items = []
  for (const sessionId of sessionIds) {
    const meta = {
      [S1]: { cwd: 'D:\\Work', title: 'Alpha chat', eventCount: 12 },
      [S2]: { cwd: 'D:\\Other', title: 'Beta chat', eventCount: 8 },
      [ORPHAN]: { cwd: 'D:\\Unregistered', title: 'Orphan chat', eventCount: 3 },
    }[sessionId]
    seeded.set(sessionId, await seedSession(home, {
      sessionId,
      cwd: meta.cwd,
      title: meta.title,
      eventCount: meta.eventCount,
    }))
    items.push({ sessionId, updatedAt: Date.now(), running: false, blank: false, cwd: meta.cwd })
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
        return { header: record.header, eventCount: record.eventCount, sizeBytes: record.sizeBytes }
      },
    },
    sessionController: { list: async () => ({ items }) },
    sessions: { get: (sessionId) => (liveSessionIds.includes(sessionId) ? { id: sessionId } : undefined) },
    // The `connection` service is probed, not injected: a fixture without it
    // keeps the route behind its own fence, exactly like a Host composition
    // that does not publish the service.
    ...(connection === null ? {} : { connection }),
  }
  const config = normalizeConfig(configOverrides).value
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
    assert.equal(preview.sessions[0].events, 12)
    assert.equal(preview.sessions[0].policy.ok, true)
    assert.equal(preview.memory.total, 2)
    assert.equal(preview.memory.adapters.find((adapter) => adapter.id === 'lingshu').available, true)
    assert.equal(preview.confirmation.phrase, '')
    assert.equal(typeof preview.confirmation.token, 'string')
  } finally {
    await fixture.home.cleanup()
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
