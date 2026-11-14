#!/usr/bin/env node
/**
 * Runtime contract smoke test against a STARTED DSH host.
 *
 * The suites in `test/` run against a fake Host, so they cannot answer the only
 * question that matters after an upgrade: was this plugin actually mounted? The
 * failure mode they miss is precisely the one observed on 0.2.2-alpha.3 — the
 * Host logged "API registered", the boot graph contained no row for the plugin,
 * and every route answered 404 with no error anywhere.
 *
 * Usage:
 *   node scripts/verify-host-contract.mjs [baseUrl] [auth option]
 *
 *   baseUrl defaults to $DSH_WEB_URL, then http://127.0.0.1:3082.
 *   Auth options, in precedence order:
 *     --cookie='a=b; c=d'   a ready cookie header (from the browser's network tab)
 *     --cookie-file=<path>  first usable line of a file, same format
 *     --launch=<url>        the Host launch URL the desktop shell reports;
 *                           the 303 it answers with carries the session cookie
 *                           the shell would otherwise inject itself
 *     --token=<token>       session token from a `dsh web` URL
 *   Environment equivalents: $DSH_COOKIE, $DSH_COOKIE_FILE, $DSH_LAUNCH_URL,
 *   $DSH_TOKEN.
 *
 *   The desktop shell does not hand out a token: it exchanges the Host launch
 *   URL for an authority-bound cookie inside its own process. `--launch` is the
 *   supported way to prove mount state on that shell instead of skipping the
 *   only check that matters after an upgrade.
 *
 * Exit code: 0 = plugin mounted and answering, 1 = not mounted, 2 = probe error.
 */
const args = process.argv.slice(2)
// `dsh web` prints its own URL with a fresh port (11685 on this machine), and a
// probe that keeps assuming 3082 reports "not mounted" for a perfectly healthy
// host. Prefer the explicit argument, then the environment, then the old
// default so existing instructions keep working.
let base = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3082'
let token = process.env.DSH_TOKEN ?? ''
let explicitCookie = process.env.DSH_COOKIE ?? ''
let cookieFile = process.env.DSH_COOKIE_FILE ?? ''
let launchUrl = process.env.DSH_LAUNCH_URL ?? ''
for (const arg of args) {
  if (arg.startsWith('--token=')) token = arg.slice('--token='.length)
  else if (arg.startsWith('--cookie=')) explicitCookie = arg.slice('--cookie='.length)
  else if (arg.startsWith('--cookie-file=')) cookieFile = arg.slice('--cookie-file='.length)
  else if (arg.startsWith('--launch=')) launchUrl = arg.slice('--launch='.length)
  else if (/^https?:\/\//.test(arg)) base = arg
}
base = base.replace(/\/+$/, '')

const cookies = new Map()
function rememberCookies(response) {
  for (const value of response.headers.getSetCookie?.() ?? []) {
    const [pair] = value.split(';')
    const index = pair.indexOf('=')
    if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim())
  }
}
function cookieHeader() {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
}

/**
 * Install the session credential before the first request.
 *
 * The desktop shell deliberately mints no token: `authenticateWebHost()` in the
 * shipped `lib/main.js` fetches the Host launch URL, reads the `set-cookie` off
 * its 303, and injects that cookie into every forwarded request. A probe that
 * only understands `--token` therefore reports 401 against a perfectly healthy
 * desktop Host, and the operator (correctly) reads 401 as "auth problem" while
 * never learning whether the plugin is mounted — the one question this probe
 * exists to answer.
 * @returns {Promise<string|null>} reason text when no credential could be installed
 */
async function acquireCredentials() {
  const absorb = (raw) => {
    for (const segment of String(raw).split(';')) {
      const index = segment.indexOf('=')
      if (index > 0) cookies.set(segment.slice(0, index).trim(), segment.slice(index + 1).trim())
    }
  }
  if (explicitCookie !== '') {
    absorb(explicitCookie)
    return null
  }
  if (cookieFile !== '') {
    const { readFile } = await import('node:fs/promises')
    let text
    try {
      text = await readFile(cookieFile, 'utf8')
    } catch (error) {
      return `--cookie-file ${cookieFile} is unreadable (${error?.code ?? error?.message ?? 'unknown'})`
    }
    const line = text.split(/\r?\n/)
      .map((value) => value.trim())
      .find((value) => value.includes('=') && !value.startsWith('#'))
    if (line === undefined) return `--cookie-file ${cookieFile} holds no cookie line`
    absorb(line)
    return null
  }
  if (launchUrl !== '') {
    let response
    try {
      response = await fetch(launchUrl, { redirect: 'manual' })
    } catch (error) {
      return `--launch URL is unreachable: ${error?.message ?? error}`
    }
    rememberCookies(response)
    await response.body?.cancel()
    if (cookies.size === 0) {
      return `--launch answered ${response.status} without a set-cookie header (is it the Host launch URL?)`
    }
    return null
  }
  return null
}

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  const credentialProblem = await acquireCredentials()
  if (credentialProblem !== null) {
    console.log(`FAIL  credentials — ${credentialProblem}`)
    return 2
  }
  // 1. The page hands out the session cookie (and embeds the boot graph).
  const pageUrl = `${base}/${token === '' ? '' : `?token=${encodeURIComponent(token)}`}`
  const page = await fetch(pageUrl, { redirect: 'follow', headers: cookieHeader() === '' ? {} : { cookie: cookieHeader() } })
  rememberCookies(page)
  const html = await page.text()
  // A 401 is a probe problem, not an unmounted plugin: without a session token
  // every route refuses, and reporting that as "not mounted" would waste the
  // one check that matters after a restart.
  if (page.status === 401) {
    console.log('FAIL  GET / — 401; this probe has no usable session. Re-run with one of:')
    console.log('        --launch=<launch URL the desktop shell reports>   (desktop)')
    console.log('        --cookie="dsh-auth-…=…"                          (browser network tab)')
    console.log('        --cookie-file=<path>                             (exported cookie line)')
    console.log('        --token=<token>                                  (`dsh web` URL)')
    return 2
  }
  record('GET /', page.status === 200, `status ${page.status}, ${html.length} bytes`)

  // 2. The plugin's client row must appear in the inline boot data. A mounted
  //    plugin always contributes its row; the 21:26 incident left this at 0.
  //    NOTE: the package NAME alone is not proof — it is also the dependency
  //    key in the profile's package.json, so it leaks into boot data that lists
  //    installed bundles. Step 5 below is the assertion that actually decides.
  const rowPresent = html.includes('dsh-conversation-recycle-bin')
  record('package name present in boot data', rowPresent, rowPresent ? 'found' : 'string absent from HTML')

  // 3. A control prefix route proves the prefix mechanism itself works.
  const control = await fetch(`${base}/dsh-memes-api`, {
    headers: cookieHeader() === '' ? {} : { cookie: cookieHeader() },
  })
  record('control route /dsh-memes-api answers', control.status !== 404, `status ${control.status}`)

  // 4. The plugin's own API must answer JSON, not the SPA 404 fallback.
  const state = await fetch(`${base}/conversation-recycle-bin/api/state`, {
    headers: cookieHeader() === '' ? {} : { cookie: cookieHeader() },
  })
  const body = await state.text()
  if (state.status === 401) {
    console.log(`FAIL  GET /conversation-recycle-bin/api/state — 401; the probe lost its session (re-run with --launch=<url>, --cookie=<header>, --cookie-file=<path> or --token=<token>)`)
    return 2
  }
  let parsed = null
  try {
    parsed = JSON.parse(body)
  } catch {
    parsed = null
  }
  record(
    'GET /conversation-recycle-bin/api/state',
    state.status === 200 && parsed !== null && typeof parsed === 'object',
    `status ${state.status}, ${body.length} bytes${parsed === null ? ', not JSON' : ''}`,
  )

  // 5. Mounted-for-real: the payload must carry the plugin's own shape. A 200
  //    with `{}` (a proxy, a stale service worker, another plugin's catch-all
  //    prefix) used to pass the check above.
  const payload = parsed?.state
  const shaped = payload !== null && typeof payload === 'object'
    && typeof payload.version === 'string'
    && typeof payload.limits === 'object'
    && payload.limits !== null
  record(
    'state payload carries the plugin contract (version + limits)',
    shaped,
    shaped ? `v${payload.version}` : 'missing state.version / state.limits',
  )

  // 6. Contract drift that costs the UI its titles is reported here instead of
  //    being discovered by a user staring at blank rows.
  const diagnostics = payload?.diagnostics
  if (diagnostics !== undefined && typeof diagnostics === 'object') {
    const foreign = Number(diagnostics.projection?.foreignVersion ?? 0)
    const malformed = Number(diagnostics.projection?.malformed ?? 0)
    record(
      'projection checkpoints are a format this build reads',
      foreign === 0 && malformed === 0,
      `foreignVersion ${foreign}, malformed ${malformed}, legacyTitles ${String(diagnostics.legacyTitles)}`,
    )
  } else {
    record('state reports projection diagnostics', false, 'state.diagnostics missing (older plugin build?)')
  }

  const failed = results.filter((item) => !item.ok)
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed. If the Host was just restarted, confirm the`)
    console.log('package directory exists BEFORE the restart and re-run this probe.')
    return 1
  }
  console.log('\nAll runtime contract checks passed.')
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('probe error:', error?.message ?? error)
    process.exit(2)
  })
