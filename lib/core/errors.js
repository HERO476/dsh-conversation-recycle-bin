/**
 * Stable error contract shared by the Host route, the Client half and the tests.
 *
 * Every refusal is a machine-readable `code` plus a human `message`; the route
 * maps `code` to an HTTP status once, so the UI can branch on the code without
 * parsing prose. Codes are stable API: add new ones, never rename existing ones.
 */
import { redactDetails } from './redact.js'

/** HTTP status per error code. Keep this table exhaustive for every thrown code. */
export const ERROR_STATUS = Object.freeze({
  E_DISABLED: 503,
  E_FORBIDDEN_ORIGIN: 403,
  E_FORBIDDEN_HOST: 403,
  E_UNAUTHORIZED: 401,
  E_BAD_REQUEST: 400,
  E_NOT_FOUND: 404,
  E_POLICY_PROTECTED: 403,
  E_POLICY_ORPHAN: 403,
  E_POLICY_SUBAGENT: 403,
  E_POLICY_ROOT: 403,
  E_POLICY_LIVE: 409,
  E_POLICY_FOREIGN_WRITER: 409,
  E_BATCH_TOO_LARGE: 400,
  E_RATE_LIMITED: 429,
  E_CONFIRM_REQUIRED: 428,
  E_CONFIRM_INVALID: 409,
  E_CONFIRM_EXPIRED: 410,
  E_CONFIRM_PHRASE: 400,
  E_TRANSACTION_FAILED: 500,
  E_TRASH_NOT_FOUND: 404,
  E_TRASH_CONFLICT: 409,
  E_MEMORY_FAILED: 500,
  E_LOCK_BUSY: 409,
  // Feedback channel: its own codes, so the Client can distinguish "this Host
  // has no mail transport" from "the transport refused the message".
  E_FEEDBACK_DISABLED: 503,
  E_FEEDBACK_INVALID: 400,
  E_FEEDBACK_RATE_LIMITED: 429,
  E_FEEDBACK_TRANSPORT: 502,
  E_INTERNAL: 500,
})

/** An expected, user-facing refusal. `details` is lossless JSON by contract. */
export class DeleteError extends Error {
  /**
   * @param {string} code stable machine code from `ERROR_STATUS`
   * @param {string} message readable message shown by the Client
   * @param {Record<string, unknown>} [details] structured context (ids, counts)
   * @param {{ cause?: unknown, httpStatus?: number }} [options]
   */
  constructor(code, message, details = {}, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DeleteError'
    this.code = code
    this.details = details
    this.httpStatus = options.httpStatus ?? ERROR_STATUS[code] ?? 500
    this.isDeleteError = true
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details }
  }
}

/**
 * Coerce any thrown value into a `DeleteError`.
 *
 * An unexpected exception is deliberately NOT leaked to the browser: the
 * message is replaced by a neutral one and the original is kept as `cause`
 * (available to the Host log/audit), because filesystem paths and stack traces
 * must not cross the HTTP boundary.
 */
export function asDeleteError(error, fallbackCode = 'E_INTERNAL') {
  if (error instanceof DeleteError) return error
  return new DeleteError(fallbackCode, 'The operation failed unexpectedly.', {
    cause: error instanceof Error ? error.message : String(error),
  }, { cause: error })
}

/** Wire shape for a failed call. Host paths are redacted before crossing HTTP. */
export function toWireError(error) {
  const normalized = asDeleteError(error)
  return { ok: false, error: redactDetails(normalized.toJSON()) }
}

/** Wire shape for a successful call. */
export function ok(value) {
  return { ok: true, ...value }
}
