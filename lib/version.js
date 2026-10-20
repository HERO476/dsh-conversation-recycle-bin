/**
 * Single source of truth for the Host-reported plugin version.
 *
 * `package.json` stays authoritative for the package itself; this module is
 * asserted against it by `test/manifest.test.mjs` so the two can never drift
 * (they did: the constant stayed at 0.1.0 while the package reached 0.1.4).
 */
export const PLUGIN_VERSION = '0.3.4'
