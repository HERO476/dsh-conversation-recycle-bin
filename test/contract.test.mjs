/**
 * Contract fixtures for the Host shapes this plugin reads off disk.
 *
 * These are NOT a substitute for a real Host: `test/api.test.mjs` runs against a
 * fake Host, and the only honest proof that the code fits a running 0.2.2-alpha.3
 * is a started instance (`scripts/verify-host-contract.mjs`). What these cases
 * do is pin the exact on-disk shapes the gateway depends on, so a Host upgrade
 * shows up as a red test instead of a silently empty title or a wrong pin state.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveDataPaths } from '../lib/host/paths.js'
import { createSessionGateway } from '../lib/host/gateway.js'

const SESSION_ID = 'session-alpha'

/**
 * Minimal dshHome: the per-session projection file, the workspace registry and
 * one session-controller row. `projectionVersion` is the only variable, so the
 * version gate is what each case actually exercises.
 */
async function makeHostFixture(projectionVersion) {
  const dshHome = await mkdtemp(join(tmpdir(), 'crb-contract-'))
  const paths = resolveDataPaths(dshHome)
  const projections = join(paths.storagesDir, 'session_projcache', 'sessions')
  await mkdir(projections, { recursive: true })
  await writeFile(
    paths.workspaceFile,
    JSON.stringify({
      global: {
        archivedSessionIds: ['session-archived'],
        pinnedSessionIds: ['session-pinned'],
      },
    }),
  )
  await writeFile(
    join(projections, `${SESSION_ID}.json`),
    JSON.stringify({
      version: projectionVersion,
      record: {
        identity: { formatVersion: 4, createdAt: 1_700_000_000_000 },
        rows: {
          title: { val: 'Projection title' },
          sessionListMetadata: { val: { blank: false } },
        },
      },
    }),
  )
  const ctx = {
    get(name) {
      if (name !== 'sessionController') return undefined
      return {
        list: async () => ({ items: [{ sessionId: SESSION_ID, cwd: '/work/a', updatedAt: 1_700_000_000_001 }] }),
      }
    },
  }
  return { dshHome, paths, ctx }
}

async function withFixture(projectionVersion, run) {
  const fixture = await makeHostFixture(projectionVersion)
  try {
    await run(fixture)
  } finally {
    await rm(fixture.dshHome, { recursive: true, force: true })
  }
}

test('gateway: the per-session projection (v7) supplies the title when the legacy bulk file is gone', async () => {
  await withFixture(7, async ({ paths, ctx }) => {
    const gateway = createSessionGateway({ ctx, paths, now: () => 1_700_000_000_000 })
    const rows = await gateway.list()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, SESSION_ID)
    // Host 0.2.2+ no longer writes `storages/session_projcache.json`; before
    // this fallback every list row rendered untitled.
    assert.equal(rows[0].title, 'Projection title')
  })
})

test('gateway: a bumped projection version with the same fields still supplies the title', async () => {
  // 0.3.22 reversed the old `version !== 7 → give up` rule. A Host that bumps
  // the format while keeping `rows.title.val` / `rows.sessionListMetadata.val`
  // must NOT cost every row its title — the previous expectation baked that
  // degradation in, so a real drift would have shipped green.
  await withFixture(8, async ({ paths, ctx }) => {
    const gateway = createSessionGateway({ ctx, paths, now: () => 1_700_000_000_200 })
    const rows = await gateway.list()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].title, 'Projection title')
    // ...and the foreign version is reported instead of silently accepted.
    assert.equal(gateway.diagnostics().projection.foreignVersion, 1)
  })
})

test('gateway: an unreadable projection shape degrades to no title AND is reported', async () => {
  await withFixture(8, async ({ paths, ctx }) => {
    // Same version, different field names: the capability check must reject it.
    await writeFile(join(paths.storagesDir, 'session_projcache', 'sessions', `${SESSION_ID}.json`),
      JSON.stringify({ version: 8, record: { rows: { headline: { val: 'Renamed field' } } } }), 'utf8')
    const gateway = createSessionGateway({ ctx, paths, now: () => 1_700_000_000_300 })
    const rows = await gateway.list()
    assert.equal(rows[0].title, '')
    assert.equal(gateway.diagnostics().projection.malformed, 1)
  })
})

function legacyTable(version, title) {
  return JSON.stringify({
    unit: { name: 'session_projcache', version },
    global: null,
    tables: {
      sessions: {
        [SESSION_ID]: {
          identity: { createdAt: 1_600_000_000_000, cwd: '/work/a' },
          rows: { title: { val: title }, sessionListMetadata: { val: { blank: false } } },
        },
      },
    },
  })
}

test('gateway: a legacy bulk table whose unit.version is unknown is skipped, not trusted', async () => {
  await withFixture(7, async ({ paths, ctx }) => {
    // The legacy file is the FALLBACK, so remove the authoritative checkpoint
    // to make the legacy read the only title source.
    await rm(join(paths.storagesDir, 'session_projcache', 'sessions', `${SESSION_ID}.json`), { force: true })
    await writeFile(join(paths.storagesDir, 'session_projcache.json'), legacyTable(99, 'Legacy title'), 'utf8')
    const gateway = createSessionGateway({ ctx, paths, now: () => 1_700_000_000_500 })
    const rows = await gateway.list()
    assert.equal(rows[0].title, '')
    assert.equal(gateway.diagnostics().legacyTitles, 'v99')
  })
})

test('gateway: the per-record checkpoint outranks a stale legacy title', async () => {
  await withFixture(7, async ({ paths, ctx }) => {
    // The legacy dump is frozen at the migration moment; the conversation was
    // renamed afterwards. The authoritative checkpoint must win.
    await writeFile(join(paths.storagesDir, 'session_projcache.json'), legacyTable(3, 'Old name'), 'utf8')
    const gateway = createSessionGateway({ ctx, paths, now: () => 1_700_000_000_600 })
    const rows = await gateway.list()
    assert.equal(rows[0].title, 'Projection title')
    assert.equal(gateway.diagnostics().legacyTitles, 'v3')
  })
})

test('gateway: the legacy bulk table still titles a row with no checkpoint on disk', async () => {
  await withFixture(7, async ({ paths, ctx }) => {
    await rm(join(paths.storagesDir, 'session_projcache', 'sessions', `${SESSION_ID}.json`), { force: true })
    await writeFile(join(paths.storagesDir, 'session_projcache.json'), legacyTable(3, 'Legacy title'), 'utf8')
    const gateway = createSessionGateway({ ctx, paths, now: () => 1_700_000_000_700 })
    const rows = await gateway.list()
    assert.equal(rows[0].title, 'Legacy title')
    assert.equal(rows[0].createdAt, 1_600_000_000_000)
  })
})

test('gateway: workspace.json archived/pinned sets are read verbatim', async () => {
  await withFixture(7, async ({ paths, ctx }) => {
    const gateway = createSessionGateway({ ctx, paths, now: () => 1_700_000_000_400 })
    const state = await gateway.workspaceState()
    assert.deepEqual([...state.archived], ['session-archived'])
    assert.deepEqual([...state.pinned], ['session-pinned'])
  })
})
