/**
 * Feedback channel: config normalization, payload validation, message
 * rendering, both transports and the HTTP route.
 *
 * The transport tests never touch the network: the HTTP transport receives an
 * injected `fetch`, and the SMTP test only asserts the documented "nodemailer
 * is optional" failure when the package is absent from the checkout.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeConfig } from '../lib/core/config.js'
import { DeleteError } from '../lib/core/errors.js'
import { createDeleteApi, ROUTE_PREFIX } from '../lib/host/api.js'
import {
  FEEDBACK_ENV,
  FEEDBACK_LIMITS,
  createFeedbackService,
  decodeAddress,
  renderFeedbackMessage,
  resolveFeedbackSettings,
  validateFeedbackPayload,
} from '../lib/host/feedback.js'
import { resolveDataPaths } from '../lib/host/paths.js'
import { PLUGIN_VERSION } from '../lib/version.js'
import { callRoute, makeTempHome } from './helpers.mjs'

const HEADERS = {
  'x-conversation-recycle-bin': '1',
  origin: 'http://127.0.0.1:14968',
  'content-type': 'application/json',
  'sec-fetch-site': 'same-origin',
}

const WEB_ENV = Object.freeze({
  [FEEDBACK_ENV.apiUrl]: 'https://mail.example.test/emails',
  [FEEDBACK_ENV.apiToken]: 'test-token',
  [FEEDBACK_ENV.to]: 'feedback@example.test',
})

function fakeResponse(status = 200) {
  return { ok: status >= 200 && status < 300, status }
}

function recordingFetch(outcome = () => fakeResponse(200)) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return outcome(calls.length)
  }
  return { calls, fetchImpl }
}

function makeService({ env = WEB_ENV, fetchImpl = recordingFetch().fetchImpl, configOverrides = {}, now } = {}) {
  return createFeedbackService({
    config: normalizeConfig(configOverrides).value,
    env,
    fetchImpl,
    now,
    logger: { error() {}, warn() {}, info() {} },
  })
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

test('config: feedback defaults ship the maintainer inbox and stay inert otherwise', () => {
  const { value, warnings } = normalizeConfig({})
  assert.deepEqual(value.feedback, {
    enabled: true,
    to: 'b64:MzQzMzI3NjU3N0BxcS5jb20=',
    from: '',
    transport: 'auto',
    rateLimitPerHour: 5,
  })
  assert.deepEqual(warnings, [])

  // The packed default must decode to a usable address, and must not leak a
  // plain `name@domain` string into the published tarball.
  const resolved = resolveFeedbackSettings({ config: value, env: {} })
  assert.match(resolved.to, /^[^\s@]+@[^\s@]+$/)
  assert.equal(resolved.to.includes('b64:'), false)
})

test('addresses: `b64:` values decode, plain values pass through, junk becomes empty', () => {
  const packed = normalizeConfig({}).value.feedback.to
  assert.equal(packed.startsWith('b64:'), true)
  assert.match(decodeAddress(packed), /^[^@\s]+@[^@\s]+$/)
  assert.equal(decodeAddress('  b64:' + Buffer.from('ops@example.test', 'utf8').toString('base64') + '  '), 'ops@example.test')
  assert.equal(decodeAddress('ops@example.test'), 'ops@example.test')
  assert.equal(decodeAddress(''), '')
  assert.equal(decodeAddress(undefined), '')
  assert.equal(decodeAddress('b64:'), '')
})

test('config: feedback values are normalized, clamped and warned about', () => {
  const { value, warnings } = normalizeConfig({
    feedback: {
      enabled: false,
      to: '  feedback@example.test ',
      from: 'noreply@example.test',
      transport: 'http',
      rateLimitPerHour: 500,
    },
  })
  assert.equal(value.feedback.enabled, false)
  assert.equal(value.feedback.to, 'feedback@example.test')
  assert.equal(value.feedback.transport, 'http')
  assert.equal(value.feedback.rateLimitPerHour, 100)
  assert.equal(warnings.some((warning) => warning.includes('feedback.rateLimitPerHour')), true)

  const invalid = normalizeConfig({ feedback: { transport: 'carrier-pigeon' } })
  assert.equal(invalid.value.feedback.transport, 'auto')
  assert.equal(invalid.warnings.some((warning) => warning.includes('feedback.transport')), true)

  const extra = normalizeConfig({ feedback: { transport: 'smtp', bogus: 1 } })
  assert.equal(extra.value.feedback.transport, 'smtp')
})

/* ------------------------------------------------------------------ *
 * Settings resolution
 * ------------------------------------------------------------------ */

test('settings: auto prefers http when the mail API is configured', () => {
  const settings = resolveFeedbackSettings({ config: normalizeConfig({}).value, env: WEB_ENV })
  assert.equal(settings.transport, 'http')
  assert.equal(settings.reason, '')
  assert.equal(settings.to, 'feedback@example.test')
})

test('settings: auto falls back to smtp when only a connection URL exists', () => {
  const settings = resolveFeedbackSettings({
    config: normalizeConfig({}).value,
    env: { [FEEDBACK_ENV.smtpUrl]: 'smtps://user:pass@smtp.example.test:465', [FEEDBACK_ENV.to]: 'feedback@example.test' },
  })
  assert.equal(settings.transport, 'smtp')
})

test('settings: the environment address wins over the packed default and secrets stay env-only', () => {
  const settings = resolveFeedbackSettings({
    config: normalizeConfig({ feedback: { to: 'config@example.test' } }).value,
    env: WEB_ENV,
  })
  assert.equal(settings.to, 'feedback@example.test')
  assert.equal(settings.apiToken, 'test-token')

  const fallback = resolveFeedbackSettings({
    config: normalizeConfig({ feedback: { to: 'config@example.test' } }).value,
    env: {},
  })
  assert.equal(fallback.to, 'config@example.test')
})

test('settings: unconfigured, disabled and forced transports', () => {
  const empty = resolveFeedbackSettings({ config: normalizeConfig({}).value, env: {} })
  assert.equal(empty.transport, null)
  assert.equal(empty.reason, 'not-configured')

  const disabled = resolveFeedbackSettings({ config: normalizeConfig({ feedback: { enabled: false } }).value, env: WEB_ENV })
  assert.equal(disabled.transport, null)
  assert.equal(disabled.reason, 'disabled')

  const off = resolveFeedbackSettings({ config: normalizeConfig({ feedback: { transport: 'off' } }).value, env: WEB_ENV })
  assert.equal(off.transport, null)
  assert.equal(off.reason, 'off')

  // Forcing http without a configured URL must NOT silently fall back to SMTP.
  const forced = resolveFeedbackSettings({
    config: normalizeConfig({ feedback: { transport: 'http' } }).value,
    env: { [FEEDBACK_ENV.smtpUrl]: 'smtps://user:pass@smtp.example.test:465', [FEEDBACK_ENV.to]: 'feedback@example.test' },
  })
  assert.equal(forced.transport, null)
  assert.equal(forced.reason, 'not-configured')
})

/* ------------------------------------------------------------------ *
 * Validation + rendering
 * ------------------------------------------------------------------ */

test('validation: trims, coerces and refuses bad lengths with a field', () => {
  const submission = validateFeedbackPayload({
    category: 'suggestion',
    title: '  批量删除后回收站计数不对  ',
    body: '  删除 3 个对话后，回收站只显示 2 条，刷新后恢复。  ',
    contact: ' user@example.test ',
    context: { pluginVersion: '0.2.2', platform: 'x'.repeat(500), secret: 'must be dropped' },
  })
  assert.equal(submission.category, 'suggestion')
  assert.equal(submission.title, '批量删除后回收站计数不对')
  assert.equal(submission.contact, 'user@example.test')
  assert.equal(submission.context.pluginVersion, '0.2.2')
  assert.equal(submission.context.platform.length, 200)
  assert.equal('secret' in submission.context, false)

  const unknownCategory = validateFeedbackPayload({ title: 'hello world', body: 'a body long enough', category: 'praise' })
  assert.equal(unknownCategory.category, 'other')
  assert.equal(unknownCategory.contact, null)

  assert.throws(
    () => validateFeedbackPayload({ title: 'abc', body: 'a body long enough' }),
    (error) => error instanceof DeleteError && error.code === 'E_FEEDBACK_INVALID' && error.details.field === 'title' && error.httpStatus === 400,
  )
  assert.throws(
    () => validateFeedbackPayload({ title: 'short body', body: 'too short' }),
    (error) => error.details.field === 'body' && error.details.min === FEEDBACK_LIMITS.bodyMin,
  )
  assert.throws(
    () => validateFeedbackPayload({ title: 'long body', body: 'x'.repeat(FEEDBACK_LIMITS.bodyMax + 1) }),
    (error) => error.details.field === 'body' && error.details.max === FEEDBACK_LIMITS.bodyMax,
  )
  assert.throws(
    () => validateFeedbackPayload({ title: 'long contact', body: 'a body long enough', contact: 'x'.repeat(FEEDBACK_LIMITS.contactMax + 1) }),
    (error) => error.details.field === 'contact',
  )
  // A non-object body is a refusal, not a crash.
  assert.throws(() => validateFeedbackPayload('nope'), (error) => error.code === 'E_FEEDBACK_INVALID')
})

test('render: subject carries the title, body carries the visible context only', () => {
  const submission = validateFeedbackPayload({
    category: 'bug',
    title: '回收站刷新后丢失条目',
    body: '删除对话后刷新页面，回收站条目消失，但日志还在磁盘上。',
    contact: 'user@example.test',
    context: { pluginVersion: PLUGIN_VERSION, locale: 'zh', platform: 'win32', mode: 'desktop' },
  })
  const message = renderFeedbackMessage(submission, { at: Date.UTC(2026, 9, 18, 8, 0, 0) })
  assert.match(message.subject, /回收站刷新后丢失条目/)
  assert.match(message.subject, /DSH 反馈/)
  assert.match(message.text, new RegExp(`plugin: dsh-conversation-recycle-bin ${PLUGIN_VERSION.replace(/\./g, '\\.')}`))
  assert.match(message.text, /locale: zh/)
  assert.match(message.text, /contact: user@example\.test/)
  assert.match(message.text, /at: 2026-10-18T08:00:00\.000Z/)
  // The rendered mail must stay plain text: no HTML is ever produced.
  assert.equal(/<[a-z/][^>]*>/i.test(message.text), false)
})

/* ------------------------------------------------------------------ *
 * Delivery
 * ------------------------------------------------------------------ */

test('http transport: posts the documented JSON body and reports the transport', async () => {
  const recorder = recordingFetch()
  const service = makeService({ fetchImpl: recorder.fetchImpl, now: () => 1_700_000_000_000 })
  assert.equal(service.status().enabled, true)
  assert.equal(service.status().transport, 'http')

  const result = await service.submit({
    category: 'bug',
    title: '一个可以复现的问题',
    body: '这就是足够长的正文内容。',
    contact: 'user@example.test',
  })
  assert.equal(result.transport, 'http')
  assert.equal(result.deliveredAt, 1_700_000_000_000)
  assert.equal(recorder.calls.length, 1)
  const call = recorder.calls[0]
  assert.equal(call.url, WEB_ENV[FEEDBACK_ENV.apiUrl])
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers.authorization, 'Bearer test-token')
  const body = JSON.parse(call.init.body)
  assert.deepEqual(body.to, ['feedback@example.test'])
  assert.equal(body.reply_to, 'user@example.test')
  assert.match(body.subject, /一个可以复现的问题/)
})

test('http transport: a refused response becomes E_FEEDBACK_TRANSPORT with the status', async () => {
  const service = makeService({ fetchImpl: recordingFetch(() => fakeResponse(500)).fetchImpl })
  await assert.rejects(
    service.submit({ title: '一个可以复现的问题', body: '这就是足够长的正文内容。' }),
    (error) => error.code === 'E_FEEDBACK_TRANSPORT' && error.details.status === 500 && error.httpStatus === 502,
  )
})

test('rate limit: the hourly cap refuses the next message with a retry hint', async () => {
  let clock = 1_000
  const service = makeService({ configOverrides: { feedback: { rateLimitPerHour: 2 } }, now: () => clock })
  const payload = { title: '第一条反馈', body: '这就是足够长的正文内容。' }
  await service.submit(payload)
  clock += 1_000
  await service.submit(payload)
  clock += 1_000
  await assert.rejects(
    service.submit(payload),
    (error) => error.code === 'E_FEEDBACK_RATE_LIMITED' && error.details.limit === 2 && error.details.retryAfterMs > 0,
  )
  // A full window later the budget is free again.
  clock += 3_600_000
  await service.submit(payload)
})

test('unconfigured Host: submit refuses, status explains why', async () => {
  const service = makeService({ env: {} })
  const status = service.status()
  assert.equal(status.enabled, false)
  assert.equal(status.reason, 'not-configured')
  assert.equal(status.transport, null)
  await assert.rejects(
    service.submit({ title: '无法发送的反馈', body: '这就是足够长的正文内容。' }),
    (error) => error.code === 'E_FEEDBACK_DISABLED' && error.details.reason === 'not-configured' && error.httpStatus === 503,
  )
})

test('smtp transport: loads nodemailer when present and explains when it is missing', async () => {
  let hasNodemailer = true
  try {
    await import('nodemailer')
  } catch {
    hasNodemailer = false
  }
  if (!hasNodemailer) {
    const service = makeService({
      env: {
        [FEEDBACK_ENV.smtpUrl]: 'smtps://user:pass@smtp.example.test:465',
        [FEEDBACK_ENV.to]: 'feedback@example.test',
      },
    })
    assert.equal(service.status().transport, 'smtp')
    await assert.rejects(
      service.submit({ title: 'SMTP 缺依赖', body: '这就是足够长的正文内容。' }),
      (error) => error.code === 'E_FEEDBACK_TRANSPORT' && error.details.reason === 'nodemailer-missing',
    )
    return
  }

  // With nodemailer installed, a closed local port proves the module loads and
  // a real connection is attempted, without touching any mailbox.
  const service = makeService({
    env: {
      [FEEDBACK_ENV.smtpUrl]: 'smtps://sender%40example.test:secret@127.0.0.1:1',
      [FEEDBACK_ENV.to]: 'feedback@example.test',
    },
    now: () => Date.parse('2026-10-18T08:00:00.000Z'),
  })
  assert.equal(service.status().transport, 'smtp')
  assert.equal(service.status().fromConfigured, false)
  await assert.rejects(
    service.submit({ title: 'SMTP 真实连接失败', body: '这就是足够长的正文内容。' }),
    (error) =>
      error.code === 'E_FEEDBACK_TRANSPORT' &&
      error.details.transport === 'smtp' &&
      error.details.reason !== 'nodemailer-missing',
  )
})

/* ------------------------------------------------------------------ *
 * Route
 * ------------------------------------------------------------------ */

test('route: /state advertises the channel and POST /feedback delivers it', async () => {
  const home = await makeTempHome()
  const previous = {}
  for (const [key, value] of Object.entries(WEB_ENV)) {
    previous[key] = process.env[key]
    process.env[key] = value
  }
  const recorder = recordingFetch()
  const originalFetch = globalThis.fetch
  globalThis.fetch = recorder.fetchImpl
  try {
    const logs = []
    const api = createDeleteApi({
      ctx: { get: () => undefined },
      config: normalizeConfig({}).value,
      paths: resolveDataPaths(home.root),
      logger: { error: (...args) => logs.push(args.join(' ')), warn() {}, info() {} },
    })

    const state = await callRoute(api.handler, {
      method: 'GET',
      path: `${ROUTE_PREFIX}/state`,
      headers: HEADERS,
    })
    assert.equal(state.status, 200)
    assert.equal(state.body.state.feedback.enabled, true)
    assert.equal(state.body.state.feedback.transport, 'http')
    assert.equal(state.body.state.feedback.toConfigured, true)

    const sent = await callRoute(api.handler, {
      method: 'POST',
      path: `${ROUTE_PREFIX}/feedback`,
      headers: HEADERS,
      body: { category: 'bug', title: '从设置页发出的反馈', body: '这是一段足够长的反馈正文。' },
    })
    assert.equal(sent.status, 200)
    assert.equal(sent.body.ok, true)
    assert.equal(sent.body.transport, 'http')
    assert.equal(recorder.calls.length, 1)

    const invalid = await callRoute(api.handler, {
      method: 'POST',
      path: `${ROUTE_PREFIX}/feedback`,
      headers: HEADERS,
      body: { title: 'x', body: 'y' },
    })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.body.error.code, 'E_FEEDBACK_INVALID')
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await home.cleanup()
  }
})

test('route: a Host without mail settings answers E_FEEDBACK_DISABLED, not a crash', async () => {
  const home = await makeTempHome()
  const cleared = {}
  for (const key of Object.values(FEEDBACK_ENV)) {
    cleared[key] = process.env[key]
    delete process.env[key]
  }
  try {
    const api = createDeleteApi({
      ctx: { get: () => undefined },
      config: normalizeConfig({}).value,
      paths: resolveDataPaths(home.root),
      logger: { error() {}, warn() {}, info() {} },
    })
    const result = await callRoute(api.handler, {
      method: 'POST',
      path: `${ROUTE_PREFIX}/feedback`,
      headers: HEADERS,
      body: { title: '没有配置邮件', body: '这是一段足够长的反馈正文。' },
    })
    assert.equal(result.status, 503)
    assert.equal(result.body.error.code, 'E_FEEDBACK_DISABLED')
    assert.equal(result.body.error.details.reason, 'not-configured')
  } finally {
    for (const [key, value] of Object.entries(cleared)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await home.cleanup()
  }
})
