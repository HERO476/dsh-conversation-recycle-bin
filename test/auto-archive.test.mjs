/**
 * "Archive → recycle bin": the pure policy and the durable state file.
 *
 * The Host-level behaviour (event → entry, dedupe, memory guard, restore) lives
 * in `api.test.mjs`, where the fixture already models a workspace registry,
 * session persistence and the trash store. This file covers the two pieces that
 * must be provable without any Host at all.
 */
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  ACTIVE_STATUSES,
  AUTO_ORIGIN,
  EMPTY_STATE,
  applyDecision,
  effectiveAutoArchive,
  findActiveEntryForSession,
  isActiveStatus,
  isAutoEntry,
  normalizeAutoState,
  shouldPromptForDecision,
} from '../lib/core/auto-archive.js'
import { createAutoArchiveStore } from '../lib/host/auto-archive-store.js'
import { makeTempHome } from './helpers.mjs'

/* ------------------------------------------------------------------ *
 * The gate: unanswered must never act
 * ------------------------------------------------------------------ */

test('auto-archive: an unanswered prompt NEVER enables the feature', () => {
  // This is the whole point of the tri-state. A boolean could not tell "the
  // user chose on" from "nobody asked", and treating the second as the first
  // started an irreversible 30-day countdown before the question was shown.
  const verdict = effectiveAutoArchive({ pluginEnabled: true, configEnabled: true, autoState: { state: 'unasked' } })
  assert.deepEqual(verdict, { mode: 'off', reason: 'unasked' })
})

test('auto-archive: an explicit on is required, and both vetoes win over it', () => {
  assert.deepEqual(
    effectiveAutoArchive({ pluginEnabled: true, configEnabled: true, autoState: { state: 'on' } }),
    { mode: 'on', reason: 'user-enabled' },
  )
  assert.deepEqual(
    effectiveAutoArchive({ pluginEnabled: true, configEnabled: true, autoState: { state: 'off' } }),
    { mode: 'off', reason: 'user-disabled' },
  )
  // The operator veto outranks a stored answer: a deployment can switch the
  // feature off regardless of what a previous user said.
  assert.deepEqual(
    effectiveAutoArchive({ pluginEnabled: true, configEnabled: false, autoState: { state: 'on' } }),
    { mode: 'off', reason: 'config-disabled' },
  )
  // The master switch outranks everything.
  assert.deepEqual(
    effectiveAutoArchive({ pluginEnabled: false, configEnabled: true, autoState: { state: 'on' } }),
    { mode: 'off', reason: 'plugin-disabled' },
  )
})

test('auto-archive: the upgrade prompt is asked once, and never when it cannot act', () => {
  const base = { pluginEnabled: true, configEnabled: true, askOnUpgrade: true }
  assert.equal(shouldPromptForDecision({ ...base, autoState: { state: 'unasked' } }), true)
  // Answered either way: never asked again.
  assert.equal(shouldPromptForDecision({ ...base, autoState: { state: 'on' } }), false)
  assert.equal(shouldPromptForDecision({ ...base, autoState: { state: 'off' } }), false)
  // No point asking when the answer could not take effect.
  assert.equal(shouldPromptForDecision({ ...base, configEnabled: false, autoState: { state: 'unasked' } }), false)
  assert.equal(shouldPromptForDecision({ ...base, askOnUpgrade: false, autoState: { state: 'unasked' } }), false)
  assert.equal(shouldPromptForDecision({ ...base, pluginEnabled: false, autoState: { state: 'unasked' } }), false)
})

/* ------------------------------------------------------------------ *
 * State file normalization: every unusable shape is safe
 * ------------------------------------------------------------------ */

test('auto-archive: a broken state file reads as unasked, never as enabled', () => {
  for (const raw of [null, undefined, 42, 'on', [], { state: 'on' }]) {
    const { value } = normalizeAutoState(raw)
    assert.equal(value.state, 'unasked', `${JSON.stringify(raw)} must not enable anything`)
    assert.equal(value.decidedAt, null)
  }
  // A decision with no timestamp cannot be audited, so it is not a decision.
  const { value } = normalizeAutoState({ schema: 1, state: 'on', decidedAt: null })
  assert.equal(value.state, 'unasked')
  // An unknown state string is not guessed into "on".
  assert.equal(normalizeAutoState({ schema: 1, state: 'maybe', decidedAt: 1 }).value.state, 'unasked')
  // A future schema is not interpreted by a version that cannot know it.
  assert.equal(normalizeAutoState({ schema: 99, state: 'on', decidedAt: 1 }).value.state, 'unasked')
  // The happy path keeps the fields the audit and the UI need.
  const good = normalizeAutoState({ schema: 1, state: 'on', decidedAt: 1700000000000, decidedBy: 'web-ui', ackedVersion: '0.3.23', baseArchivedAt: 1700000000000 })
  assert.equal(good.value.state, 'on')
  assert.equal(good.value.decidedBy, 'web-ui')
  assert.equal(good.value.ackedVersion, '0.3.23')
  assert.equal(good.value.baseArchivedAt, 1700000000000)
})

test('auto-archive: answering writes a complete, auditable record', () => {
  const on = applyDecision({ decision: 'on', version: '0.3.23', decidedBy: 'web-ui', now: 5000 })
  assert.equal(on.state, 'on')
  assert.equal(on.decidedAt, 5000)
  assert.equal(on.baseArchivedAt, 5000)
  // Turning it off keeps the original start, so the trail can still explain
  // entries that are already in the bin.
  const off = applyDecision({ decision: 'off', version: '0.3.23', decidedBy: 'web-ui', now: 9000, previous: on })
  assert.equal(off.state, 'off')
  assert.equal(off.baseArchivedAt, 5000)
  assert.equal(off.decidedAt, 9000)
  assert.throws(() => applyDecision({ decision: 'maybe', now: 1 }), RangeError)
})

/* ------------------------------------------------------------------ *
 * Idempotency: one conversation, one entry
 * ------------------------------------------------------------------ */

test('auto-archive: an in-flight entry for the same session blocks a second one', () => {
  const entries = [
    { trashId: 't1', sessionId: 'session-a', status: 'trashed' },
    { trashId: 't2', sessionId: 'session-b', status: 'failed' },
    { trashId: 't3', sessionId: 'session-c', status: 'restored' },
    { trashId: 't4', sessionId: 'session-d', status: 'purging' },
    { trashId: 't5', sessionId: 'session-e', status: 'pending' },
  ]
  assert.equal(findActiveEntryForSession(entries, 'session-a').trashId, 't1')
  // `purging` counts: a new entry created under it would be swept twice.
  assert.equal(findActiveEntryForSession(entries, 'session-d').trashId, 't4')
  // `pending` is REPORTED, not skipped: a crash mid-delete would otherwise
  // block this conversation forever.
  assert.equal(findActiveEntryForSession(entries, 'session-e').trashId, 't5')
  // `failed` and `restored` do not: one unwritable audit line must not cost the
  // conversation its 30-day promise, and a restored log is back in place.
  assert.equal(findActiveEntryForSession(entries, 'session-b'), null)
  assert.equal(findActiveEntryForSession(entries, 'session-c'), null)
  assert.equal(findActiveEntryForSession(entries, 'session-zzz'), null)
  assert.equal(findActiveEntryForSession(null, 'session-a'), null)
  assert.equal(findActiveEntryForSession(entries, ''), null)
  // The status list is the contract; a new status must be classified here.
  assert.deepEqual([...ACTIVE_STATUSES], ['pending', 'trashed', 'restoring', 'purging'])
  assert.equal(isActiveStatus('trashed'), true)
  assert.equal(isActiveStatus('restored'), false)
})

test('auto-archive: only the auto origin counts as automatic', () => {
  assert.equal(isAutoEntry({ origin: AUTO_ORIGIN }), true)
  assert.equal(isAutoEntry({ origin: 'user' }), false)
  // A pre-upgrade manifest has no `origin` at all: it was a user deletion.
  assert.equal(isAutoEntry({ trashId: 't1' }), false)
  assert.equal(isAutoEntry(null), false)
  assert.equal(isAutoEntry(undefined), false)
})

/* ------------------------------------------------------------------ *
 * Store: atomic, durable, and fail-safe on damage
 * ------------------------------------------------------------------ */

test('auto-archive store: a missing file reads as unasked and survives a round trip', async () => {
  const home = await makeTempHome('crb-auto-state-')
  try {
    const filePath = join(home.root, 'delete-conversation', 'auto-archive.json')
    const store = createAutoArchiveStore({ filePath, now: () => 777, logger: { warn() {} } })

    const missing = await store.read()
    assert.equal(missing.exists, false)
    assert.deepEqual(missing.state, { ...EMPTY_STATE })
    assert.equal(effectiveAutoArchive({ pluginEnabled: true, configEnabled: true, autoState: missing.state }).mode, 'off')

    const written = await store.decide({ decision: 'on', version: '0.3.23', decidedBy: 'web-ui' })
    assert.equal(written.state, 'on')
    assert.equal(written.decidedAt, 777)

    const reread = await store.read()
    assert.equal(reread.exists, true)
    assert.equal(reread.state.state, 'on')
    assert.equal(reread.state.ackedVersion, '0.3.23')
    // On disk, not in memory: a second Host process must see the same answer.
    const raw = JSON.parse(await readFile(filePath, 'utf8'))
    assert.equal(raw.state, 'on')
    assert.equal(raw.schema, 1)
  } finally {
    await home.cleanup()
  }
})

test('auto-archive store: a corrupt file is reported, not silently trusted', async () => {
  const home = await makeTempHome('crb-auto-state-bad-')
  try {
    const filePath = join(home.root, 'delete-conversation', 'auto-archive.json')
    await mkdir(join(home.root, 'delete-conversation'), { recursive: true })
    await writeFile(filePath, '{ this is not json', 'utf8')
    const warnings = []
    const store = createAutoArchiveStore({ filePath, now: () => 1, logger: { warn: (message) => warnings.push(message) } })
    const result = await store.read()
    assert.equal(result.state.state, 'unasked')
    assert.equal(result.exists, true)
    assert.deepEqual(result.warnings, ['state file corrupt'])
    assert.equal(warnings.length, 1)
    // Flipping it back on repairs the file.
    const repaired = await store.decide({ decision: 'off', version: null, decidedBy: null })
    assert.equal(repaired.state, 'off')
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).state, 'off')
  } finally {
    await home.cleanup()
  }
})
