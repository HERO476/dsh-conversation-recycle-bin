import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULTS, normalizeConfig, resolveJsonPointer } from '../lib/core/config.js'
import { DeleteError } from '../lib/core/errors.js'
import { evaluateSessionPolicy, isPathInside } from '../lib/core/policy.js'
import { createSlidingWindowLimiter } from '../lib/core/rate-limit.js'
import { runSteps } from '../lib/core/transaction.js'

test('normalizeConfig: empty input yields the documented defaults', () => {
  const { value, warnings } = normalizeConfig(undefined)
  assert.deepEqual(value, DEFAULTS)
  assert.deepEqual(warnings, [])
})

test('normalizeConfig: unknown keys are reported, not thrown', () => {
  const { value, unknownKeys } = normalizeConfig({ nope: 1, enabled: true })
  assert.deepEqual(unknownKeys, ['nope'])
  assert.equal(value.enabled, true)
})

test('normalizeConfig: malformed values fall back, security booleans stay safe', () => {
  const { value, warnings } = normalizeConfig({
    enabled: 'yes',
    stopLiveSessions: 'true',
    liveDrainMs: -5,
    maxBatchSessions: 0,
    maxDeletesPerMinute: -5,
    defaultMode: 'nuke',
    protectedSessionIds: ['session-a', 42],
    allowedWorkspaceRoots: ['D:\\Work'],
    memory: { adapters: ['lingshu', 'bogus'], deleteMode: 'burn' },
  })
  assert.equal(value.enabled, true)
  assert.equal(value.stopLiveSessions, true)
  assert.equal(value.liveDrainMs, 0)
  assert.equal(value.maxBatchSessions, 1)
  assert.equal(value.maxDeletesPerMinute, 1)
  assert.equal(value.defaultMode, 'soft')
  assert.deepEqual(value.protectedSessionIds, [])
  assert.deepEqual(value.allowedWorkspaceRoots, ['D:\\Work'])
  assert.deepEqual(value.memory.adapters, ['lingshu'])
  assert.equal(value.memory.deleteMode, 'trash')
  assert.ok(warnings.length >= 4)
})

test('normalizeConfig: an empty adapter list degrades to the honest none adapter', () => {
  const { value } = normalizeConfig({ memory: { adapters: [] } })
  assert.deepEqual(value.memory.adapters, ['none'])
})

test('normalizeConfig: allowedHosts keeps only bare authorities and normalizes them', () => {
  const { value, warnings } = normalizeConfig({
    allowedHosts: [
      'App.Example',
      'app.example:8443',
      '  app.example  ',
      'https://app.example/ui/',
      'app.example/path',
      'user@app.example',
      '*.example',
      '',
      42,
    ],
  })
  // Case-folded, trailing dot removed, de-duplicated; anything with a scheme,
  // path, userinfo or wildcard is dropped rather than silently widened.
  assert.deepEqual(value.allowedHosts, ['app.example', 'app.example:8443'])
  assert.equal(warnings.filter((line) => line.startsWith('allowedHosts')).length, 5)
})

test('resolveJsonPointer follows escaped segments', () => {
  const document = { nodes: { a: 1 }, 'a/b': { c: 2 } }
  assert.equal(resolveJsonPointer(document, '/nodes').a, 1)
  assert.deepEqual(resolveJsonPointer(document, '/a~1b'), { c: 2 })
  assert.equal(resolveJsonPointer(document, '/missing'), undefined)
})

test('isPathInside compares Windows paths case-insensitively and by segment', () => {
  assert.equal(isPathInside('D:\\Work', 'd:/work/session'), true)
  assert.equal(isPathInside('D:\\Work', 'D:\\Work2\\x'), false)
  assert.equal(isPathInside('D:\\Work', 'D:\\Work'), true)
})

test('policy: refuses protected, orphan, subagent, strict-live and out-of-root sessions', () => {
  const config = normalizeConfig({ protectedSessionIds: ['session-protected'] }).value
  const base = { id: 'session-a', title: 'A', cwd: 'D:\\Work', origin: undefined, blank: false }
  const workspace = { id: 'ws', path: 'D:\\Work' }

  assert.equal(evaluateSessionPolicy({ session: { ...base, id: 'session-protected' }, workspace, live: false, mode: 'soft', config }).error.code, 'E_POLICY_PROTECTED')
  assert.equal(evaluateSessionPolicy({ session: base, workspace: null, live: false, mode: 'soft', config }).error.code, 'E_POLICY_ORPHAN')
  assert.equal(evaluateSessionPolicy({ session: { ...base, origin: 'subagent' }, workspace, live: false, mode: 'soft', config }).error.code, 'E_POLICY_SUBAGENT')

  // Default posture: hard deleting a live session is allowed because the
  // cascade stops it first; it only adds a warning.
  const allowedLive = evaluateSessionPolicy({ session: base, workspace, live: true, mode: 'hard', config })
  assert.equal(allowedLive.ok, true)
  assert.match(allowedLive.warnings[0], /live agent/)

  // Operators can restore the strict refusal.
  const strictConfig = normalizeConfig({ stopLiveSessions: false }).value
  assert.equal(evaluateSessionPolicy({ session: base, workspace, live: true, mode: 'hard', config: strictConfig }).error.code, 'E_POLICY_LIVE')
  assert.equal(evaluateSessionPolicy({ session: base, workspace, live: true, mode: 'soft', config: strictConfig }).ok, true)

  const rooted = normalizeConfig({ allowedWorkspaceRoots: ['E:\\Elsewhere'] }).value
  assert.equal(evaluateSessionPolicy({ session: base, workspace, live: false, mode: 'soft', config: rooted }).error.code, 'E_POLICY_ROOT')
})

test('policy: orphan deletion can be opted into and reports a warning', () => {
  const config = normalizeConfig({ allowOrphanSessions: true }).value
  const result = evaluateSessionPolicy({
    session: { id: 'session-a', cwd: 'D:\\Work' },
    workspace: null,
    live: false,
    mode: 'soft',
    config,
  })
  assert.equal(result.ok, true)
  assert.equal(result.warnings.length, 1)
})

test('rate limiter: sliding window, refill and status', () => {
  let clock = 1_000
  const limiter = createSlidingWindowLimiter({ limit: 2, windowMs: 60_000, now: () => clock })
  const first = limiter.take(1)
  assert.equal(first.ok, true)
  assert.equal(first.remaining, 1)
  const second = limiter.take(1)
  assert.equal(second.ok, true)
  assert.equal(second.remaining, 0)
  const denied = limiter.take(1)
  assert.equal(denied.ok, false)
  assert.equal(denied.limit, 2)
  assert.ok(denied.retryAfterMs > 0)
  clock += 60_001
  assert.equal(limiter.take(1).ok, true)
  assert.equal(limiter.status().used, 1)
})

test('rate limiter: a failed reservation releases its slot instead of spending the cap', () => {
  let clock = 1_000
  const limiter = createSlidingWindowLimiter({ limit: 1, windowMs: 60_000, now: () => clock })
  const failed = limiter.take(1)
  assert.equal(failed.ok, true)
  failed.release()
  assert.equal(limiter.status().used, 0)
  // The refunded slot is available again for a genuine deletion.
  const retry = limiter.take(1)
  assert.equal(retry.ok, true)
  assert.equal(limiter.status().used, 1)
})

test('runSteps: executes in order and reports success', async () => {
  const order = []
  const result = await runSteps([
    { name: 'a', run: async () => { order.push('a'); return async () => { order.push('undo-a') } } },
    { name: 'b', run: async () => { order.push('b') } },
  ])
  assert.deepEqual(result, { ok: true, completed: ['a', 'b'] })
  assert.deepEqual(order, ['a', 'b'])
})

test('runSteps: rolls completed steps back in REVERSE order', async () => {
  const order = []
  const result = await runSteps([
    { name: 'memory', run: async () => { order.push('memory'); return async () => { order.push('undo-memory') } } },
    { name: 'messages', run: async () => { order.push('messages'); return async () => { order.push('undo-messages') } } },
    { name: 'session', run: async () => { order.push('session'); throw new Error('boom') } },
  ])
  assert.equal(result.ok, false)
  assert.equal(result.failedStep, 'session')
  assert.equal(result.rolledBack, true)
  assert.deepEqual(order, ['memory', 'messages', 'session', 'undo-messages', 'undo-memory'])
})

test('runSteps: one failing undo does not stop the others and marks the rollback incomplete', async () => {
  const result = await runSteps([
    { name: 'a', run: async () => async () => { throw new Error('undo-a failed') } },
    { name: 'b', run: async () => async () => {} },
    { name: 'c', run: async () => { throw new Error('c failed') } },
  ])
  assert.equal(result.ok, false)
  assert.equal(result.rolledBack, false)
  assert.equal(result.rollbackErrors.length, 1)
  assert.equal(result.rollbackErrors[0].step, 'a')
})

test('errors: unknown exceptions are normalized without leaking the message', () => {
  const error = new DeleteError('E_TRANSACTION_FAILED', 'rolled back', { sessionId: 's' })
  assert.equal(error.httpStatus, 500)
  assert.equal(error.toJSON().sessionId, undefined)
  assert.equal(error.toJSON().details.sessionId, 's')
})
