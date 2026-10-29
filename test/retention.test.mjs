import assert from 'node:assert/strict'
import test from 'node:test'
import { DAY_MS, DEFAULT_MAX_PER_RUN, daysUntilExpiry, selectExpired } from '../lib/core/retention.js'

const NOW = 1_700_000_000_000
const entry = (overrides) => ({
  format: 1,
  trashId: 'ab12cd-ef34',
  sessionId: 'session-aaaaaaaa-1111',
  status: 'trashed',
  deletedAt: NOW - 31 * DAY_MS,
  ...overrides,
})

test('retention: an entry past the window is selected, one inside it is not', () => {
  const expired = selectExpired([
    entry({ trashId: 'old-0001', deletedAt: NOW - 31 * DAY_MS }),
    entry({ trashId: 'new-0002', deletedAt: NOW - 29 * DAY_MS }),
  ], { retentionDays: 30, now: NOW })
  assert.deepEqual(expired.map((item) => item.trashId), ['old-0001'])
})

test('retention: exactly at the boundary counts as expired', () => {
  const expired = selectExpired([entry({ deletedAt: NOW - 30 * DAY_MS })], { retentionDays: 30, now: NOW })
  assert.equal(expired.length, 1)
})

test('retention: 0 disables the sweep entirely', () => {
  assert.deepEqual(selectExpired([entry({})], { retentionDays: 0, now: NOW }), [])
  assert.deepEqual(selectExpired([entry({})], { retentionDays: -5, now: NOW }), [])
  assert.deepEqual(selectExpired([entry({})], { retentionDays: Number.NaN, now: NOW }), [])
})

test('retention: only committed entries expire; mid-transaction states are left to the user', () => {
  const statuses = ['pending', 'failed', 'restoring', 'restored', 'purging']
  const expired = selectExpired(
    statuses.map((status, index) => entry({ trashId: `st-${index}000`, status })),
    { retentionDays: 30, now: NOW },
  )
  assert.deepEqual(expired, [])
})

test('retention: an undatable entry is never treated as old', () => {
  const expired = selectExpired([
    entry({ trashId: 'no-date-1', deletedAt: undefined }),
    entry({ trashId: 'zero-date', deletedAt: 0 }),
    entry({ trashId: 'nan-date', deletedAt: Number.NaN }),
    entry({ trashId: 'str-date', deletedAt: 'yesterday' }),
  ], { retentionDays: 30, now: NOW })
  assert.deepEqual(expired, [])
})

test('retention: oldest first, capped per run', () => {
  const entries = [5, 40, 32, 60, 45].map((age, index) => entry({ trashId: `id-${index}000`, deletedAt: NOW - age * DAY_MS }))
  const expired = selectExpired(entries, { retentionDays: 30, now: NOW, limit: 3 })
  assert.deepEqual(expired.map((item) => item.deletedAt), [
    NOW - 60 * DAY_MS,
    NOW - 45 * DAY_MS,
    NOW - 40 * DAY_MS,
  ])
})

test('retention: garbage input yields no candidates instead of throwing', () => {
  assert.deepEqual(selectExpired(null, { retentionDays: 30, now: NOW }), [])
  assert.deepEqual(selectExpired([null, 'x', 42], { retentionDays: 30, now: NOW }), [])
})

test('retention: daysUntilExpiry reports the remaining whole days', () => {
  assert.equal(daysUntilExpiry(entry({ deletedAt: NOW - 29 * DAY_MS }), { retentionDays: 30, now: NOW }), 1)
  assert.equal(daysUntilExpiry(entry({ deletedAt: NOW - 31 * DAY_MS }), { retentionDays: 30, now: NOW }), 0)
  assert.equal(daysUntilExpiry(entry({}), { retentionDays: 0, now: NOW }), null)
  assert.equal(daysUntilExpiry(entry({ deletedAt: undefined }), { retentionDays: 30, now: NOW }), null)
})

test('retention: the default per-run cap is shared, not duplicated', () => {
  const entries = Array.from({ length: 30 }, (_, index) =>
    entry({ trashId: `cap-${index}000`, deletedAt: NOW - (40 + index) * DAY_MS }))
  assert.equal(selectExpired(entries, { retentionDays: 30, now: NOW }).length, DEFAULT_MAX_PER_RUN)
  assert.equal(DEFAULT_MAX_PER_RUN, 20)
})

test('retention: a row that can never be swept gets no countdown', () => {
  // A restored entry sits in the bin but the sweep only looks at `trashed`, so
  // showing "auto-purged in 3 d" on it would promise something that never runs.
  assert.equal(daysUntilExpiry(entry({ status: 'restored' }), { retentionDays: 30, now: NOW }), null)
  assert.equal(daysUntilExpiry(entry({ status: 'pending' }), { retentionDays: 30, now: NOW }), null)
  assert.equal(daysUntilExpiry(entry({ status: 'trashed' }), { retentionDays: 30, now: NOW }), 0)
})
