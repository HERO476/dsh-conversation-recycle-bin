/**
 * Email feedback channel: the Host half of the Settings page "反馈" button.
 *
 * Why a Host route instead of the browser talking to a mail provider directly:
 * the provider credential must never reach the page, and a browser cannot open
 * an SMTP connection at all. The Client therefore only sends the form fields;
 * this module builds the message and delivers it from the Host process.
 *
 * Transports (both are optional at runtime — the plugin still declares no
 * dependency):
 *   - `http`: POST a JSON body to a Resend-compatible mail API
 *     (`{from,to,subject,text,reply_to}`). Works with api.resend.com and with
 *     any other provider through a small relay that accepts this shape.
 *   - `smtp`: `nodemailer`'s connection-URL form. `nodemailer` is NOT a
 *     dependency of this package: the operator installs it in the DSH profile
 *     (`pnpm add nodemailer`), and this module imports it lazily. Without it the
 *     route answers E_FEEDBACK_TRANSPORT with reason `nodemailer-missing`.
 *
 * Configuration is split on purpose:
 *   - non-secret settings (`feedback.enabled`, `.to`, `.from`, `.transport`,
 *     `.rateLimitPerHour`) live in the row config, so a profile can be shared;
 *   - addresses and credentials may instead come from the environment
 *     (DSH_CRB_FEEDBACK_TO / _FROM, DSH_CRB_MAIL_API_URL / _TOKEN /
 *     _AUTH_HEADER, DSH_CRB_SMTP_URL), which keeps secrets out of a config file
 *     that might be committed. Nothing here is hard-coded.
 *
 * Privacy: the delivered message contains only what the user typed plus the
 * context fields the dialog displays to them. Logs never contain the title,
 * body, visitor address or mail credentials.
 */
import { DeleteError } from '../core/errors.js'
import { PLUGIN_VERSION } from '../version.js'

/** Transport names accepted by `config.feedback.transport`. */
export const FEEDBACK_TRANSPORTS = Object.freeze(['auto', 'smtp', 'http', 'off'])

/** Environment variables this module reads. Documented in README. */
export const FEEDBACK_ENV = Object.freeze({
  to: 'DSH_CRB_FEEDBACK_TO',
  from: 'DSH_CRB_FEEDBACK_FROM',
  apiUrl: 'DSH_CRB_MAIL_API_URL',
  apiToken: 'DSH_CRB_MAIL_API_TOKEN',
  authHeader: 'DSH_CRB_MAIL_API_AUTH_HEADER',
  smtpUrl: 'DSH_CRB_SMTP_URL',
})

/** Categories the dialog offers; anything else is folded into `other`. */
const CATEGORIES = new Set(['bug', 'suggestion', 'other'])

const CATEGORY_LABELS = Object.freeze({ bug: '问题 / bug', suggestion: '建议 / suggestion', other: '其他 / other' })

/**
 * Field limits. They are duplicated (not shared) in `client.js` on purpose: the
 * Host is authoritative and re-validates everything, while the Client copy only
 * exists to disable the submit button early.
 */
export const FEEDBACK_LIMITS = Object.freeze({
  titleMin: 4,
  titleMax: 120,
  bodyMin: 10,
  bodyMax: 4_000,
  emailMax: 200,
})

/** Context keys the Client may attach; everything else is dropped. */
const CONTEXT_KEYS = Object.freeze(['pluginVersion', 'dshVersion', 'platform', 'locale', 'url', 'mode'])
const CONTEXT_VALUE_MAX = 200

const DELIVERY_TIMEOUT_MS = 15_000

function envString(env, key) {
  const value = env?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Addresses shipped in the package are stored as `b64:<base64>` instead of
 * plain text: a published tarball is public forever, and a bare `name@domain`
 * string is what address harvesters grep for. This is obfuscation, NOT
 * encryption — anyone holding the package can decode it, just not with a
 * trivial regex. Plain addresses (env vars, user overrides) also pass through.
 */
const ENCODED_ADDRESS_PREFIX = 'b64:'

export function decodeAddress(raw) {
  const value = String(raw ?? '').trim()
  if (!value.startsWith(ENCODED_ADDRESS_PREFIX)) return value
  try {
    return Buffer.from(value.slice(ENCODED_ADDRESS_PREFIX.length), 'base64').toString('utf8').trim()
  } catch {
    return ''
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Collapse every whitespace run so a header-like field cannot inject lines. */
function singleLine(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/**
 * The visitor's own address. Deliberately loose (`a@b.c` shape only): the Host
 * is not the authority on what a given provider accepts, and a strict RFC 5322
 * check would reject addresses that still deliver. Anything with CR/LF was
 * already flattened by `singleLine`, so a header cannot be injected here.
 */
const EMAIL_PATTERN = /^[^\s@,;:<>()[\]\\]+@[^\s@,;:<>()[\]\\]+\.[^\s@,;:<>()[\]\\]{2,}$/

function looksLikeAddress(value) {
  return EMAIL_PATTERN.test(value)
}

/**
 * Resolve the effective settings. The environment wins over config for the two
 * addresses (an operator can redirect a deployed Host without editing the
 * profile; the packaged default only names the maintainer's inbox) and is the
 * ONLY source for credentials.
 *
 * @param {object} input
 * @param {{feedback?: {enabled?: boolean, to?: string, from?: string, transport?: string, visitorAsFrom?: boolean}}} [input.config]
 * @param {Record<string, string | undefined>} [input.env]
 */
export function resolveFeedbackSettings({ config, env = process.env } = {}) {
  const feedback = isPlainObject(config?.feedback) ? config.feedback : {}
  const configured = FEEDBACK_TRANSPORTS.includes(feedback.transport) ? feedback.transport : 'auto'
  const to = decodeAddress(envString(env, FEEDBACK_ENV.to) || String(feedback.to ?? '').trim())
  const from = decodeAddress(envString(env, FEEDBACK_ENV.from) || String(feedback.from ?? '').trim())
  const apiUrl = envString(env, FEEDBACK_ENV.apiUrl)
  const apiToken = envString(env, FEEDBACK_ENV.apiToken)
  const authHeader = envString(env, FEEDBACK_ENV.authHeader) || 'Authorization'
  const smtpUrl = envString(env, FEEDBACK_ENV.smtpUrl)
  const visitorAsFrom = feedback.visitorAsFrom === true

  const httpReady = apiUrl !== '' && to !== ''
  const smtpReady = smtpUrl !== '' && to !== ''

  let transport = null
  let reason = ''
  if (feedback.enabled === false) {
    reason = 'disabled'
  } else if (configured === 'off') {
    reason = 'off'
  } else if (configured === 'http') {
    if (httpReady) transport = 'http'
    else reason = 'not-configured'
  } else if (configured === 'smtp') {
    if (smtpReady) transport = 'smtp'
    else reason = 'not-configured'
  } else if (httpReady) {
    transport = 'http'
  } else if (smtpReady) {
    transport = 'smtp'
  } else {
    reason = 'not-configured'
  }

  return { configured, transport, reason, to, from, apiUrl, apiToken, authHeader, smtpUrl, visitorAsFrom }
}

/**
 * Resolve the SMTP `From`. Providers (QQ, 163, most hosted SMTP) reject a
 * message whose `From` differs from the authenticated account, so when no
 * explicit `from` is configured the connection URL's username is reused —
 * one `DSH_CRB_SMTP_URL` is then enough to send. The username must be
 * percent-encoded in the URL (`3433276577%40qq.com`).
 */
function smtpSender(settings) {
  if (settings.from !== '') return settings.from
  try {
    const user = new URL(settings.smtpUrl).username
    return user === '' ? undefined : decodeURIComponent(user)
  } catch {
    return undefined
  }
}

/**
 * The `From` an outgoing message carries.
 *
 * Providers differ: hosted SMTP (QQ, 163, Gmail) refuses a message whose `From`
 * is not the authenticated account, so by default the visitor's address only
 * travels in `Reply-To` while the mail is sent from the operator's account.
 * `feedback.visitorAsFrom = true` puts the visitor's address into `From` too —
 * right for relays that allow it, rejected by the strict providers above.
 */
export function resolveSender(settings, submission) {
  if (settings?.visitorAsFrom === true && submission?.email) return submission.email
  return smtpSender(settings)
}

function normalizeContext(raw) {
  if (!isPlainObject(raw)) return {}
  const context = {}
  for (const key of CONTEXT_KEYS) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    const text = singleLine(value)
    if (text === '') continue
    context[key] = text.slice(0, CONTEXT_VALUE_MAX)
  }
  return context
}

/**
 * Validate one submission. Throws E_FEEDBACK_INVALID (400) with a `field` in
 * `details` so the Client can highlight the offending input.
 *
 * @param {unknown} raw request body
 * @returns {{category: string, title: string, body: string, email: string | null, context: Record<string, string>}}
 */
export function validateFeedbackPayload(raw) {
  const source = isPlainObject(raw) ? raw : {}
  const category = CATEGORIES.has(source.category) ? source.category : 'other'
  const title = singleLine(source.title)
  const body = typeof source.body === 'string' ? source.body.replace(/\r\n/g, '\n').trim() : ''
  const email = singleLine(source.email)

  if (title.length < FEEDBACK_LIMITS.titleMin) {
    throw new DeleteError('E_FEEDBACK_INVALID', 'A feedback title needs at least 4 characters.', {
      field: 'title', min: FEEDBACK_LIMITS.titleMin,
    })
  }
  if (title.length > FEEDBACK_LIMITS.titleMax) {
    throw new DeleteError('E_FEEDBACK_INVALID', 'The feedback title is too long.', {
      field: 'title', max: FEEDBACK_LIMITS.titleMax,
    })
  }
  if (body.length < FEEDBACK_LIMITS.bodyMin) {
    throw new DeleteError('E_FEEDBACK_INVALID', 'A feedback message needs at least 10 characters.', {
      field: 'body', min: FEEDBACK_LIMITS.bodyMin,
    })
  }
  if (body.length > FEEDBACK_LIMITS.bodyMax) {
    throw new DeleteError('E_FEEDBACK_INVALID', 'The feedback message is too long.', {
      field: 'body', max: FEEDBACK_LIMITS.bodyMax,
    })
  }
  if (email !== '' && !looksLikeAddress(email)) {
    throw new DeleteError('E_FEEDBACK_INVALID', 'The sender address is not an email address.', {
      field: 'email',
    })
  }
  if (email.length > FEEDBACK_LIMITS.emailMax) {
    throw new DeleteError('E_FEEDBACK_INVALID', 'The sender address is too long.', {
      field: 'email', max: FEEDBACK_LIMITS.emailMax,
    })
  }

  return {
    category,
    title,
    body,
    email: email === '' ? null : email,
    context: normalizeContext(source.context),
  }
}

/**
 * Render the plain-text mail. Deliberately plain text: one less injection
 * surface, and the context block stays copy-pasteable for the maintainer.
 */
export function renderFeedbackMessage(submission, { at = Date.now() } = {}) {
  const label = CATEGORY_LABELS[submission.category] ?? CATEGORY_LABELS.other
  const subject = `[DSH 反馈 · ${label}] ${singleLine(submission.title)}`.slice(0, 180)
  const context = isPlainObject(submission.context) ? submission.context : {}
  const contextLines = CONTEXT_KEYS
    .filter((key) => typeof context[key] === 'string' && context[key] !== '')
    .map((key) => `  ${key}: ${context[key]}`)
  const lines = [
    `类型 / Category: ${label} (${submission.category})`,
    `标题 / Title: ${singleLine(submission.title)}`,
    '',
    '正文 / Message:',
    submission.body,
    '',
    '---- 自动附带 / attached automatically ----',
    `  plugin: dsh-conversation-recycle-bin ${PLUGIN_VERSION}`,
    ...contextLines,
    `  from / 发件人: ${submission.email ?? '(anonymous)'}`,
    `  reply-to: ${submission.email ?? '(none)'}`,
    `  at: ${new Date(at).toISOString()}`,
  ]
  return { subject, text: lines.join('\n') }
}

/**
 * @param {object} input
 * @param {{feedback?: object}} input.config normalized row config
 * @param {Record<string, string | undefined>} [input.env]
 * @param {() => number} [input.now]
 * @param {Pick<Console, 'error'|'warn'|'info'>} [input.logger]
 * @param {typeof fetch} [input.fetchImpl] injectable for tests
 */
export function createFeedbackService({ config, env = process.env, now = Date.now, logger = console, fetchImpl = globalThis.fetch } = {}) {
  const settings = resolveFeedbackSettings({ config, env })
  const rateLimit = Math.max(1, Math.min(100, Number(config?.feedback?.rateLimitPerHour) || 5))
  const windowMs = 3_600_000
  const deliveries = []

  function status() {
    return {
      enabled: settings.transport !== null,
      transport: settings.transport,
      reason: settings.transport === null ? settings.reason : '',
      configured: settings.configured,
      toConfigured: settings.to !== '',
      fromConfigured: settings.from !== '',
      visitorAsFrom: settings.visitorAsFrom,
      rateLimitPerHour: rateLimit,
    }
  }

  function takeSlot() {
    while (deliveries.length > 0 && now() - deliveries[0] >= windowMs) deliveries.shift()
    if (deliveries.length >= rateLimit) {
      throw new DeleteError('E_FEEDBACK_RATE_LIMITED', 'Too many feedback messages have been sent from this Host.', {
        limit: rateLimit,
        retryAfterMs: Math.max(0, windowMs - (now() - deliveries[0])),
      })
    }
    deliveries.push(now())
  }

  async function deliverHttp(message, submission) {
    if (typeof fetchImpl !== 'function') {
      throw new DeleteError('E_FEEDBACK_TRANSPORT', 'This Host runtime provides no fetch() to deliver feedback.', { transport: 'http' })
    }
    const headers = { 'content-type': 'application/json' }
    if (settings.apiToken !== '') headers[settings.authHeader.toLowerCase()] = `Bearer ${settings.apiToken}`
    const body = {
      from: settings.from === '' ? undefined : settings.from,
      to: [settings.to],
      subject: message.subject,
      text: message.text,
      reply_to: submission.email ?? undefined,
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)
    try {
      const response = await fetchImpl(settings.apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (response?.ok !== true) {
        throw new DeleteError('E_FEEDBACK_TRANSPORT', 'The mail API refused the message.', {
          transport: 'http',
          status: typeof response?.status === 'number' ? response.status : 0,
        })
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async function deliverSmtp(message, submission) {
    let nodemailer
    try {
      nodemailer = await import('nodemailer')
    } catch (error) {
      throw new DeleteError(
        'E_FEEDBACK_TRANSPORT',
        'SMTP delivery needs the optional "nodemailer" package installed in the Host profile.',
        { transport: 'smtp', reason: 'nodemailer-missing' },
        { cause: error },
      )
    }
    const createTransport = nodemailer?.default?.createTransport ?? nodemailer?.createTransport
    if (typeof createTransport !== 'function') {
      throw new DeleteError('E_FEEDBACK_TRANSPORT', 'The installed nodemailer build exposes no createTransport().', {
        transport: 'smtp', reason: 'nodemailer-incompatible',
      })
    }
    const transporter = createTransport(settings.smtpUrl)
    try {
      await transporter.sendMail({
        from: resolveSender(settings, submission),
        to: settings.to,
        subject: message.subject,
        text: message.text,
        replyTo: submission.email ?? undefined,
      })
    } finally {
      try {
        transporter?.close?.()
      } catch {
        // close() is best-effort; a failure here must not mask the send result.
      }
    }
  }

  /**
   * Validate, rate-limit and deliver one feedback message.
   * @param {unknown} raw request body
   */
  async function submit(raw) {
    const submission = validateFeedbackPayload(raw)
    if (settings.transport === null) {
      throw new DeleteError('E_FEEDBACK_DISABLED', 'The feedback channel is not configured on this Host.', {
        reason: settings.reason,
      })
    }
    takeSlot()
    const message = renderFeedbackMessage(submission, { at: now() })
    const startedAt = now()
    try {
      if (settings.transport === 'http') await deliverHttp(message, submission)
      else await deliverSmtp(message, submission)
    } catch (error) {
      const normalized = error instanceof DeleteError
        ? error
        : new DeleteError('E_FEEDBACK_TRANSPORT', 'The feedback message could not be delivered.', {
          transport: settings.transport,
        }, { cause: error })
      // Only the code and transport: the message body and the visitor address
      // are user data and must not be copied into the Host log.
      logger.error?.(`[conversation-recycle-bin] feedback delivery failed (${settings.transport}): ${normalized.code} ${normalized.message}`)
      throw normalized
    }
    logger.info?.(`[conversation-recycle-bin] feedback delivered (${settings.transport}, ${submission.category}) in ${now() - startedAt}ms`)
    return { transport: settings.transport, deliveredAt: now() }
  }

  return {
    status,
    submit,
    settings,
    __test: { takeSlot, windowMs },
  }
}
