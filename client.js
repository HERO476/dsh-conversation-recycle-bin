/**
 * dsh-conversation-recycle-bin — Client half.
 *
 * Hand-authored in the Web shell's module-loader format (`window.__ModuleLoader__.load`
 * + `require`), so the package needs no build step. The Client owns every pixel; all
 * authority and filesystem work stays on the Host behind the same-origin route.
 *
 * Surface:
 *   - one row in the Session "..." menu (`sidebar.workspaces.session.menu.item`);
 *   - one action in the conversation header (`conversation.session.header.actions`);
 *   - one dialog host in `shell.overlay` (so closing the menu does not unmount the
 *     dialog — the menu item unmounts with its dropdown);
 *   - one Settings section: recycle bin, batch deletion and the audit trail.
 *
 * The confirmation dialog is the only place a deletion is started from the UI. It
 * always defaults to the safe choices: soft delete, memory checkbox OFF, and the
 * batch/permanent phrases are typed by the user, matching the Host's server-side
 * confirmation protocol in `lib/host/api.js`.
 */
window.__ModuleLoader__.load({
  // Must equal the module name the bundle row mounts (`cordis.patch.yml`'s
  // row `name`, which is the package name). The Host's boot graph keys every
  // client row by that name; a bundle registering under any other id is
  // reported as "loaded without registering" and then executed a second time
  // from its one-resource URL, which throws
  // `duplicate factory registration for "..."` and aborts web boot.
  id: 'dsh-conversation-recycle-bin',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    /* ------------------------------------------------------------------ *
     * Locale
     * ------------------------------------------------------------------ */

    const NS = 'conversation-recycle-bin'
    const STRINGS = {
      en: {
        'action.menuDelete': 'Delete conversation…',
        'action.headerDelete': 'Delete conversation',
        'action.delete': 'Delete',
        'action.cancel': 'Cancel',
        'action.close': 'Close',
        'action.refresh': 'Refresh',
        'action.restore': 'Restore',
        'action.purge': 'Delete permanently',
        'action.selectAll': 'Select all',
        'action.clearAll': 'Clear',
        'section.label': 'Conversation Deletion',
        'section.title': 'Conversation Deletion',
        'section.subtitle': 'Recycle bin, batch deletion and the audit trail.',
        'dialog.titleOne': 'Delete this conversation?',
        'dialog.titleMany': 'Delete {count} conversations?',
        'dialog.bodyOne': '“{title}” will be removed from the session list.',
        'dialog.bodyMany': '{count} conversations will be removed from the session list.',
        'dialog.modeSoft': 'Move to the recycle bin (recommended)',
        'dialog.modeSoftHint': 'The log stays on disk and can be restored from the recycle bin.',
        'dialog.modeHard': 'Delete permanently',
        'dialog.modeHardHint': 'Moves the session log out of the live store. Recoverable until the recycle-bin entry is purged.',
        'dialog.memoryLabel': 'Also delete this conversation’s associated memory',
        'dialog.memoryHint': 'Off by default. The count is read live before you confirm.',
        'dialog.memoryCount': '{count} associated memory entries will be moved to the recycle bin',
        'dialog.memoryFound': '{count} associated memory entries were found',
        'dialog.memoryNone': 'No associated memory entries were found',
        'dialog.memoryUnsupported': 'Memory store unavailable: {reason}',
        'dialog.memoryProtected': '{count} protected entries will be kept',
        'dialog.memoryKeep': 'The Host is configured to keep memory entries (deleteMode = keep).',
        'dialog.memoryDisabled': 'Associated-memory deletion is disabled in the Host configuration.',
        'dialog.records': '{events} log records · {size}',
        'dialog.hardWarning': 'Type DELETE to confirm permanent deletion.',
        'dialog.batchWarning': 'Type the number {count} to confirm this batch.',
        'dialog.liveStopHint': 'This conversation is open in a live agent. Permanent deletion stops it first, then removes its log.',
        'dialog.phraseLabel': 'Confirmation',
        'dialog.delete': 'Delete',
        'dialog.working': 'Deleting…',
        'dialog.loading': 'Reading the plan…',
        'dialog.done': 'Deleted {count} conversation(s); {memory} memory entries moved to the recycle bin.',
        'dialog.partial': 'Deleted {done}, failed {failed}.',
        'dialog.noSession': 'The conversation no longer exists.',
        'dialog.blocked': 'This conversation cannot be deleted: {message}',
        'dialog.reloadHint': 'The conversation list refreshes automatically.',
        'trash.title': 'Recycle bin',
        'trash.empty': 'The recycle bin is empty.',
        'trash.deletedAt': 'Deleted {time}',
        'trash.modeSoft': 'soft',
        'trash.modeHard': 'permanent',
        'trash.items': '{sessions} conversation(s) · {memories} memory entries',
        'trash.confirmPurge': 'Type DELETE to permanently remove this entry.',
        'trash.restored': 'Restored.',
        'trash.purged': 'Permanently deleted.',
        'trash.incompleteTitle': 'Incomplete entries',
        'trash.incompleteHint': 'Entries that never committed. Discard them to free the space; an entry that still holds a conversation log must be restored or purged instead.',
        'trash.discard': 'Discard',
        'trash.discarded': 'Entry removed.',
        'trash.confirmDiscard': 'Type DELETE to discard this incomplete entry.',
        'trash.status.pending': 'pending',
        'trash.status.failed': 'failed',
        'trash.status.restoring': 'restoring',
        'trash.status.purging': 'purging',
        'trash.status.restored': 'restored',
        'batch.title': 'Batch deletion',
        'batch.hint': 'Each conversation is its own transaction; a failure rolls only that conversation back.',
        'batch.selected': '{count} selected',
        'batch.deleteSelected': 'Delete selected…',
        'batch.empty': 'No conversations.',
        'batch.overLimit': 'The selection exceeds the current limit of {limit}.',
        'audit.title': 'Audit trail',
        'audit.empty': 'No deletion has been recorded yet.',
        'audit.denied': 'denied',
        'audit.success': 'success',
        'audit.rolled-back': 'rolled back',
        'audit.rollback-incomplete': 'rollback incomplete',
        'state.title': 'Host status',
        'state.memory': 'Memory adapters',
        'state.limits': 'Limits',
        'state.available': 'available',
        'state.unavailable': 'unavailable',
        'state.rate': '{used}/{limit} deletions this minute',
        'state.batch': 'Effective batch limit: {limit}',
        'error.E_CONFIRM_PHRASE': 'The confirmation phrase does not match.',
        'error.E_CONFIRM_EXPIRED': 'The confirmation expired; the counts were reloaded.',
        'error.E_CONFIRM_INVALID': 'The confirmation is stale; the plan was reloaded.',
        'error.E_POLICY_LIVE': 'The conversation could not be stopped. Close it and retry.',
        'error.E_POLICY_ORPHAN': 'The conversation is not owned by a registered workspace.',
        'error.E_POLICY_PROTECTED': 'The conversation is protected by configuration.',
        'error.E_POLICY_SUBAGENT': 'Subagent conversations cannot be deleted.',
        'error.E_POLICY_ROOT': 'The conversation is outside the allowed workspace roots.',
        'error.E_RATE_LIMITED': 'Too many deletions; wait a moment and retry.',
        'error.E_BATCH_TOO_LARGE': 'Too many conversations selected (the current limit is {limit}).',
        'error.E_TIMEOUT': 'The Host did not answer in time. It may still be working; refresh the list before retrying.',
        'error.E_DISABLED': 'Conversation deletion is disabled by configuration.',
        'error.E_TRANSACTION_FAILED': 'Deletion failed and was rolled back.',
        'error.E_MEMORY_FAILED': 'The memory store could not be updated; nothing was deleted.',
        'error.E_BAD_RESPONSE': 'The Host returned an unreadable response.',
        'error.E_INTERNAL': 'An unexpected Host error occurred.',
        'error.E_NOT_FOUND': 'The conversation no longer exists.',
        'error.E_BAD_REQUEST': 'The Host rejected the request as invalid.',
        'error.E_TRASH_NOT_FOUND': 'The recycle-bin entry no longer exists.',
        'error.E_TRASH_CONFLICT': 'The entry is still in use (for example it still holds a conversation log) or its state does not allow this action.',
        'error.E_CONFIRM_REQUIRED': 'Reload the dialog and confirm again.',
        'error.E_FORBIDDEN_HOST': 'The Host only accepts deletion requests from loopback; set allowNonLoopback for remote access.',
        'error.E_FORBIDDEN_ORIGIN': 'The Host rejected this page as an untrusted origin.',
        'error.E_POLICY_FOREIGN_WRITER': 'Another DSH instance is still writing this conversation; close it there and retry.',
        'common.bytes': '{value} {unit}',
      },
      zh: {
        'action.menuDelete': '删除对话…',
        'action.headerDelete': '删除对话',
        'action.delete': '删除',
        'action.cancel': '取消',
        'action.close': '关闭',
        'action.refresh': '刷新',
        'action.restore': '恢复',
        'action.purge': '彻底删除',
        'action.selectAll': '全选',
        'action.clearAll': '清除',
        'section.label': '对话删除',
        'section.title': '对话删除',
        'section.subtitle': '回收站、批量删除与审计留痕。',
        'dialog.titleOne': '删除这个对话？',
        'dialog.titleMany': '删除 {count} 个对话？',
        'dialog.bodyOne': '「{title}」将从会话列表中移除。',
        'dialog.bodyMany': '{count} 个对话将从会话列表中移除。',
        'dialog.modeSoft': '移入回收站（推荐）',
        'dialog.modeSoftHint': '日志仍保留在磁盘上，可从回收站恢复。',
        'dialog.modeHard': '彻底删除',
        'dialog.modeHardHint': '把会话日志移出活动存储；在回收站条目被清理前仍可恢复。',
        'dialog.memoryLabel': '同时删除该对话的关联记忆',
        'dialog.memoryHint': '默认不勾选。确认前会实时统计受影响的记忆条数。',
        'dialog.memoryCount': '将把 {count} 条关联记忆移入回收站',
        'dialog.memoryFound': '找到 {count} 条关联记忆',
        'dialog.memoryNone': '未找到关联记忆',
        'dialog.memoryUnsupported': '记忆存储不可用：{reason}',
        'dialog.memoryProtected': '另有 {count} 条受保护记忆将保留',
        'dialog.memoryKeep': '宿主配置为保留记忆（deleteMode = keep）。',
        'dialog.memoryDisabled': '宿主配置已禁用关联记忆删除。',
        'dialog.records': '{events} 条日志记录 · {size}',
        'dialog.hardWarning': '彻底删除需输入 DELETE 确认。',
        'dialog.batchWarning': '批量删除需输入数字 {count} 确认。',
        'dialog.liveStopHint': '该对话仍在运行中；彻底删除会先停止它，再移除日志。',
        'dialog.phraseLabel': '确认',
        'dialog.delete': '删除',
        'dialog.working': '正在删除…',
        'dialog.loading': '正在读取删除计划…',
        'dialog.done': '已删除 {count} 个对话；移入回收站的记忆条目 {memory} 条。',
        'dialog.partial': '成功 {done} 个，失败 {failed} 个。',
        'dialog.noSession': '该对话已不存在。',
        'dialog.blocked': '该对话无法删除：{message}',
        'dialog.reloadHint': '会话列表将自动刷新。',
        'trash.title': '回收站',
        'trash.empty': '回收站为空。',
        'trash.deletedAt': '删除于 {time}',
        'trash.modeSoft': '软删除',
        'trash.modeHard': '彻底',
        'trash.items': '{sessions} 个对话 · {memories} 条记忆',
        'trash.confirmPurge': '输入 DELETE 彻底删除该条目。',
        'trash.restored': '已恢复。',
        'trash.purged': '已彻底删除。',
        'trash.incompleteTitle': '未完成条目',
        'trash.incompleteHint': '这些条目没有提交成功，可直接清理以释放空间；仍保存着会话日志的条目请先恢复或彻底删除。',
        'trash.discard': '清理',
        'trash.discarded': '条目已清理。',
        'trash.confirmDiscard': '输入 DELETE 清理该未完成条目。',
        'trash.status.pending': '待处理',
        'trash.status.failed': '失败',
        'trash.status.restoring': '恢复中断',
        'trash.status.purging': '清理中断',
        'trash.status.restored': '已恢复',
        'batch.title': '批量删除',
        'batch.hint': '每个对话独立事务；失败时仅回滚该对话。',
        'batch.selected': '已选 {count} 个',
        'batch.deleteSelected': '删除所选…',
        'batch.empty': '没有对话。',
        'batch.overLimit': '所选数量超过当前上限 {limit} 个。',
        'audit.title': '审计留痕',
        'audit.empty': '尚无删除记录。',
        'audit.denied': '被拒绝',
        'audit.success': '成功',
        'audit.rolled-back': '已回滚',
        'audit.rollback-incomplete': '回滚不完整',
        'state.title': '宿主状态',
        'state.memory': '记忆适配器',
        'state.limits': '限制',
        'state.available': '可用',
        'state.unavailable': '不可用',
        'state.rate': '本分钟已删除 {used}/{limit}',
        'state.batch': '单次上限：{limit} 个（受每分钟额度约束）',
        'error.E_CONFIRM_PHRASE': '确认短语不匹配。',
        'error.E_CONFIRM_EXPIRED': '确认已过期；计数已重新加载。',
        'error.E_CONFIRM_INVALID': '确认已失效；计划已重新加载。',
        'error.E_POLICY_LIVE': '无法停止该对话，请关闭后重试。',
        'error.E_POLICY_ORPHAN': '该对话不属于任何已登记工作区。',
        'error.E_POLICY_PROTECTED': '该对话受配置保护。',
        'error.E_POLICY_SUBAGENT': '子代理对话不能删除。',
        'error.E_POLICY_ROOT': '该对话不在允许的工作区根目录内。',
        'error.E_RATE_LIMITED': '删除过于频繁，请稍后重试。',
        'error.E_BATCH_TOO_LARGE': '所选对话过多（当前上限 {limit} 个）。',
        'error.E_TIMEOUT': '宿主未及时响应；操作可能仍在后台继续，请刷新列表确认后再重试。',
        'error.E_DISABLED': '宿主配置已禁用对话删除。',
        'error.E_TRANSACTION_FAILED': '删除失败，已回滚。',
        'error.E_MEMORY_FAILED': '记忆存储更新失败；未删除任何内容。',
        'error.E_BAD_RESPONSE': '宿主返回了无法解析的响应。',
        'error.E_INTERNAL': '宿主发生未预期的错误。',
        'error.E_NOT_FOUND': '该对话已不存在。',
        'error.E_BAD_REQUEST': '请求参数无效。',
        'error.E_TRASH_NOT_FOUND': '回收站条目已不存在。',
        'error.E_TRASH_CONFLICT': '该条目仍被占用（例如仍保存着会话日志）或状态不允许此操作。',
        'error.E_CONFIRM_REQUIRED': '请重新加载确认框后再试。',
        'error.E_FORBIDDEN_HOST': '宿主只接受本机回环地址的删除请求；远程访问需设置 allowNonLoopback。',
        'error.E_FORBIDDEN_ORIGIN': '宿主拒绝了该页面的请求（来源校验未通过）。',
        'error.E_POLICY_FOREIGN_WRITER': '另一个 DSH 实例仍在写这个对话，已中止删除；请先关闭那边的对话再重试。',
        'common.bytes': '{value} {unit}',
      },
    }

    let runtimeCtx = null
    let localeService = null

    function peekLocaleService() {
      if (localeService !== null) return localeService
      if (runtimeCtx === null) return null
      try {
        localeService = runtimeCtx.locale ?? runtimeCtx.get('locale') ?? null
      } catch {
        localeService = null
      }
      return localeService
    }

    function currentLocaleId() {
      const service = peekLocaleService()
      try {
        const snapshot = service?.getSnapshot?.() ?? service?.getLocale?.()
        const id = snapshot?.locale ?? snapshot?.id
        if (typeof id === 'string' && id !== '') return id
      } catch {
        // fall through
      }
      const language = typeof navigator !== 'undefined' && typeof navigator.language === 'string'
        ? navigator.language
        : 'zh'
      return language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    function isZhLocale(localeId) {
      return String(localeId ?? '').toLowerCase().startsWith('zh')
    }

    function t(key, vars) {
      const table = isZhLocale(currentLocaleId()) ? STRINGS.zh : STRINGS.en
      const template = table[key] ?? STRINGS.en[key] ?? key
      if (vars === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => {
        const value = vars[name]
        return value === undefined ? match : String(value)
      })
    }

    function errorText(error) {
      const code = error?.code
      // Same locale test as `t`: a mixed-case id (e.g. "ZH-CN") used to fall
      // through to the English table while every other string stayed Chinese.
      const table = isZhLocale(currentLocaleId()) ? STRINGS.zh : STRINGS.en
      const template = code === undefined ? undefined : table[`error.${code}`]
      if (template === undefined) return error?.message ?? String(error)
      return template.replace(/\{(\w+)\}/g, (match, name) => {
        const value = error?.details?.[name] ?? error?.[name]
        return value === undefined ? '—' : String(value)
      })
    }

    function useLocaleTick() {
      const [, force] = useState(0)
      useEffect(() => {
        const service = peekLocaleService()
        if (service === null || typeof service.subscribe !== 'function') return undefined
        try {
          return service.subscribe(() => force((value) => value + 1))
        } catch {
          return undefined
        }
      }, [])
    }

    /* ------------------------------------------------------------------ *
     * Host HTTP client
     * ------------------------------------------------------------------ */

    const API_PREFIX = '/conversation-recycle-bin/api'
    const REQUEST_TIMEOUT_MS = 15_000
    const MUTATION_TIMEOUT_MS = 180_000

    /**
     * A batch is one HTTP request that can stop several live sessions (each up
     * to `liveDrainMs`) and wait for the memory lock. The old flat 15s timeout
     * aborted the request while the Host kept deleting, leaving the user with
     * a timeout error, a consumed token and a half-changed list.
     */
    function mutationTimeoutMs(count) {
      const items = Number.isFinite(count) ? Math.max(1, count) : 1
      return Math.min(MUTATION_TIMEOUT_MS, 30_000 + items * 5_000)
    }

    function ApiError(code, message, details) {
      this.name = 'ApiError'
      this.code = code
      this.message = message
      this.details = details ?? null
    }
    ApiError.prototype = Object.create(Error.prototype)
    ApiError.prototype.constructor = ApiError

    async function api(path, options = {}) {
      const method = options.method ?? 'GET'
      const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : REQUEST_TIMEOUT_MS
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const base = typeof document !== 'undefined' && typeof document.baseURI === 'string' ? document.baseURI : 'http://127.0.0.1/'
        const url = new URL(`${API_PREFIX}${path}`, base)
        const headers = { 'x-conversation-recycle-bin': '1' }
        if (options.body !== undefined) headers['content-type'] = 'application/json'
        const response = await fetch(url, {
          method,
          headers,
          credentials: 'same-origin',
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        })
        let payload = null
        try {
          payload = await response.json()
        } catch {
          payload = null
        }
        if (payload === null || typeof payload !== 'object') {
          throw new ApiError('E_BAD_RESPONSE', 'The Host returned an unreadable response.')
        }
        // A batch that partially succeeded is a RESULT, not a refusal: an older
        // Host marked it `ok:false` without an `error`, which made the Client
        // throw E_INTERNAL and hide the sessions that were already deleted.
        const partial = Array.isArray(payload.results) && Array.isArray(payload.failures)
        if (response.ok !== true || (payload.ok === false && partial !== true)) {
          const wire = payload.error ?? {}
          throw new ApiError(wire.code ?? 'E_INTERNAL', wire.message ?? 'The Host refused the request.', wire.details)
        }
        return payload
      } catch (error) {
        if (error?.name === 'AbortError') throw new ApiError('E_TIMEOUT', 'The Host did not answer in time.')
        if (error instanceof ApiError) throw error
        throw new ApiError('E_INTERNAL', error instanceof Error ? error.message : String(error))
      } finally {
        clearTimeout(timer)
      }
    }

    /* ------------------------------------------------------------------ *
     * Overlay store + flash messages
     * ------------------------------------------------------------------ */

    const dialogStore = {
      state: null,
      listeners: new Set(),
      open(payload) {
        this.state = payload
        for (const listener of this.listeners) listener(this.state)
      },
      close() {
        this.state = null
        for (const listener of this.listeners) listener(this.state)
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }

    const flashStore = {
      message: null,
      listeners: new Set(),
      show(message) {
        this.message = message
        for (const listener of this.listeners) listener(this.message)
        setTimeout(() => {
          if (this.message === message) {
            this.message = null
            for (const listener of this.listeners) listener(null)
          }
        }, 4_000)
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }

    function useDialogState() {
      const [state, setState] = useState(dialogStore.state)
      useEffect(() => dialogStore.subscribe(setState), [])
      return state
    }

    /**
     * Notification channel for "a mutation changed the session list". The
     * dialog refreshes the shell, but the Settings section owns a second copy
     * of the list; without this it kept showing deleted rows until a manual
     * refresh (0.1.4 stopped reloading the page, which used to hide the bug).
     */
    const mutationStore = {
      version: 0,
      listeners: new Set(),
      bump() {
        this.version += 1
        for (const listener of this.listeners) listener(this.version)
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }

    function useMutationVersion() {
      const [version, setVersion] = useState(mutationStore.version)
      useEffect(() => mutationStore.subscribe(setVersion), [])
      return version
    }

    /**
     * Host UI flags (`ui.showRowAction` / `ui.showHeaderAction`) used to be
     * dead configuration: the client registered both slots unconditionally.
     */
    const uiFlagsStore = {
      loaded: false,
      flags: { showRowAction: true, showHeaderAction: true, enabled: true },
      listeners: new Set(),
      set(flags) {
        this.flags = flags
        this.loaded = true
        for (const listener of this.listeners) listener(this.flags)
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }

    function useUiFlags() {
      const [flags, setFlags] = useState(uiFlagsStore.flags)
      useEffect(() => uiFlagsStore.subscribe(setFlags), [])
      return flags
    }

    let uiFlagsLoading = false
    async function loadUiFlags() {
      if (uiFlagsStore.loaded || uiFlagsLoading || typeof fetch !== 'function') return
      // No real document (unit harness): there is nothing to ask the Host for.
      if (typeof document === 'undefined' || typeof document.baseURI !== 'string') return
      uiFlagsLoading = true
      try {
        const response = await api('/state')
        const ui = response?.state?.ui
        uiFlagsStore.set({
          showRowAction: ui?.showRowAction !== false,
          showHeaderAction: ui?.showHeaderAction !== false,
          enabled: response?.state?.enabled !== false,
        })
      } catch {
        // Defaults keep both entries visible; a failed probe is not fatal.
      } finally {
        uiFlagsLoading = false
      }
    }

    function useFlashMessage() {
      const [message, setMessage] = useState(flashStore.message)
      useEffect(() => flashStore.subscribe(setMessage), [])
      return message
    }

    function reloadApp(delay = 900) {
      if (typeof window === 'undefined' || typeof window.location?.reload !== 'function') return
      window.setTimeout(() => window.location.reload(), delay)
    }

    function service(name) {
      if (runtimeCtx === null || typeof runtimeCtx.get !== 'function') return undefined
      try {
        return runtimeCtx.get(name) ?? undefined
      } catch {
        return undefined
      }
    }

    function openSessionId() {
      const workspace = service('uiWorkspace')
      try {
        const snapshot = workspace?.selection?.getSnapshot?.()
        const id = snapshot?.sessionId
        if (typeof id === 'string' && id !== '') return id
      } catch {
        // fall through: an unknown selection simply skips the close step
      }
      return undefined
    }

    /**
     * Update the shell in place after a mutation instead of reloading the page.
     *
     * The Host session list has no delete push, so it is pulled explicitly; the
     * workspace archived/membership snapshot follows the Host stream. When the
     * deleted conversation is the one on screen, the shell must close it: it
     * would otherwise render a conversation whose log was just moved away.
     * `reloadApp` stays only as a fallback for hosts whose client service is
     * missing or fails, so a deletion can never leave a stale list behind.
     */
    async function refreshAfterMutation(options = {}) {
      const sessionIds = Array.isArray(options.sessionIds) ? options.sessionIds : []
      const closeCurrent = options.closeCurrent !== false
      const fallbackDelay = Number.isFinite(options.fallbackDelay) ? options.fallbackDelay : 900
      const current = openSessionId()
      const sessions = service('sessions')
      let refreshed = false
      if (sessions !== undefined && typeof sessions.refresh === 'function') {
        try {
          await sessions.refresh()
          refreshed = true
        } catch (error) {
          console.warn('[conversation-recycle-bin] session list refresh failed', error)
        }
      }
      if (closeCurrent && current !== undefined && sessionIds.includes(current)) {
        const workspace = service('uiWorkspace')
        let cleared = false
        try {
          if (workspace !== undefined && typeof workspace.clearArchivedCurrent === 'function') {
            cleared = workspace.clearArchivedCurrent() === true
          }
        } catch {
          cleared = false
        }
        if (cleared !== true) {
          try {
            if (workspace !== undefined && typeof workspace.clearMain === 'function') workspace.clearMain()
            else {
              // Neither private method exists on this host (they are declared
              // private by dsh-client-ui-workspace). `sessions.refresh()`
              // succeeded, so without this the shell would keep rendering a
              // conversation whose log was just moved away.
              console.warn('[conversation-recycle-bin] the host cannot close the current conversation in place; reloading')
              refreshed = false
            }
          } catch {
            refreshed = false
          }
        }
      }
      if (!refreshed) reloadApp(fallbackDelay)
      if (options.notify !== false) mutationStore.bump()
      return refreshed
    }

    /* ------------------------------------------------------------------ *
     * Small presentational pieces
     * ------------------------------------------------------------------ */

    function GlyphTrash({ size = 14 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('path', { d: 'M4 7h16' }),
      h('path', { d: 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2' }),
      h('path', { d: 'M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13' }),
      h('path', { d: 'M10 11v6M14 11v6' }))
    }

    function GlyphRefresh({ size = 14 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('path', { d: 'M20 12a8 8 0 1 1-2.3-5.7' }),
      h('path', { d: 'M20 4v5h-5' }))
    }

    function Button({ children, onClick, variant = 'secondary', disabled = false, type = 'button', title }) {
      return h('button', {
        type,
        className: `dc-btn dc-btn-${variant}`,
        onClick,
        disabled,
        title,
      }, children)
    }

    function Checkbox({ checked, onChange, disabled = false, label, hint }) {
      return h('label', { className: `dc-check${disabled ? ' dc-disabled' : ''}` },
        h('input', { type: 'checkbox', checked, disabled, onChange: (event) => onChange(event.target.checked) }),
        h('span', { className: 'dc-check-text' },
          h('span', { className: 'dc-check-label' }, label),
          hint === undefined ? null : h('span', { className: 'dc-hint' }, hint)))
    }

    function Spinner({ label }) {
      return h('div', { className: 'dc-loading', role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'dc-spinner', 'aria-hidden': 'true' }),
        h('span', null, label))
    }

    function ErrorBanner({ error }) {
      if (error === null || error === undefined) return null
      return h('div', { className: 'dc-error', role: 'alert' }, errorText(error))
    }

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '—'
      const units = ['B', 'KB', 'MB', 'GB']
      let value = bytes
      let index = 0
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024
        index += 1
      }
      return `${value < 10 && index > 0 ? value.toFixed(1) : Math.round(value)} ${units[index]}`
    }

    function formatTime(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      try {
        return new Date(value).toLocaleString()
      } catch {
        return String(value)
      }
    }

    /* ------------------------------------------------------------------ *
     * Confirmation dialog
     * ------------------------------------------------------------------ */

    function DeleteDialog({ payload }) {
      useLocaleTick()
      const sessionIds = payload.sessionIds
      const count = sessionIds.length
      const fallbackTitle = payload.displayTitle ?? ''
      const [mode, setMode] = useState('soft')
      const [includeMemory, setIncludeMemory] = useState(false)
      const [preview, setPreview] = useState(null)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [phrase, setPhrase] = useState('')
      const [done, setDone] = useState(null)
      const requestRef = useRef(0)

      const load = useCallback(async (nextMode, nextMemory, options = {}) => {
        const serial = (requestRef.current += 1)
        setLoading(true)
        if (options.preserveError !== true) setError(null)
        try {
          const response = await api('/preview', { method: 'POST', body: { sessionIds, includeMemory: nextMemory, mode: nextMode } })
          if (serial !== requestRef.current) return
          setPreview(response.preview)
          // A reload after a failed submit keeps the typed phrase: the plan did
          // not change, and retyping a batch size on every rate-limit/expiry is
          // pure friction. Switching mode or memory still clears it below.
          if (options.preservePhrase !== true) setPhrase('')
        } catch (caught) {
          if (serial !== requestRef.current) return
          if (options.preserveError !== true) {
            setError(caught)
            setPreview(null)
          }
        } finally {
          if (serial === requestRef.current) setLoading(false)
        }
      }, [sessionIds.join('\u0000')])

      useEffect(() => {
        void load(mode, includeMemory)
      }, [mode, includeMemory, load])

      useEffect(() => {
        function onKey(event) {
          if (event.key === 'Escape' && busy !== true) dialogStore.close()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [busy])

      const firstSession = preview?.sessions?.[0] ?? null
      const title = count === 1
        ? (firstSession?.title || fallbackTitle || sessionIds[0])
        : ''
      const blocked = Array.isArray(preview?.blocked) ? preview.blocked : []
      const confirmation = preview?.confirmation ?? null
      const expectedPhrase = confirmation?.phrase ?? ''
      const phraseOk = expectedPhrase === '' || phrase.trim() === expectedPhrase
      const memory = preview?.memory ?? null
      const memorySupported = memory !== null && memory.enabled === true
        && Array.isArray(memory.adapters) && memory.adapters.some((adapter) => adapter.available === true)
      const memoryDeletable = memorySupported && preview?.memory?.deleteMode === 'trash'
      const liveCount = Array.isArray(preview?.sessions) ? preview.sessions.filter((item) => item.live === true).length : 0

      const blockedMessage = blocked.length === 0
        ? null
        : (blocked[0].policy?.code === 'E_NOT_FOUND' ? t('dialog.noSession') : t('dialog.blocked', { message: errorText(blocked[0].policy) }))

      async function submit() {
        if (confirmation === null || busy) return
        setBusy(true)
        setError(null)
        try {
          const result = await api('/delete', {
            method: 'POST',
            timeoutMs: mutationTimeoutMs(sessionIds.length),
            body: {
              sessionIds,
              includeMemory,
              mode,
              confirmToken: confirmation.token,
              confirmPhrase: phrase.trim(),
            },
          })
          const failures = Array.isArray(result.failures) ? result.failures : []
          // Only successfully committed sessions may close the open view; a
          // failed item in the same batch leaves its conversation on screen.
          const deletedIds = (result.results ?? [])
            .map((item) => item?.sessionId)
            .filter((id) => typeof id === 'string')
          if (failures.length > 0) {
            const memoryTotal = (result.results ?? []).reduce((sum, item) => sum + (item.memory ?? 0), 0)
            setDone({ count: (result.results ?? []).length, memory: memoryTotal, failed: failures.length, failures })
            setBusy(false)
            if (deletedIds.length > 0) void refreshAfterMutation({ sessionIds: deletedIds })
            return
          }
          const memoryTotal = (result.results ?? []).reduce((sum, item) => sum + (item.memory ?? 0), 0)
          setDone({ count: (result.results ?? []).length, memory: memoryTotal, failed: 0 })
          setBusy(false)
          if (deletedIds.length > 0) void refreshAfterMutation({ sessionIds: deletedIds })
        } catch (caught) {
          setError(caught)
          setBusy(false)
          // The token is single-use only after a successful phrase + rate check;
          // a failed transaction leaves it usable, but counts may have changed
          // on disk, so refresh the plan. Keep the failure visible: clearing the
          // error inside load() made a failed delete look like a dead button.
          void load(mode, includeMemory, { preserveError: true, preservePhrase: true })
        }
      }

      if (done !== null) {
        return h('div', { className: 'dc-backdrop' },
          h('div', { className: 'dc-dialog', role: 'dialog', 'aria-modal': 'true' },
            h('h2', { className: 'dc-dialog-title' }, t('dialog.done', { count: done.count, memory: done.memory })),
            done.failed > 0 ? h('p', { className: 'dc-error-text' }, t('dialog.partial', { done: done.count, failed: done.failed })) : null,
            done.failed > 0 && Array.isArray(done.failures)
              ? h('ul', { className: 'dc-failures' }, ...done.failures.map((item, index) => h('li', {
                key: `${item?.sessionId ?? 'item'}-${index}`,
              }, `${item?.sessionId ?? '—'}: ${errorText(item?.error)}`)))
              : null,
            h('p', { className: 'dc-hint' }, t('dialog.reloadHint')),
            h('div', { className: 'dc-actions' },
              h(Button, { variant: 'primary', onClick: () => { dialogStore.close() } }, t('action.close')))))
      }

      return h('div', {
        className: 'dc-backdrop',
        onMouseDown: (event) => { if (event.target === event.currentTarget && busy !== true) dialogStore.close() },
      },
      h('div', { className: 'dc-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dc-dialog-title' },
        h('h2', { id: 'dc-dialog-title', className: 'dc-dialog-title' },
          count === 1 ? t('dialog.titleOne') : t('dialog.titleMany', { count })),
        h('p', { className: 'dc-dialog-body' },
          count === 1 ? t('dialog.bodyOne', { title }) : t('dialog.bodyMany', { count })),

        loading ? h(Spinner, { label: t('dialog.loading') }) : null,
        h(ErrorBanner, { error }),
        blockedMessage !== null ? h('div', { className: 'dc-error', role: 'alert' }, blockedMessage) : null,

        !loading && preview !== null ? h('div', { className: 'dc-section' },
          firstSession !== null && count === 1
            ? h('div', { className: 'dc-meta' }, t('dialog.records', {
              events: firstSession.events ?? '—',
              size: formatBytes(firstSession.sizeBytes),
            }))
            : null,

          h('div', { className: 'dc-modes', role: 'radiogroup', 'aria-label': t('dialog.modeSoft') },
            h('label', { className: 'dc-mode' },
              h('input', {
                type: 'radio', name: 'dc-mode', value: 'soft', checked: mode === 'soft',
                onChange: () => setMode('soft'), disabled: busy,
              }),
              h('span', null,
                h('span', { className: 'dc-mode-title' }, t('dialog.modeSoft')),
                h('span', { className: 'dc-hint' }, t('dialog.modeSoftHint')))),
            h('label', { className: 'dc-mode' },
              h('input', {
                type: 'radio', name: 'dc-mode', value: 'hard', checked: mode === 'hard',
                onChange: () => setMode('hard'), disabled: busy,
              }),
              h('span', null,
                h('span', { className: 'dc-mode-title' }, t('dialog.modeHard')),
                h('span', { className: 'dc-hint' }, t('dialog.modeHardHint'))))),

          liveCount > 0 && mode === 'hard'
            ? h('div', { className: 'dc-live-warning', role: 'status' }, t('dialog.liveStopHint'))
            : null,

          h('div', { className: 'dc-memory' },
            h(Checkbox, {
              checked: includeMemory,
              disabled: busy || memoryDeletable !== true,
              onChange: (value) => setIncludeMemory(value),
              label: t('dialog.memoryLabel'),
              hint: memory === null
                ? undefined
                : memoryDeletable !== true
                  ? (memory.enabled !== true ? t('dialog.memoryDisabled') : t('dialog.memoryKeep'))
                  : t('dialog.memoryHint'),
            }),
            memory !== null ? h('div', { className: 'dc-memory-count' },
              memorySupported
                ? (memory.total > 0
                  ? (includeMemory
                    ? t('dialog.memoryCount', { count: memory.total })
                    : t('dialog.memoryFound', { count: memory.total }))
                  : t('dialog.memoryNone'))
                : t('dialog.memoryUnsupported', { reason: reasonForUnavailable(memory) }),
              memorySupported && memory.protected > 0
                ? h('span', { className: 'dc-hint' }, ` · ${t('dialog.memoryProtected', { count: memory.protected })}`)
                : null) : null),

          expectedPhrase !== ''
            ? h('label', { className: 'dc-phrase' },
              h('span', { className: 'dc-phrase-label' },
                mode === 'hard' && count > 1
                  ? t('dialog.batchWarning', { count })
                  : mode === 'hard' ? t('dialog.hardWarning') : t('dialog.batchWarning', { count })),
              h('input', {
                type: 'text',
                value: phrase,
                onChange: (event) => setPhrase(event.target.value),
                placeholder: expectedPhrase,
                disabled: busy,
                autoFocus: true,
                className: 'dc-input',
              }))
            : null,

          h('div', { className: 'dc-actions' },
            h(Button, { onClick: () => { void load(mode, includeMemory) }, disabled: busy || loading, title: t('action.refresh') },
              h(GlyphRefresh, { size: 13 }), ' ', t('action.refresh')),
            h(Button, { onClick: () => dialogStore.close(), disabled: busy }, t('action.cancel')),
            h(Button, {
              variant: 'danger',
              onClick: () => { void submit() },
              disabled: busy || loading || blocked.length > 0 || confirmation === null || phraseOk !== true,
            }, busy ? t('dialog.working') : t('dialog.delete'))))
        : null))
    }

    function reasonForUnavailable(memory) {
      const adapters = Array.isArray(memory?.adapters) ? memory.adapters : []
      const first = adapters.find((adapter) => adapter.available === false && typeof adapter.reason === 'string' && adapter.reason !== '')
      if (first !== undefined) return first.reason
      const stores = Array.isArray(memory?.stores) ? memory.stores : []
      const store = stores.find((item) => item.available === false && typeof item.reason === 'string')
      return store?.reason ?? 'not detected'
    }

    /* ------------------------------------------------------------------ *
     * Dialog host / overlay entry
     * ------------------------------------------------------------------ */

    function DialogHost() {
      const payload = useDialogState()
      const flash = useFlashMessage()
      return h(React.Fragment, null,
        payload === null ? null : h(DeleteDialog, { payload, key: payload.key ?? payload.sessionIds.join(',') }),
        flash === null ? null : h('div', { className: 'dc-toast', role: 'status' }, flash))
    }

    /* ------------------------------------------------------------------ *
     * Session row + header triggers
     * ------------------------------------------------------------------ */

    function DeleteMenuRow(props) {
      useLocaleTick()
      const flags = useUiFlags()
      const sessionId = props.sessionId
      const displayTitle = props.displayTitle ?? ''
      // Hook order must stay stable when the flag flips at runtime, so the
      // menu state is read before the visibility check.
      const menu = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState() : null
      if (flags.showRowAction !== true || flags.enabled === false) return null
      const closeMenu = () => {
        try {
          menu?.[1]?.(false)
        } catch {
          // A menu that already closed is fine.
        }
      }
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'dc-menu-item dc-danger',
        onClick: () => {
          closeMenu()
          dialogStore.open({ sessionIds: [sessionId], displayTitle, key: `${sessionId}:menu` })
        },
      },
      h('span', { className: 'dc-menu-icon' }, h(GlyphTrash, { size: 14 })),
      h('span', { className: 'dc-menu-text' }, t('action.menuDelete')))
    }

    function HeaderDeleteAction(props) {
      useLocaleTick()
      const flags = useUiFlags()
      const sessionId = props.sessionId
      if (flags.showHeaderAction !== true || flags.enabled === false) return null
      // The title is read from the Host preview (projection cache), not from a
      // client selector: this keeps the entry safe on hosts where the standard
      // `useSession` shape differs.
      return h('button', {
        type: 'button',
        className: 'dc-header-action',
        title: t('action.headerDelete'),
        'aria-label': t('action.headerDelete'),
        onClick: () => dialogStore.open({ sessionIds: [sessionId], displayTitle: '', key: `${sessionId}:header` }),
      }, h(GlyphTrash, { size: 15 }))
    }

    /* ------------------------------------------------------------------ *
     * Settings section: recycle bin, batch deletion, audit trail
     * ------------------------------------------------------------------ */

    /**
     * Entries that never committed. Kept as its own component so the element
     * tree can be built (and smoke-tested) without a live Settings page.
     */
    function IncompleteEntries({ entries, discardTarget, discardPhrase, onPhrase, onStart, onCancel, onDiscard }) {
      return h('div', { className: 'dc-panel dc-incomplete' },
        h('div', { className: 'dc-state-title' }, `${t('trash.incompleteTitle')} (${entries.length})`),
        h('p', { className: 'dc-hint' }, t('trash.incompleteHint')),
        ...entries.map((entry) => h('div', { key: entry.trashId, className: 'dc-row' },
          h('div', { className: 'dc-row-main' },
            h('div', { className: 'dc-row-title' }, entry.title || entry.sessionId),
            h('div', { className: 'dc-hint' },
              `${t(`trash.status.${entry.status}`)} · ${formatTime(entry.updatedAt ?? entry.deletedAt)} · ${t('trash.items', { sessions: 1, memories: entry.memory ?? 0 })}`)),
          h('div', { className: 'dc-row-actions' },
            discardTarget === entry.trashId
              ? h('span', { className: 'dc-inline-confirm' },
                h('input', {
                  type: 'text',
                  value: discardPhrase,
                  placeholder: 'DELETE',
                  className: 'dc-input dc-input-small',
                  onChange: (event) => onPhrase(event.target.value),
                }),
                h(Button, {
                  variant: 'danger',
                  disabled: discardPhrase.trim() !== 'DELETE',
                  onClick: () => onDiscard(entry.trashId),
                }, t('trash.discard')),
                h(Button, { onClick: onCancel }, t('action.cancel')))
              : h(Button, {
                onClick: () => onStart(entry.trashId),
                title: t('trash.confirmDiscard'),
              }, t('trash.discard'))))))
    }

    function SettingsSection() {
      useLocaleTick()
      const mutationVersion = useMutationVersion()
      const [tab, setTab] = useState('trash')
      const [state, setState] = useState(null)
      const [sessions, setSessions] = useState([])
      const [trash, setTrash] = useState([])
      const [incomplete, setIncomplete] = useState([])
      const [audit, setAudit] = useState([])
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [selected, setSelected] = useState(() => new Set())
      const [purgeTarget, setPurgeTarget] = useState(null)
      const [purgePhrase, setPurgePhrase] = useState('')
      const [discardTarget, setDiscardTarget] = useState(null)
      const [discardPhrase, setDiscardPhrase] = useState('')

      const refresh = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
          const [stateResponse, sessionsResponse, trashResponse, auditResponse] = await Promise.all([
            api('/state'),
            api('/sessions'),
            api('/trash'),
            api('/audit?limit=50'),
          ])
          const nextSessions = Array.isArray(sessionsResponse.sessions) ? sessionsResponse.sessions : []
          setState(stateResponse.state)
          setSessions(nextSessions)
          setTrash(Array.isArray(trashResponse.entries) ? trashResponse.entries : [])
          setIncomplete(Array.isArray(trashResponse.incomplete) ? trashResponse.incomplete : [])
          setAudit(Array.isArray(auditResponse.records) ? auditResponse.records : [])
          // Drop selections whose conversation no longer exists.
          setSelected((current) => {
            const alive = new Set(nextSessions.map((session) => session.id))
            const next = new Set([...current].filter((id) => alive.has(id)))
            return next.size === current.size ? current : next
          })
        } catch (caught) {
          setError(caught)
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => { void refresh() }, [refresh])

      // A deletion or restore performed from the dialog must also update this
      // section's own session/trash copies.
      useEffect(() => {
        if (mutationVersion > 0) void refresh()
      }, [mutationVersion, refresh])

      async function restore(trashId) {
        setError(null)
        const entry = trash.find((item) => item.trashId === trashId)
        try {
          await api('/trash/restore', { method: 'POST', body: { trashId } })
          flashStore.show(t('trash.restored'))
          await refresh()
          await refreshAfterMutation({
            sessionIds: typeof entry?.sessionId === 'string' ? [entry.sessionId] : [],
            closeCurrent: false,
            notify: false,
          })
        } catch (caught) {
          setError(caught)
        }
      }

      async function purge(trashId, phrase) {
        setError(null)
        const entry = trash.find((item) => item.trashId === trashId)
        try {
          await api('/trash/purge', { method: 'POST', body: { trashId, confirmPhrase: phrase } })
          flashStore.show(t('trash.purged'))
          setPurgeTarget(null)
          setPurgePhrase('')
          await refresh()
          // Purging a soft entry detaches the session from its workspace.
          await refreshAfterMutation({
            sessionIds: typeof entry?.sessionId === 'string' ? [entry.sessionId] : [],
            closeCurrent: false,
            notify: false,
          })
        } catch (caught) {
          setError(caught)
        }
      }

      async function discard(trashId, phrase) {
        setError(null)
        try {
          await api('/trash/discard', { method: 'POST', body: { trashId, confirmPhrase: phrase } })
          flashStore.show(t('trash.discarded'))
          setDiscardTarget(null)
          setDiscardPhrase('')
          await refresh()
        } catch (caught) {
          setError(caught)
        }
      }

      function toggle(id) {
        setSelected((current) => {
          const next = new Set(current)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      const selectedIds = useMemo(() => [...selected], [selected])
      const effectiveBatch = Number.isFinite(state?.limits?.effectiveBatch)
        ? state.limits.effectiveBatch
        : (state?.limits?.maxBatchSessions ?? 0)
      const overLimit = effectiveBatch > 0 && selectedIds.length > effectiveBatch

      return h('div', { className: 'dc-root' },
        h('div', { className: 'dc-header' },
          h('div', null,
            h('h1', { className: 'dc-title' }, t('section.title')),
            h('p', { className: 'dc-hint' }, t('section.subtitle'))),
          h(Button, { onClick: () => { void refresh() }, disabled: loading, title: t('action.refresh') },
            h(GlyphRefresh, { size: 13 }), ' ', t('action.refresh'))),

        h(ErrorBanner, { error }),

        state !== null ? h('div', { className: 'dc-state' },
          h('div', { className: 'dc-state-block' },
            h('div', { className: 'dc-state-title' }, t('state.memory')),
            ...(state.memory?.adapters ?? []).map((adapter) => h('div', {
              key: adapter.id,
              className: 'dc-state-row',
            },
            h('span', { className: adapter.available ? 'dc-ok' : 'dc-off' }, adapter.available ? '●' : '○'),
            h('span', null, ` ${adapter.label ?? adapter.id} `),
            h('span', { className: 'dc-hint' }, adapter.available ? t('state.available') : `${t('state.unavailable')} — ${adapter.reason ?? ''}`)))),
          h('div', { className: 'dc-state-block' },
            h('div', { className: 'dc-state-title' }, t('state.limits')),
            h('div', { className: 'dc-hint' },
              t('state.rate', {
                used: state.limits?.rate?.used ?? 0,
                limit: state.limits?.rate?.limit ?? state.limits?.maxDeletesPerMinute ?? 0,
              })),
            h('div', { className: 'dc-hint' }, t('state.batch', { limit: effectiveBatch > 0 ? effectiveBatch : '—' })))) : null,

        h('div', { className: 'dc-tabs', role: 'tablist' },
          h('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'trash', className: `dc-tab${tab === 'trash' ? ' dc-tab-active' : ''}`, onClick: () => setTab('trash') }, t('trash.title')),
          h('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'batch', className: `dc-tab${tab === 'batch' ? ' dc-tab-active' : ''}`, onClick: () => setTab('batch') }, t('batch.title')),
          h('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'audit', className: `dc-tab${tab === 'audit' ? ' dc-tab-active' : ''}`, onClick: () => setTab('audit') }, t('audit.title'))),

        loading ? h(Spinner, { label: t('dialog.loading') }) : null,

        tab === 'trash' && !loading ? h('div', { className: 'dc-panel' },
          trash.length === 0 ? h('div', { className: 'dc-empty' }, t('trash.empty')) : null,
          ...trash.map((entry) => h('div', { key: entry.trashId, className: 'dc-row' },
            h('div', { className: 'dc-row-main' },
              h('div', { className: 'dc-row-title' }, entry.title || entry.sessionId),
              h('div', { className: 'dc-hint' },
                `${t('trash.deletedAt', { time: formatTime(entry.deletedAt) })} · ${entry.mode === 'hard' ? t('trash.modeHard') : t('trash.modeSoft')} · ${t('trash.items', { sessions: 1, memories: entry.memory ?? 0 })}`)),
            h('div', { className: 'dc-row-actions' },
              h(Button, { onClick: () => { void restore(entry.trashId) } }, t('action.restore')),
              purgeTarget === entry.trashId
                ? h('span', { className: 'dc-inline-confirm' },
                  h('input', {
                    type: 'text', value: purgePhrase, placeholder: 'DELETE', className: 'dc-input dc-input-small',
                    onChange: (event) => setPurgePhrase(event.target.value),
                  }),
                  h(Button, {
                    variant: 'danger',
                    disabled: purgePhrase.trim() !== 'DELETE',
                    onClick: () => { void purge(entry.trashId, purgePhrase.trim()) },
                  }, t('action.purge')),
                  h(Button, { onClick: () => { setPurgeTarget(null); setPurgePhrase('') } }, t('action.cancel')))
                : h(Button, { variant: 'danger', onClick: () => { setPurgeTarget(entry.trashId); setPurgePhrase('') } }, t('action.purge')))))) : null,

        tab === 'trash' && !loading && incomplete.length > 0 ? h(IncompleteEntries, {
          entries: incomplete,
          discardTarget,
          discardPhrase,
          onPhrase: setDiscardPhrase,
          onStart: (trashId) => { setDiscardTarget(trashId); setDiscardPhrase('') },
          onCancel: () => { setDiscardTarget(null); setDiscardPhrase('') },
          onDiscard: (trashId) => { void discard(trashId, discardPhrase.trim()) },
        }) : null,

        tab === 'batch' && !loading ? h('div', { className: 'dc-panel' },
          h('div', { className: 'dc-batch-bar' },
            h('span', { className: 'dc-hint' }, t('batch.selected', { count: selectedIds.length })),
            h(Button, {
              onClick: () => setSelected(new Set(sessions.map((session) => session.id))),
            }, t('action.selectAll')),
            h(Button, { onClick: () => setSelected(new Set()) }, t('action.clearAll')),
            h(Button, {
              variant: 'danger',
              disabled: selectedIds.length === 0 || overLimit,
              onClick: () => dialogStore.open({ sessionIds: selectedIds, displayTitle: '', key: `batch:${selectedIds.join(',')}` }),
            }, t('batch.deleteSelected'))),
          h('p', { className: 'dc-hint' }, t('batch.hint')),
          overLimit ? h('p', { className: 'dc-error-text' }, t('batch.overLimit', { limit: effectiveBatch })) : null,
          sessions.length === 0 ? h('div', { className: 'dc-empty' }, t('batch.empty')) : null,
          ...sessions.map((session) => h('label', { key: session.id, className: 'dc-row dc-row-select' },
            h('input', { type: 'checkbox', checked: selected.has(session.id), onChange: () => toggle(session.id) }),
            h('div', { className: 'dc-row-main' },
              h('div', { className: 'dc-row-title' }, session.title || session.id),
              h('div', { className: 'dc-hint' },
                `${session.cwd ?? '—'}${session.archived ? ' · archived' : ''}${session.live || session.running ? ' · live' : ''}`)),
            h('div', { className: 'dc-row-time' }, formatTime(session.updatedAt))))) : null,

        tab === 'audit' && !loading ? h('div', { className: 'dc-panel' },
          audit.length === 0 ? h('div', { className: 'dc-empty' }, t('audit.empty')) : null,
          ...audit.map((record) => h('div', { key: record.id, className: 'dc-row' },
            h('div', { className: 'dc-row-main' },
              h('div', { className: 'dc-row-title' },
                `${record.action ?? ''} · ${record.sessionId ?? (Array.isArray(record.sessionIds) ? record.sessionIds.join(', ') : '')}`),
              h('div', { className: 'dc-hint' },
                `${formatTime(record.at)} · ${t(`audit.${record.result ?? 'success'}`) ?? record.result ?? ''}`
                + (record.mode ? ` · ${record.mode}` : '')
                + (record.includeMemory ? ' · memory' : '')
                + (record.error?.message ? ` · ${record.error.message}` : ''))),
            h('div', { className: 'dc-row-time' }, record.actor ?? '')))) : null)
    }

    /* ------------------------------------------------------------------ *
     * Stylesheet (one element owned by this plugin's fiber)
     * ------------------------------------------------------------------ */

    const CSS = `
.dc-backdrop{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.38);padding:16px}
.dc-dialog{width:min(560px,94vw);max-height:88vh;overflow:auto;background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#1f2329);border:1px solid var(--dsw-alias-border-l1,#e5e6eb);border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,.28);padding:20px 20px 16px;font:inherit}
.dc-dialog-title{margin:0 0 8px;font-size:16px;font-weight:600;line-height:1.4}
.dc-dialog-body{margin:0 0 12px;font-size:13px;color:var(--dsw-alias-label-secondary,#646a73);line-height:1.6}
.dc-section{margin-top:10px}
.dc-meta{font-size:12px;color:var(--dsw-alias-label-secondary,#646a73);margin-bottom:10px}
.dc-modes{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
.dc-mode{display:flex;gap:9px;align-items:flex-start;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1,#e5e6eb);border-radius:9px;cursor:pointer;background:var(--dsw-alias-bg-layer-1,#f7f8fa)}
.dc-mode-preferred{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.dc-live-warning{margin-top:10px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-text-warning,#b26a00);background:var(--dsw-alias-fill-warning,#fff7e6)}
.dc-mode input{margin-top:3px}
.dc-mode-title{display:block;font-size:13px;font-weight:600}
.dc-hint{display:block;font-size:12px;color:var(--dsw-alias-label-secondary,#646a73);line-height:1.5;margin-top:2px}
.dc-memory{margin:12px 0;padding:10px;border:1px solid var(--dsw-alias-border-l1,#e5e6eb);border-radius:9px}
.dc-memory-count{font-size:12px;margin-top:6px;color:var(--dsw-alias-label-primary,#1f2329)}
.dc-check{display:flex;gap:8px;align-items:flex-start;cursor:pointer}
.dc-check.dc-disabled{opacity:.6;cursor:not-allowed}
.dc-check input{margin-top:3px}
.dc-check-text{min-width:0}
.dc-check-label{display:block;font-size:13px;font-weight:500}
.dc-phrase{display:block;margin:12px 0}
.dc-phrase-label{display:block;font-size:12px;color:var(--dsw-alias-state-warn-primary,#d46b08);margin-bottom:5px;line-height:1.5}
.dc-input{width:100%;box-sizing:border-box;height:32px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2,#c9cdd4);border-radius:7px;background:var(--dsw-alias-bg-base,#fff);color:inherit;font:inherit;font-size:13px}
.dc-input-small{width:90px;height:28px}
.dc-actions{display:flex;gap:8px;justify-content:flex-end;align-items:center;margin-top:14px;flex-wrap:wrap}
.dc-btn{height:30px;padding:0 12px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,#c9cdd4);background:var(--dsw-alias-bg-layer-1,#f7f8fa);color:var(--dsw-alias-label-primary,#1f2329);font:inherit;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:5px}
.dc-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#eff0f2)}
.dc-btn:disabled{opacity:.5;cursor:not-allowed}
.dc-btn-primary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}
.dc-btn-primary:hover:not(:disabled){filter:brightness(.94);background:var(--dsw-alias-brand-primary,#4d6bfe)}
.dc-btn-danger{color:var(--dsw-alias-state-error-primary,#d93026);border-color:var(--dsw-alias-state-error-primary,#d93026);background:transparent}
.dc-btn-danger:hover:not(:disabled){background:rgba(217,48,38,.08)}
.dc-error{font-size:12px;line-height:1.55;padding:8px 10px;border-radius:8px;margin:8px 0;color:var(--dsw-alias-state-error-primary,#d93026);background:rgba(217,48,38,.08);border:1px solid rgba(217,48,38,.28)}
.dc-error-text{font-size:12px;color:var(--dsw-alias-state-error-primary,#d93026);margin:6px 0}
.dc-failures{margin:6px 0 0;padding-left:18px;font-size:12px;line-height:1.6;color:var(--dsw-alias-state-error-primary,#d93026)}
.dc-incomplete{margin-top:14px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1,#e5e6eb)}
.dc-loading{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#646a73);padding:8px 0}
.dc-spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2,#c9cdd4);border-top-color:var(--dsw-alias-brand-primary,#4d6bfe);animation:dc-spin .8s linear infinite;display:inline-block}
@keyframes dc-spin{to{transform:rotate(360deg)}}
.dc-menu-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f2329);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.dc-menu-item:hover{background:var(--dsw-alias-bg-layer-2,#eff0f2)}
.dc-menu-item.dc-danger{color:var(--dsw-alias-state-error-primary,#d93026)}
.dc-menu-item.dc-danger:hover{background:rgba(217,48,38,.1)}
.dc-menu-icon{display:inline-flex;align-items:center}
.dc-header-action{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#646a73);cursor:pointer}
.dc-header-action:hover{background:var(--dsw-alias-bg-layer-2,#eff0f2);color:var(--dsw-alias-state-error-primary,#d93026)}
.dc-root{padding:18px 22px 32px;max-width:900px;font:inherit;color:var(--dsw-alias-label-primary,#1f2329)}
.dc-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:14px}
.dc-title{font-size:17px;font-weight:600;margin:0}
.dc-state{display:flex;gap:24px;flex-wrap:wrap;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#e5e6eb);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#f7f8fa);margin-bottom:14px}
.dc-state-block{min-width:220px}
.dc-state-title{font-size:12px;font-weight:600;margin-bottom:4px}
.dc-state-row{font-size:12px;line-height:1.7}
.dc-ok{color:var(--dsw-alias-state-success-primary,#00a870)}
.dc-off{color:var(--dsw-alias-state-idle-primary,#8f959e)}
.dc-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e6eb);margin-bottom:12px}
.dc-tab{border:0;background:transparent;padding:8px 12px;font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary,#646a73);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.dc-tab-active{color:var(--dsw-alias-label-primary,#1f2329);border-bottom-color:var(--dsw-alias-brand-primary,#4d6bfe);font-weight:600}
.dc-panel{display:flex;flex-direction:column;gap:8px}
.dc-empty{padding:18px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary,#646a73)}
.dc-row{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#e5e6eb);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#f7f8fa)}
.dc-row-select{cursor:pointer}
.dc-row-main{min-width:0;flex:1}
.dc-row-title{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dc-row-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.dc-row-time{font-size:11px;color:var(--dsw-alias-label-secondary,#646a73);white-space:nowrap}
.dc-inline-confirm{display:flex;gap:6px;align-items:center}
.dc-batch-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px}
.dc-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:1200;background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#1f2329);border:1px solid var(--dsw-alias-border-l1,#e5e6eb);border-radius:9px;box-shadow:0 10px 30px rgba(0,0,0,.22);padding:9px 14px;font-size:12px;max-width:80vw}
`

    /* ------------------------------------------------------------------ *
     * Plugin entry
     * ------------------------------------------------------------------ */

    function apply(ctx) {
      runtimeCtx = ctx
      const slots = ctx.slots ?? (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
      if (slots === undefined || slots === null || typeof slots.inject !== 'function') {
        console.error('[conversation-recycle-bin] slots service unavailable; UI not registered')
        return
      }

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-dsh-plugin', NS)
        style.textContent = CSS
        document.head.appendChild(style)
        return () => {
          if (style.parentNode !== null) style.parentNode.removeChild(style)
        }
      })

      // `ui.showRowAction` / `ui.showHeaderAction` are real switches now; the
      // entries stay visible until the probe answers, so a failed /state call
      // never removes the feature.
      void loadUiFlags()

      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['locale'], (scope) => {
            localeService = scope.locale ?? null
          })
        } catch {
          // Pre-locale hosts keep the built-in dictionary.
        }
      }

      // The dialog lives in the overlay, not inside the menu item: the menu
      // item unmounts with its dropdown, which would take the dialog with it.
      ctx.effect(() => slots.inject('shell.overlay', () => slots.register({
        name: 'shell.overlay',
        id: 'conversation-recycle-bin-dialog',
        order: 50,
      }, () => h(DialogHost))))

      ctx.effect(() => slots.inject('sidebar.workspaces.session.menu.item', () => slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'conversation-recycle-bin',
        order: 500,
      }, (props) => h(DeleteMenuRow, props))))

      ctx.effect(() => slots.inject('conversation.session.header.actions', () => slots.register({
        name: 'conversation.session.header.actions',
        id: 'conversation-recycle-bin',
        order: 100,
      }, (props) => h(HeaderDeleteAction, props))))

      const hasLocaleService = peekLocaleService() !== null
      ctx.effect(() => slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'conversation-recycle-bin',
        order: 1300,
        // A thunk label is re-read on locale switches, but pre-locale shells
        // render the label string directly and would crash on a function.
        label: hasLocaleService ? () => t('section.label') : t('section.label'),
      }, () => h(SettingsSection))))
    }

    exports.name = 'conversation-recycle-bin'
    // Without this Cordis may run apply() before the slot service exists, and
    // the registration would silently never happen (no retry).
    exports.inject = ['slots']
    exports.apply = apply
    exports.__t = t
    exports.__errorText = errorText
    exports.__store = { dialogStore, flashStore, mutationStore, uiFlagsStore }
    exports.__refreshAfterMutation = refreshAfterMutation
    exports.__mutationTimeoutMs = mutationTimeoutMs
    exports.__api = api
    // Direct component handles keep the hook-level behavior testable without a
    // DOM renderer (the registered wrapper alone only builds an element).
    exports.__components = { DeleteMenuRow, HeaderDeleteAction, DeleteDialog, SettingsSection, IncompleteEntries }
    return module.exports
  },
})
