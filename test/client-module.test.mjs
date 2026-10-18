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

async function loadClient({ withReactDom = false } = {}) {
  const registrations = []
  let exported = null
  let moduleId = null
  const style = {
    attrs: {},
    textContent: '',
    parentNode: { removeChild() {} },
    setAttribute(name, value) { this.attrs[name] = value },
  }
  const body = {}
  const portalCalls = []
  const reactDomStub = {
    createPortal: (element, container) => {
      portalCalls.push({ element, container })
      return { type: 'portal', element, container }
    },
  }
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        if (moduleId !== null) throw new Error(`duplicate factory registration for "${definition.id}"`)
        moduleId = definition.id
        exported = definition.factory((name) => {
          if (name === 'react') return makeReact()
          // The Client probes for react-dom instead of requiring it, so a host
          // without ReactDOM still boots. `withReactDom` models the real shell.
          if (name === 'react-dom') {
            if (withReactDom !== true) throw new Error('react-dom is not available')
            return reactDomStub
          }
          throw new Error(`unexpected require(${name})`)
        })
      },
    },
  }
  globalThis.document = {
    createElement: () => style,
    head: { appendChild() {} },
    body,
  }
  globalThis.window.location = {
    reload() { globalThis.__clientReloads = (globalThis.__clientReloads ?? 0) + 1 },
  }
  globalThis.window.setTimeout = (fn) => { fn(); return 0 }
  const module = await import(`../client.js?cache=${Date.now()}`)
  void module
  return { exported, registrations, style, moduleId, body, portalCalls }
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
  assert.equal(exported.name, 'conversation-recycle-bin')
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
  assert.equal(style.attrs['data-dsh-plugin'], 'conversation-recycle-bin')
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

test('client: labels and error text agree on a mixed-case locale id', async () => {
  const { exported } = await loadClient()
  exported.apply({
    slots: {
      inject(key, callback) { return callback() ?? (() => {}) },
      register() { return () => {} },
    },
    effect(fn) { fn() },
    get(name) {
      if (name === 'locale') return { getSnapshot: () => ({ locale: 'ZH-CN' }) }
      return undefined
    },
  })
  assert.equal(exported.__t('section.title'), '对话删除')
  // `errorText` used to compare the raw id, so "ZH-CN" fell through to the
  // English table while every label around it stayed Chinese.
  assert.equal(
    exported.__errorText({ code: 'E_POLICY_ORPHAN', message: 'fallback' }),
    '该对话不属于任何已登记工作区。',
  )
  // Non-localized errors keep the Host message.
  assert.equal(exported.__errorText({ code: 'E_UNKNOWN', message: 'raw host text' }), 'raw host text')
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

test('client: the dialog is portaled into document.body to escape the overlay stacking context', async () => {
  const { exported, registrations, body, portalCalls } = await loadClient({ withReactDom: true })
  const slots = {
    inject(key, callback) { return callback() ?? (() => {}) },
    register(options, component) { registrations.push({ options, component }); return () => {} },
  }
  exported.apply({ slots, effect(fn) { fn() }, get() { return undefined } })
  const overlay = registrations.find((entry) => entry.options.name === 'shell.overlay')
  // The registered component builds the element; rendering it runs DialogHost.
  const render = () => {
    const element = overlay.component({})
    return element.type(element.props)
  }

  // Nothing open: an empty portal, no dialog element inside.
  exported.__store.dialogStore.close()
  const empty = render()
  assert.equal(empty.type, 'portal')
  assert.deepEqual(empty.element.children, [null, null])

  exported.__store.dialogStore.open({
    sessionIds: ['session-aaaaaaaa-1111'],
    displayTitle: 'Alpha',
    key: 'portal-test',
  })
  const tree = render()
  // The backdrop lives on `document.body`, so the settings modal (also
  // z-index 1000, on body) can no longer swallow the dialog's first click.
  assert.equal(tree.type, 'portal')
  assert.equal(tree.container, body)
  assert.equal(tree.element.children[0].type, exported.__components.DeleteDialog)
  assert.equal(portalCalls.length, 2)
  exported.__store.dialogStore.close()
})

test('client: a host without react-dom still renders the overlay inline', async () => {
  const { exported, registrations, portalCalls } = await loadClient({ withReactDom: false })
  const slots = {
    inject(key, callback) { return callback() ?? (() => {}) },
    register(options, component) { registrations.push({ options, component }); return () => {} },
  }
  exported.apply({ slots, effect(fn) { fn() }, get() { return undefined } })
  const overlay = registrations.find((entry) => entry.options.name === 'shell.overlay')
  exported.__store.dialogStore.open({ sessionIds: ['session-aaaaaaaa-1111'], displayTitle: 'Alpha', key: 'inline' })
  const element = overlay.component({})
  const tree = element.type(element.props)
  assert.notEqual(tree.type, 'portal')
  assert.equal(portalCalls.length, 0)
  exported.__store.dialogStore.close()
})

test('client: an incomplete entry that still holds its log offers a restore action', async () => {
  const { exported } = await loadClient()
  const restored = []
  const tree = exported.__components.IncompleteEntries({
    entries: [
      { trashId: 'abc-1', sessionId: 'session-bbbbbbbb-2222', status: 'failed', updatedAt: Date.now(), memory: 0, hasSessionLog: true },
      { trashId: 'abc-2', sessionId: 'session-cccccccc-3333', status: 'pending', updatedAt: Date.now(), memory: 0, hasSessionLog: false },
    ],
    discardTarget: null,
    discardPhrase: '',
    onPhrase() {},
    onStart() {},
    onCancel() {},
    onDiscard() {},
    onRestore: (trashId) => restored.push(trashId),
    restoreBusyId: null,
  })
  const rows = tree.children.filter((child) => child?.props?.className === 'dc-row')
  assert.equal(rows.length, 2)

  // The restore button is identified by its tooltip, so a discard button in
  // the same row cannot satisfy the search.
  const restoreTitle = exported.__t('trash.restoreIncompleteHint')
  const findButton = (node, title) => {
    if (node === null || typeof node !== 'object') return null
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findButton(item, title)
        if (found !== null) return found
      }
      return null
    }
    if (node.props?.title === title) return node
    for (const child of node.children ?? []) {
      const found = findButton(child, title)
      if (found !== null) return found
    }
    return null
  }

  // Row 1 holds the log: a restore button, and it calls back with the id.
  const restoreButton = findButton(rows[0], restoreTitle)
  assert.ok(restoreButton !== null, 'the entry with a session log has no restore button')
  restoreButton.props.onClick()
  assert.deepEqual(restored, ['abc-1'])

  // Row 2 holds nothing: discard only, no restore button.
  assert.equal(findButton(rows[1], restoreTitle), null)
})

test('client: the batch picker disables rows the Host refuses and says why', async () => {
  const { exported } = await loadClient()
  const blocked = exported.__components.BatchSessionRow({
    session: {
      id: 'session-cccccccc-3333',
      title: 'Orphan chat',
      cwd: 'D://Unregistered',
      updatedAt: Date.now(),
      deletable: false,
      policy: { ok: false, code: 'E_POLICY_ORPHAN', message: '该对话不属于任何已登记工作区。' },
    },
    checked: false,
    onToggle() {},
  })
  assert.match(blocked.props.className, /dc-disabled/)
  const checkbox = blocked.children[0]
  assert.equal(checkbox.props.disabled, true)
  const hint = blocked.children[1].children[1]
  assert.match(hint.children[0], /无法删除/)
  assert.match(hint.children[0], /E_POLICY_ORPHAN|不属于任何已登记工作区/)

  const allowed = exported.__components.BatchSessionRow({
    session: { id: 'session-aaaaaaaa-1111', title: 'Alpha chat', cwd: 'D://Work', updatedAt: Date.now(), deletable: true, policy: { ok: true } },
    checked: true,
    onToggle() {},
  })
  assert.doesNotMatch(allowed.props.className, /dc-disabled/)
  assert.equal(allowed.children[0].props.disabled, false)

  // "Select all" marks exactly the rows the Host has not vetoed.
  assert.deepEqual(
    exported.__selectableSessionIds([
      { id: 'a', deletable: true },
      { id: 'b', deletable: false },
      { id: 'c' },
    ]),
    ['a', 'c'],
  )
})

test('client: ui flags carry the Host defaultMode instead of a hard-coded soft start', async () => {
  const { exported } = await loadClient()
  const originalFetch = globalThis.fetch
  try {
    // Without a real page there is nothing to ask; the harness models one.
    globalThis.document.baseURI = 'http://127.0.0.1:14968/'
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return {
          ok: true,
          state: { enabled: true, defaultMode: 'hard', ui: { showRowAction: true, showHeaderAction: false } },
        }
      },
    })
    await exported.__loadUiFlags()
    const flags = exported.__store.uiFlagsStore.flags
    assert.equal(flags.defaultMode, 'hard')
    assert.equal(flags.showHeaderAction, false)

    // A state without the field (older Host) stays on the safe default.
    globalThis.fetch = async () => ({ ok: true, async json() { return { ok: true, state: { enabled: true, ui: {} } } } })
    exported.__store.uiFlagsStore.loaded = false
    await exported.__loadUiFlags()
    assert.equal(exported.__store.uiFlagsStore.flags.defaultMode, 'soft')
  } finally {
    globalThis.fetch = originalFetch
    delete globalThis.document.baseURI
  }
})

test('client: adapter labels and reasons are localized, not raw Host ids', async () => {
  const applyWithLocale = async (localeId) => {
    const { exported } = await loadClient()
    exported.apply({
      slots: {
        inject(key, callback) { return callback() ?? (() => {}) },
        register() { return () => {} },
      },
      effect(fn) { fn() },
      get(name) {
        if (name === 'locale') return { getSnapshot: () => ({ active: localeId }) }
        return undefined
      },
    })
    return exported
  }
  // The locale service is probed once per module instance, so each language
  // gets a fresh client — exactly like a fresh page load in the real host.
  const en = await applyWithLocale('en')
  assert.equal(en.__adapterLabel({ id: 'lingshu', label: '灵枢认知图 (md_cg)' }), 'Lingshu cognitive graph (md_cg)')
  assert.equal(en.__adapterReason('no-memory-store'), 'No conversation-linked memory store was detected.')
  // Unknown ids fall back to the Host's own text rather than a blank cell.
  assert.equal(en.__adapterLabel({ id: 'mystery', label: 'Mystery store' }), 'Mystery store')
  assert.equal(en.__adapterReason('some-future-reason'), 'some-future-reason')

  const zh = await applyWithLocale('zh-CN')
  assert.equal(zh.__adapterLabel({ id: 'lingshu', label: 'lingshu (md_cg)' }), '灵枢认知图 (md_cg)')
  assert.equal(zh.__adapterLabel({ id: 'none', label: 'none' }), '无记忆存储')
  assert.equal(zh.__adapterReason('no-memory-store'), '未检测到与对话关联的记忆存储。')
})

test('client: the active locale is read from the snapshot field the host actually uses', async () => {
  // `dsh-client-locale`'s snapshot is `{ active, locales, revision }`: neither
  // `locale` nor `id` exists, so reading those fell back to the browser
  // language and ignored the in-app language switch.
  const { exported } = await loadClient()
  exported.apply({
    slots: {
      inject(key, callback) { return callback() ?? (() => {}) },
      register() { return () => {} },
    },
    effect(fn) { fn() },
    get(name) {
      if (name === 'locale') return { getSnapshot: () => ({ active: 'zh', locales: ['en', 'zh'], revision: 3 }) }
      return undefined
    },
  })
  assert.equal(exported.__t('section.title'), '对话删除')
  assert.equal(exported.__t('action.delete'), '删除')
})

test('client: the active locale is read from the snapshot field the host actually uses', async () => {
  // `dsh-client-locale`'s snapshot is `{ active, locales, revision }`: neither
  // `locale` nor `id` exists, so reading those fell back to the browser
  // language and ignored the in-app language switch.
  const { exported } = await loadClient()
  exported.apply({
    slots: {
      inject(key, callback) { return callback() ?? (() => {}) },
      register() { return () => {} },
    },
    effect(fn) { fn() },
    get(name) {
      if (name === 'locale') return { getSnapshot: () => ({ active: 'zh', locales: ['en', 'zh'], revision: 3 }) }
      return undefined
    },
  })
  assert.equal(exported.__t('section.title'), '对话删除')
  assert.equal(exported.__t('action.delete'), '删除')
})
