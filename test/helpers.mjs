/**
 * Test helpers: an in-memory Host surface (workspace registry, session
 * persistence/controller, live sessions) plus a temp DSH home on disk, and a
 * minimal HTTP request/response pair for exercising the real route handler.
 *
 * The fakes implement ONLY the documented slice the plugin uses, and their
 * mutation methods update the same observable state the assertions read, so a
 * test failure points at the plugin rather than at an over-permissive mock.
 */
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function makeTempHome(prefix = 'dsh-delete-conversation-test-') {
  const root = await mkdtemp(join(process.cwd(), 'test', '.tmp', prefix))
  await mkdir(join(root, 'sessions'), { recursive: true })
  await mkdir(join(root, 'storages'), { recursive: true })
  // Windows keeps directory handles briefly after a read/rename; a bare
  // recursive rm intermittently fails with EBUSY and leaves a fixture behind.
  const cleanup = () => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 })
  return { root, cleanup }
}

/**
 * Create a fake session log directory + projection-cache title entry.
 */
export async function seedSession(home, { sessionId, cwd, title = '', eventCount = 42, bytes = 2048, origin = undefined, blank = false }) {
  const slug = `--${String(cwd).replace(/[\\/:]+/g, '-').replace(/^-+|-+$/g, '')}--`
  const dir = join(home.root, 'sessions', slug, sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.jsonl.zstd'), Buffer.alloc(bytes, 7))
  await mergeProjectionCache(home, {
    [sessionId]: {
      identity: { createdAt: Date.now() - 1000, cwd },
      rows: {
        title: { ver: 1, seq: eventCount, val: title },
        sessionListMetadata: { ver: 1, seq: eventCount, val: { blank, lastPromptAt: blank ? null : Date.now() } },
      },
    },
  })
  return { dir, header: { id: sessionId, version: 3, createdAt: Date.now() - 1000, cwd, isSeeded: false, ...(origin === undefined ? {} : { origin }) }, eventCount, sizeBytes: bytes }
}

async function mergeProjectionCache(home, sessions) {
  const file = join(home.root, 'storages', 'session_projcache.json')
  let document = { unit: { name: 'session_projcache', version: 3 }, global: null, tables: { sessions: {} } }
  try {
    const { readFile } = await import('node:fs/promises')
    document = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    // first write
  }
  document.tables = document.tables ?? { sessions: {} }
  document.tables.sessions = { ...document.tables.sessions, ...sessions }
  await writeFile(file, JSON.stringify(document, null, 2), 'utf8')
}

/** In-memory workspace registry + workspaces with the real mutation surface. */
export function makeWorkspaceRegistry(initial = []) {
  const workspaces = new Map()
  const globalState = { archived: new Set(), pinned: new Set() }
  const events = []

  const makeWorkspace = (record) => {
    const entity = {
      id: record.id,
      path: record.path,
      title: record.title ?? record.path,
      createdAt: record.createdAt ?? new Date().toISOString(),
      updatedAt: record.updatedAt ?? new Date().toISOString(),
      sessionIds: [...(record.sessionIds ?? [])],
      async setTitle(title) { this.title = title },
      async attachSession(sessionId) {
        if (!this.sessionIds.includes(sessionId)) this.sessionIds.push(sessionId)
        events.push(['attach', sessionId])
      },
      async insertSessionBefore(sessionId, beforeId) {
        const existing = this.sessionIds.indexOf(sessionId)
        if (existing !== -1) this.sessionIds.splice(existing, 1)
        const at = beforeId === undefined ? this.sessionIds.length : this.sessionIds.indexOf(beforeId)
        this.sessionIds.splice(at === -1 ? this.sessionIds.length : at, 0, sessionId)
        events.push(['insert', sessionId, beforeId ?? null])
      },
      async detachSession(sessionId) {
        const at = this.sessionIds.indexOf(sessionId)
        if (at !== -1) this.sessionIds.splice(at, 1)
        events.push(['detach', sessionId])
      },
      async status() { return 'ok' },
    }
    workspaces.set(entity.id, entity)
    return entity
  }
  for (const record of initial) makeWorkspace(record)

  return {
    events,
    globalState,
    list: () => [...workspaces.values()],
    get: (id) => workspaces.get(id),
    create: async (path, title) => makeWorkspace({ id: `ws-${workspaces.size + 1}`, path, title }),
    async archiveSession(sessionId, options = {}) {
      events.push(['archive', sessionId, options])
      if (globalState.archived.has(sessionId)) return
      globalState.archived.add(sessionId)
    },
    async unarchiveSession(sessionId) {
      events.push(['unarchive', sessionId])
      globalState.archived.delete(sessionId)
    },
    async pinSession(sessionId) {
      events.push(['pin', sessionId])
      globalState.pinned.add(sessionId)
    },
    async unpinSession(sessionId) {
      events.push(['unpin', sessionId])
      globalState.pinned.delete(sessionId)
    },
  }
}

/** Minimal request/response pair for the route handler. */
export function makeHttpPair({ method = 'POST', path = '/', headers = {}, body = null, host = '127.0.0.1:14968' }) {
  const request = new EventEmitter()
  request.method = method
  request.url = path
  request.headers = { host, ...headers }

  const response = {
    statusCode: null,
    headers: null,
    body: '',
    writableEnded: false,
    writeHead(status, responseHeaders) {
      this.statusCode = status
      this.headers = responseHeaders
    },
    end(chunk = '') {
      this.body += String(chunk)
      this.writableEnded = true
      this.onDone?.()
    },
  }
  const done = new Promise((resolve) => { response.onDone = resolve })

  // Emit the body asynchronously, exactly like a real stream.
  queueMicrotask(() => {
    const payload = body === null ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
    if (payload !== '') request.emit('data', payload)
    request.emit('end')
  })
  request.setEncoding = () => request

  return { request, response, done }
}

/** Wait for the route's async work to settle (the handler is fire-and-forget). */
export async function callRoute(handler, options) {
  const pair = makeHttpPair(options)
  handler(pair.request, pair.response)
  await pair.done
  const parsed = (() => {
    try {
      return JSON.parse(pair.response.body)
    } catch {
      return null
    }
  })()
  return { status: pair.response.statusCode, body: parsed, raw: pair.response.body }
}

export async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
