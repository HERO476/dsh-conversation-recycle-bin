/**
 * Shared identifier shapes used by the HTTP layer and the session gateway.
 * Kept in one place so the route and the preflight cannot drift apart.
 */

/** DSH session ids: letters, digits and `.`, `_`, `-`; 6–80 characters. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{6,80}$/
