import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeConfig } from '../lib/core/config.js'
import { performPurge, performRestore, performSessionDelete } from '../lib/core/cascade.js'

function makeTrash() {
  const entries = new Map()
  let counter = 0
  return {
    entries,
    calls: [],
    async allocate({ sessionId }) {
      counter += 1
      const trashId = `t${counter}-${sessionId.slice(-4)}`
      return { trashId, dir: `/trash/${trashId}` }
    },
    async write(entry) {
      this.calls.push(['write', entry.status])
      entries.set(entry.trashId, { ...entry })
    },
    async update(trashId, patch) {
      const current = entries.get(trashId)
      entries.set(trashId, { ...current, ...patch })
      return entries.get(trashId)
    },
    async read(trashId) {
      return entries.get(trashId) ?? null
    },
    async list() {
      return [...entries.values()].filter((entry) => entry.status === 'trashed')
    },
    async remove(trashId) {
      this.calls.push(['remove', trashId])
      entries.delete(trashId)
    },
    entryDir(trashId) {
      return `/trash/${trashId}`
    },
  }
}

function makeAudit() {
  const records = []
  return {
    records,
    async append(record) {
      records.push(record)
    },
  }
}

function makeOps(options = {}) {
  const calls = []
  const state = { failAt: options.failAt ?? null, inspect: options.inspect ?? null }
  const maybeFail = (name) => {
    if (state.failAt === name) throw new Error(`${name} exploded`)
  }
  return {
    calls,
    state,
    ops: {
      memory: {
        async exportForSession(sessionId) {
          calls.push(['memory', sessionId])
          maybeFail('memory')
          return { adapters: [{ id: 'lingshu', label: '灵枢', count: 2, bundlePath: '/trash/memory/lingshu/bundle.json' }], total: 2, protected: 1 }
        },
        async restoreEntry(summary) {
          calls.push(['memory-restore', summary.total])
        },
      },
      sessionLog: {
        async moveToTrash(session) {
          calls.push(['messages', session.id])
          maybeFail('messages')
          return { sessionId: session.id, from: '/sessions/session', to: '/trash/session' }
        },
        async restoreEntry(moved) {
          calls.push(['messages-restore', moved.sessionId])
        },
      },
      catalog: {
        async capture(session) {
          calls.push(['catalog-capture', session.id])
          return { sessionId: session.id, workspaceId: session.workspaceId, index: 0, nextSessionId: null, archived: false, pinned: false }
        },
        async remove(session, mode, snapshot) {
          calls.push(['session', mode, snapshot.workspaceId])
          maybeFail('session')
          return async () => {
            calls.push(['session-undo', session.id])
          }
        },
        async restore(snapshot) {
          calls.push(['catalog-restore', snapshot.sessionId])
          return async () => {
            calls.push(['catalog-restore-undo', snapshot.sessionId])
          }
        },
      },
      session: {
        async inspect(sessionId) {
          calls.push(['inspect', sessionId])
          if (typeof state.inspect === 'function') return state.inspect(sessionId)
          return { id: sessionId, title: 'T', cwd: 'D:\\Work', workspace: { id: 'ws' }, workspaceId: 'ws', archived: true, pinned: false }
        },
      },
      lifecycle: {
        async quiesce(liveSession) {
          calls.push(['quiesce', liveSession.id])
          maybeFail('quiesce')
          return async () => {
            calls.push(['quiesce-undo', liveSession.id])
          }
        },
      },
    },
  }
}

const session = { id: 'session-abc12345', title: 'Test chat', cwd: 'D:\\Work', workspaceId: 'ws-1', archived: false, pinned: false }
const config = normalizeConfig({}).value

test('delete: memory is deleted before messages before the session record', async () => {
  const { ops, calls } = makeOps()
  const trash = makeTrash()
  const audit = makeAudit()
  const outcome = await performSessionDelete({
    session, mode: 'hard', includeMemory: true, ops, trash, audit, config,
    now: () => 1_000,
  })
  assert.deepEqual(calls.map((call) => call[0]), ['memory', 'messages', 'catalog-capture', 'session'])
  assert.equal(audit.records.length, 1)
  assert.equal(audit.records[0].result, 'success')
  assert.equal(outcome.memory.total, 2)
  const entry = trash.entries.get(outcome.entry.trashId)
  assert.equal(entry.status, 'trashed')
  assert.equal(entry.mode, 'hard')
  assert.equal(entry.sessionLog.to, '/trash/session')
})

test('delete: unchecked memory is never touched', async () => {
  const { ops, calls } = makeOps()
  const result = await performSessionDelete({
    session, mode: 'soft', includeMemory: false, ops, trash: makeTrash(), audit: makeAudit(), config,
  })
  assert.deepEqual(calls.map((call) => call[0]), ['catalog-capture', 'session'])
  assert.equal(result.memory.total, 0)
})

test('delete: failure at the session stage rolls memory and messages back', async () => {
  const { ops, calls, state } = makeOps()
  state.failAt = 'session'
  const trash = makeTrash()
  const audit = makeAudit()
  await assert.rejects(
    performSessionDelete({ session, mode: 'hard', includeMemory: true, ops, trash, audit, config }),
    (error) => {
      assert.equal(error.code, 'E_TRANSACTION_FAILED')
      assert.equal(error.details.failedStep, 'session')
      assert.equal(error.details.rolledBack, true)
      return true
    },
  )
  assert.deepEqual(calls.map((call) => call[0]), [
    'memory', 'messages', 'catalog-capture', 'session', 'messages-restore', 'memory-restore',
  ])
  const entry = [...trash.entries.values()][0]
  assert.equal(entry.status, 'failed')
  assert.equal(audit.records[0].result, 'rolled-back')
  assert.equal(audit.records[0].rollback.ok, true)
})

test('delete: failure at the memory stage leaves messages and catalog untouched', async () => {
  const { ops, calls, state } = makeOps()
  state.failAt = 'memory'
  await assert.rejects(
    performSessionDelete({ session, mode: 'hard', includeMemory: true, ops, trash: makeTrash(), audit: makeAudit(), config }),
    { code: 'E_TRANSACTION_FAILED' },
  )
  assert.deepEqual(calls.map((call) => call[0]), ['memory'])
})

test('delete: one failing undo is reported, not hidden', async () => {
  const { ops, state } = makeOps()
  state.failAt = 'session'
  ops.memory.restoreEntry = async () => { throw new Error('restore failed') }
  const outcome = performSessionDelete({ session, mode: 'hard', includeMemory: true, ops, trash: makeTrash(), audit: makeAudit(), config })
  await assert.rejects(outcome, (error) => {
    assert.equal(error.details.rolledBack, false)
    assert.equal(error.details.rollbackErrors[0].step, 'memory')
    return true
  })
})

test('restore: payload first, catalog second, memory last; entry is removed', async () => {
  const { ops, calls } = makeOps()
  const trash = makeTrash()
  const entry = {
    format: 1,
    trashId: 't9-1234',
    sessionId: session.id,
    title: 'Test chat',
    mode: 'hard',
    includeMemory: true,
    status: 'trashed',
    sessionLog: { sessionId: session.id, from: '/sessions/session', to: '/trash/session' },
    catalog: { sessionId: session.id, workspaceId: 'ws-1', index: 0, nextSessionId: null, archived: false, pinned: false },
    memory: { adapters: [{ id: 'lingshu', count: 2, bundlePath: '/brand/x' }], total: 2 },
  }
  trash.entries.set(entry.trashId, entry)
  await performRestore({ entry, ops, trash, audit: makeAudit(), now: () => 2_000 })
  assert.deepEqual(calls.map((call) => call[0]), ['messages-restore', 'catalog-restore', 'memory-restore'])
  assert.equal(trash.entries.has(entry.trashId), false)
})

test('restore: a failing session step rolls the message restore back', async () => {
  const { ops, state } = makeOps()
  state.failAt = 'session'
  ops.sessionLog.restoreEntry = async (moved) => { ops.calls.push(['messages-restore', moved.sessionId]) }
  ops.catalog.restore = async () => {
    ops.calls.push(['catalog-restore'])
    throw new Error('catalog restore failed')
  }
  const trash = makeTrash()
  const entry = {
    format: 1, trashId: 't9-1234', sessionId: session.id, title: 'T', mode: 'hard', includeMemory: false,
    status: 'trashed', sessionLog: { sessionId: session.id, to: '/trash/session' },
    catalog: { sessionId: session.id, workspaceId: 'ws-1' }, memory: { adapters: [], total: 0 },
  }
  trash.entries.set(entry.trashId, entry)
  await assert.rejects(performRestore({ entry, ops, trash, audit: makeAudit() }), { code: 'E_TRANSACTION_FAILED' })
  assert.equal(trash.entries.get(entry.trashId).status, 'trashed')
})

test('purge: a soft entry performs the missing hard stages before removing the bundle', async () => {
  const { ops, calls } = makeOps()
  const trash = makeTrash()
  const entry = {
    format: 1, trashId: 't7-abcd', sessionId: session.id, title: 'T', mode: 'soft', includeMemory: true,
    status: 'trashed', sessionLog: null, catalog: { sessionId: session.id, workspaceId: 'ws-1' },
    memory: { adapters: [], total: 0 },
  }
  trash.entries.set(entry.trashId, entry)
  await performPurge({ entry, ops, trash, audit: makeAudit() })
  assert.deepEqual(calls.map((call) => call[0]), ['inspect', 'messages', 'catalog-capture', 'session'])
  assert.equal(trash.entries.has(entry.trashId), false)
})

test('purge: a soft entry whose session is already gone only removes the bundle', async () => {
  const { ops, calls } = makeOps({ inspect: async () => null })
  const trash = makeTrash()
  const entry = {
    format: 1, trashId: 't7-abcd', sessionId: session.id, title: 'T', mode: 'soft', includeMemory: false,
    status: 'trashed', sessionLog: null, catalog: { sessionId: session.id, workspaceId: null }, memory: { adapters: [], total: 0 },
  }
  trash.entries.set(entry.trashId, entry)
  await performPurge({ entry, ops, trash, audit: makeAudit() })
  assert.deepEqual(calls.map((call) => call[0]), ['inspect'])
  assert.equal(trash.entries.has(entry.trashId), false)
})

test('delete: a live hard delete is quiesced before memory and messages', async () => {
  const { ops, calls } = makeOps()
  const liveSession = { ...session, live: true, running: false }
  await performSessionDelete({
    session: liveSession, mode: 'hard', includeMemory: true, ops, trash: makeTrash(), audit: makeAudit(), config,
  })
  assert.deepEqual(calls.map((call) => call[0]), ['quiesce', 'memory', 'messages', 'catalog-capture', 'session'])
})

test('delete: a failing live hard delete rolls the quiesce step back last', async () => {
  const { ops, calls, state } = makeOps()
  state.failAt = 'session'
  const liveSession = { ...session, live: true, running: false }
  await assert.rejects(
    performSessionDelete({
      session: liveSession, mode: 'hard', includeMemory: true, ops, trash: makeTrash(), audit: makeAudit(), config,
    }),
    { code: 'E_TRANSACTION_FAILED' },
  )
  assert.deepEqual(calls.map((call) => call[0]), [
    'quiesce', 'memory', 'messages', 'catalog-capture', 'session',
    'messages-restore', 'memory-restore', 'quiesce-undo',
  ])
})

test('purge: a live soft entry is quiesced before its log is removed', async () => {
  const liveSession = { ...session, archived: true, live: true, running: false }
  const { ops, calls } = makeOps({ inspect: async () => liveSession })
  const trash = makeTrash()
  const entry = {
    format: 1, trashId: 't7-live', sessionId: session.id, title: 'T', mode: 'soft', includeMemory: false,
    status: 'trashed', sessionLog: null, catalog: { sessionId: session.id, workspaceId: 'ws-1' }, memory: { adapters: [], total: 0 },
  }
  trash.entries.set(entry.trashId, entry)
  await performPurge({ entry, ops, trash, audit: makeAudit() })
  assert.deepEqual(calls.map((call) => call[0]), ['inspect', 'quiesce', 'messages', 'catalog-capture', 'session'])
  assert.equal(trash.entries.has(entry.trashId), false)
})
