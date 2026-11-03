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

test('gateway: an unknown projection version degrades to no title instead of misreading fields', async () => {
  await withFixture(8, async ({ paths, ctx }) => {
    const gateway = createSessionGateway({ ctx, paths, now: () => 1_700_000_000_200 })
    const rows = await gateway.list()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].title, '')
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
