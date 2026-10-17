/**
 * Client-half validation WITHOUT a browser.
 *
 * The host cannot execute JSX or hooks here, so this harness deliberately does
 * the minimum that still catches real regressions:
 *   - installs the `window.__ModuleLoader__` contract client.js expects;
 *   - provides a tiny React surface whose hooks return inert values;
 *   - runs `apply(ctx)` against a fake slot service and records every
 *     registration;
 *   - invokes each registered component once with representative props, so a
 *     typo or a render-time crash is caught before a browser refresh.
 *
 * It is not a visual test and does not claim to be one.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function makeReact() {
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children })
  return {
    createElement: h,
    Fragment: 'Fragment',
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() },
    useRef(value) { return { current: value } },
  }
}

async function loadClient() {
  const registrations = []
  let exported = null
  let moduleId = null
  const style = {
    attrs: {},
    textContent: '',
    parentNode: { removeChild() {} },
    setAttribute(name, value) { this.attrs[name] = value },
  }
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        if (moduleId !== null) throw new Error(`duplicate factory registration for "${definition.id}"`)
        moduleId = definition.id
        exported = definition.factory((name) => {
          if (name === 'react') return makeReact()
          throw new Error(`unexpected require(${name})`)
        })
      },
    },
  }
  globalThis.document = {
    createElement: () => style,
    head: { appendChild() {} },
  }
  globalThis.window.location = {
    reload() { globalThis.__clientReloads = (globalThis.__clientReloads ?? 0) + 1 },
  }
  globalThis.window.setTimeout = (fn) => { fn(); return 0 }
  const module = await import(`../client.js?cache=${Date.now()}`)
  void module
  return { exported, registrations, style, moduleId }
}

test('client: module id equals the package name the boot graph keys rows by', async () => {
  const { moduleId } = await loadClient()
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  // The Host addresses a bundle by `package.json#name`; a mismatch makes the
  // loader re-execute the bundle and throw a duplicate-registration boot error.
  assert.equal(moduleId, pkg.name)
})

test('client: registers every slot through the module-loader contract', async () => {
  const { exported, registrations, style } = await loadClient()
  assert.equal(exported.name, 'delete-conversation')
  assert.deepEqual(exported.inject, ['slots'])
  assert.equal(typeof exported.apply, 'function')

  const disposers = []
  const slots = {
    inject(key, callback) {
      const disposal = callback()
      return () => {
        if (typeof disposal === 'function') disposal()
      }
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  }
  const ctx = {
    slots,
    effect(fn) {
      const disposal = fn()
      if (typeof disposal === 'function') disposers.push(disposal)
    },
    get(name) {
      if (name === 'slots') return slots
      return undefined
    },
  }
  exported.apply(ctx)

  const names = registrations.map((entry) => entry.options.name).sort()
  assert.deepEqual(names, [
    'conversation.session.header.actions',
    'settings.section',
    'shell.overlay',
    'sidebar.workspaces.session.menu.item',
  ])
  for (const entry of registrations) {
    assert.equal(typeof entry.options.id, 'string')
    assert.equal(typeof entry.component, 'function')
  }
  const settings = registrations.find((entry) => entry.options.name === 'settings.section')
  assert.equal(settings.options.order, 1300)
  assert.equal(style.attrs['data-dsh-plugin'], 'delete-conversation')
  // Disposal must not throw.
  for (const dispose of disposers.reverse()) dispose()
})

test('client: every registered component survives one inert render pass', async () => {
  const { exported, registrations } = await loadClient()
  const slots = {
    inject(key, callback) {
      const disposal = callback()
      return () => {
        if (typeof disposal === 'function') disposal()
      }
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  }
  exported.apply({
    slots,
    effect(fn) {
      fn()
    },
    get() { return undefined },
  })

  const menu = registrations.find((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')
  assert.doesNotThrow(() => menu.component({
    sessionId: 'session-aaaaaaaa-1111',
    displayTitle: 'Alpha',
    useMenuOpenState: () => [false, () => {}],
  }))

  const header = registrations.find((entry) => entry.options.name === 'conversation.session.header.actions')
  assert.doesNotThrow(() => header.component({ sessionId: 'session-aaaaaaaa-1111' }))

  const overlay = registrations.find((entry) => entry.options.name === 'shell.overlay')
  assert.doesNotThrow(() => overlay.component({}))

  // With a dialog payload the overlay renders the confirmation component too.
  exported.__store.dialogStore.open({
    sessionIds: ['session-aaaaaaaa-1111'],
    displayTitle: 'Alpha',
    key: 'test',
  })
  assert.doesNotThrow(() => overlay.component({}))
  exported.__store.dialogStore.close()

  const settings = registrations.find((entry) => entry.options.name === 'settings.section')
  assert.doesNotThrow(() => settings.component({}))
})

test('client: updates the shell in place after a mutation', async () => {
  const { exported, registrations } = await loadClient()
  const slots = {
    inject(key, callback) {
      const disposal = callback()
      return () => {
        if (typeof disposal === 'function') disposal()
      }
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  }
  const counts = { refresh: 0, archived: 0, cleared: 0 }
  const sessions = { async refresh() { counts.refresh += 1 } }
  const workspace = {
    selection: { getSnapshot() { return { sessionId: 'session-aaaaaaaa-1111' } } },
    clearArchivedCurrent() { counts.archived += 1; return true },
    clearMain() { counts.cleared += 1 },
  }
  const ctx = {
    slots,
    effect(fn) { fn() },
    get(name) {
      if (name === 'slots') return slots
      if (name === 'sessions') return sessions
      if (name === 'uiWorkspace') return workspace
      return undefined
    },
  }
  exported.apply(ctx)
  const helper = exported.__refreshAfterMutation
  assert.equal(typeof helper, 'function')
  const reloadsBefore = globalThis.__clientReloads ?? 0

  // The open conversation is the deleted one: refresh the list, then close it.
  await helper({ sessionIds: ['session-aaaaaaaa-1111'] })
  assert.equal(counts.refresh, 1)
  assert.equal(counts.archived, 1)
  assert.equal(counts.cleared, 0)
  assert.equal(globalThis.__clientReloads ?? 0, reloadsBefore)

  // Restoring an entry must not disturb the conversation that is on screen.
  await helper({ sessionIds: ['session-aaaaaaaa-1111'], closeCurrent: false })
  assert.equal(counts.refresh, 2)
  assert.equal(counts.archived, 1)
  assert.equal(counts.cleared, 0)

  // A hard delete leaves no archive entry, so the close falls back to clearMain.
  workspace.clearArchivedCurrent = () => { counts.archived += 1; return false }
  await helper({ sessionIds: ['session-aaaaaaaa-1111'] })
  assert.equal(counts.cleared, 1)

  // No client sessions service (older host): reload is the documented fallback.
  exported.apply({ slots, effect(fn) { fn() }, get(name) { return name === 'slots' ? slots : undefined } })
  await helper({ sessionIds: ['session-aaaaaaaa-1111'] })
  assert.ok((globalThis.__clientReloads ?? 0) > reloadsBefore)
})

test('client: a host without the private close methods reloads instead of keeping a dead conversation', async () => {
  const { exported } = await loadClient()
  const slots = {
    inject(key, callback) { return callback() ?? (() => {}) },
    register() { return () => {} },
  }
  const counts = { refresh: 0 }
  const sessions = { async refresh() { counts.refresh += 1 } }
  // `clearArchivedCurrent` / `clearMain` are private on the host; model a
  // future host that removed them.
  const workspace = { selection: { getSnapshot() { return { sessionId: 'session-aaaaaaaa-1111' } } } }
  exported.apply({
    slots,
    effect(fn) { fn() },
    get(name) {
      if (name === 'slots') return slots
      if (name === 'sessions') return sessions
      if (name === 'uiWorkspace') return workspace
      return undefined
    },
  })
  const reloadsBefore = globalThis.__clientReloads ?? 0
  await exported.__refreshAfterMutation({ sessionIds: ['session-aaaaaaaa-1111'] })
  assert.equal(counts.refresh, 1)
  assert.ok((globalThis.__clientReloads ?? 0) > reloadsBefore)
  assert.equal(exported.__store.mutationStore.version, 1)
})

test('client: ui.showRowAction and ui.showHeaderAction actually hide their entries', async () => {
  const { exported } = await loadClient()
  const contexts = []
  const slots = {
    inject(key, callback) { return callback() ?? (() => {}) },
    register(options, component) { contexts.push({ options, component }); return () => {} },
  }
  exported.apply({ slots, effect(fn) { fn() }, get() { return undefined } })
  const menuProps = { sessionId: 'session-aaaaaaaa-1111', displayTitle: 'Alpha', useMenuOpenState: () => [false, () => {}] }
  const headerProps = { sessionId: 'session-aaaaaaaa-1111' }
  const menu = exported.__components.DeleteMenuRow
  const header = exported.__components.HeaderDeleteAction

  assert.notEqual(menu(menuProps), null)
  assert.notEqual(header(headerProps), null)

  exported.__store.uiFlagsStore.set({ showRowAction: false, showHeaderAction: true })
  assert.equal(menu(menuProps), null)
  assert.notEqual(header(headerProps), null)

  exported.__store.uiFlagsStore.set({ showRowAction: true, showHeaderAction: false })
  assert.notEqual(menu(menuProps), null)
  assert.equal(header(headerProps), null)

  // `enabled: false` hides both entries (the schema promises this).
  exported.__store.uiFlagsStore.set({ showRowAction: true, showHeaderAction: true, enabled: false })
  assert.equal(menu(menuProps), null)
  assert.equal(header(headerProps), null)
})

test('client: a partial batch payload is returned instead of thrown as a refusal', async () => {
  const { exported } = await loadClient()
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return {
          ok: false,
          partial: true,
          results: [{ sessionId: 'session-aaaaaaaa-1111' }],
          failures: [{ sessionId: 'session-bbbbbbbb-2222', error: { code: 'E_TRANSACTION_FAILED', message: 'x' } }],
        }
      },
    })
    const payload = await exported.__api('/delete', { method: 'POST', body: {} })
    assert.equal(payload.results.length, 1)
    assert.equal(payload.failures.length, 1)

    globalThis.fetch = async () => ({
      ok: false,
      async json() { return { ok: false, error: { code: 'E_POLICY_LIVE', message: 'still running' } } },
    })
    await assert.rejects(
      () => exported.__api('/delete', { method: 'POST', body: {} }),
      (error) => error.code === 'E_POLICY_LIVE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('client: mutation timeouts grow with the batch instead of a flat 15s', async () => {
  const { exported } = await loadClient()
  assert.equal(exported.__mutationTimeoutMs(1), 35_000)
  assert.equal(exported.__mutationTimeoutMs(20), 130_000)
  assert.equal(exported.__mutationTimeoutMs(100), 180_000)
})

test('client: incomplete recycle-bin entries render with a discard action', async () => {
  const { exported } = await loadClient()
  const tree = exported.__components.IncompleteEntries({
    entries: [
      { trashId: 'abc-1', sessionId: 'session-bbbbbbbb-2222', status: 'failed', updatedAt: Date.now(), memory: 0 },
    ],
    discardTarget: 'abc-1',
    discardPhrase: 'DELETE',
    onPhrase() {},
    onStart() {},
    onCancel() {},
    onDiscard() {},
  })
  assert.equal(tree.type, 'div')
  assert.ok(tree.children.length >= 3)
  // The row carries the discard button and its confirmation input.
  const row = tree.children.find((child) => child?.props?.className === 'dc-row')
  assert.ok(row !== undefined)
  const actions = row.children.find((child) => child?.props?.className === 'dc-row-actions')
  assert.ok(actions !== undefined)
})
