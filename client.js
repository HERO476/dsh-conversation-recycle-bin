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

    /*
     * `react-dom` is optional: without a portal the dialog still renders (in
     * the overlay slot), it just cannot escape the overlay layer's stacking
     * context. Probing instead of requiring keeps the module loadable on a
     * host that ships React without ReactDOM.
     */
    let createPortal = null
    try {
      const ReactDOM = require('react-dom')
      createPortal = ReactDOM?.createPortal ?? null
    } catch {
      createPortal = null
    }

    /** Render into `document.body` when possible (see DialogHost). */
    function portalIntoBody(element) {
      if (createPortal === null) return element
      if (typeof document === 'undefined' || document.body === null || document.body === undefined) return element
      try {
        return createPortal(element, document.body)
      } catch {
        return element
      }
    }

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
        'batch.selectAllDeletable': 'Select every conversation that can be deleted',
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
        'dialog.batchWarning': 'Type the number {count} to confirm this batch.',
        'dialog.liveStopHint': 'This conversation is open in a live agent. Permanent deletion stops it first, then removes its log.',
        'dialog.phraseLabel': 'Confirmation',
        'dialog.delete': 'Delete',
        'dialog.working': 'Deleting…',
        'dialog.stillWorking': 'Still working — confirming no other DSH instance is writing this conversation.',
        'dialog.hardGraceHint': 'Permanent deletion re-checks the log for a second writer first, so a conversation used moments ago can take about 1.5s longer.',
        'dialog.loading': 'Reading the plan…',
        'dialog.done': 'Deleted {count} conversation(s); {memory} memory entries moved to the recycle bin.',
        'dialog.partial': 'Deleted {done}, failed {failed}.',
        'dialog.noSession': 'The conversation no longer exists.',
        'dialog.blocked': 'This conversation cannot be deleted: {message}',
        'dialog.reloadHint': 'The conversation list refreshes when you close this dialog.',
        'trash.title': 'Recycle bin',
        'trash.empty': 'The recycle bin is empty.',
        'trash.deletedAt': 'Deleted {time}',
        'trash.retention': 'Entries are purged automatically {days} days after deletion. Set trashRetentionDays to 0 to keep them until you purge them yourself.',
        'trash.expiresIn': 'auto-purged in {days} d',
        'trash.expiresSoon': 'auto-purged on the next check',
        'trash.swept': 'The Host cleaned up {count} expired entries in the background.',
        'trash.modeSoft': 'soft',
        'trash.modeHard': 'permanent',
        'trash.items': '{sessions} conversation(s) · {memories} memory entries',
        'trash.confirmPurge': 'Type DELETE to permanently remove this entry.',
        'trash.restored': 'Restored.',
        'trash.purged': 'Permanently deleted.',
        'trash.incompleteTitle': 'Incomplete entries',
        'trash.incompleteHint': 'Entries that never committed. Discard them to free the space; an entry that still holds a conversation log must be restored or purged instead.',
        'trash.restoreIncompleteHint': 'Put the conversation log back and re-attach it to its workspace.',
        'trash.discard': 'Discard',
        'trash.discarded': 'Entry removed.',
        'trash.confirmDiscard': 'Type DELETE to discard this incomplete entry.',
        'trash.status.pending': 'pending',
        'trash.status.failed': 'failed',
        'trash.status.restoring': 'restoring',
        'trash.status.purging': 'purging',
        'trash.status.restored': 'restored',
        'trash.status.unreadable': 'unreadable manifest',
        'batch.title': 'Batch deletion',
        'batch.hint': 'Each conversation is its own transaction; a failure rolls only that conversation back.',
        'batch.selected': '{count} selected',
        'batch.deleteSelected': 'Delete selected…',
        'batch.empty': 'No conversations.',
        'batch.overLimit': 'The selection exceeds the current limit of {limit}.',
        'batch.notDeletable': 'cannot be deleted',
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
        'state.notDetected': 'not detected',
        'state.rate': '{used}/{limit} deletions this minute',
        'state.batch': 'Effective batch limit: {limit}',
        'feedback.button': 'Feedback',
        'feedback.bannerTitle': 'Ran into a problem or have an idea?',
        'feedback.bannerHint': 'Send one email to the maintainer. It carries your text plus the plugin version, platform and language — no conversation content.',
        'feedback.title': 'Send feedback',
        'feedback.intro': 'Tell the maintainer what went wrong or what you would like to see. The message is sent by email from this Host; nothing is uploaded anywhere else.',
        'feedback.categoryLabel': 'Type',
        'feedback.categoryBug': 'Problem / bug',
        'feedback.categorySuggestion': 'Suggestion',
        'feedback.categoryOther': 'Other',
        'feedback.titleLabel': 'Title',
        'feedback.titlePlaceholder': 'One line that summarises it',
        'feedback.bodyLabel': 'Message',
        'feedback.bodyPlaceholder': 'What happened, what you expected, and the steps that led to it.',
        'feedback.emailLabel': 'Your email (optional)',
        'feedback.emailPlaceholder': 'you@example.com',
        'feedback.emailHint': 'Used as Reply-To so the maintainer can answer you. Leave it empty to stay anonymous.',
        'feedback.emailHintAsFrom': 'Sent as the mail\'s From address. Most relays (QQ, 163, Gmail) reject this unless the mailbox matches the login account — enable only when the relay accepts arbitrary From.',
        'feedback.contextLabel': 'Attached automatically',
        'feedback.contextHint': 'Plugin version, platform and language. Conversation content is never attached.',
        'feedback.contextVersion': 'Plugin version',
        'feedback.contextPlatform': 'Platform',
        'feedback.contextLocale': 'Language',
        'feedback.send': 'Send',
        'feedback.sending': 'Sending…',
        'feedback.sent': 'Feedback sent. Thank you!',
        'feedback.tooShortTitle': 'The title needs at least {min} characters.',
        'feedback.tooLongTitle': 'The title may be at most {max} characters.',
        'feedback.tooShortBody': 'The message needs at least {min} characters.',
        'feedback.tooLongBody': 'The message may be at most {max} characters.',
        'feedback.invalidEmail': 'That does not look like an email address.',
        'feedback.tooLongEmail': 'The email address may be at most {max} characters.',
        'feedback.unavailable': 'The feedback channel is not configured on this Host.',
        'error.E_FEEDBACK_DISABLED': 'The feedback channel is not configured on this Host.',
        'error.E_FEEDBACK_INVALID': 'The feedback form is incomplete or too long.',
        'error.E_FEEDBACK_RATE_LIMITED': 'Several messages were sent recently; try again a little later.',
        'error.E_FEEDBACK_TRANSPORT': 'The message could not be delivered. Check the Host mail configuration and retry.',
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
        'error.E_LOCK_BUSY': 'Another DSH instance is using this recycle bin; retry in a moment.',
        'error.E_QUEUE_TIMEOUT': 'The Host was still busy with another change, so this request was not applied. Retry in a moment.',
        'error.E_ABANDONED': 'The page gave up waiting before the Host started; nothing was changed. Retry.',
        'error.E_UNAUTHORIZED': 'This request is not authenticated with the Host.',
        'adapter.lingshu': 'Lingshu cognitive graph (md_cg)',
        'adapter.generic-json': 'Generic JSON memory store',
        'adapter.none': 'No memory store',
        'adapter.reason.no-memory-store': 'No conversation-linked memory store was detected.',
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
        'batch.selectAllDeletable': '全选所有可删除的对话',
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
        'dialog.batchWarning': '批量删除需输入数字 {count} 确认。',
        'dialog.liveStopHint': '该对话仍在运行中；彻底删除会先停止它，再移除日志。',
        'dialog.phraseLabel': '确认',
        'dialog.delete': '删除',
        'dialog.working': '正在删除…',
        'dialog.stillWorking': '仍在执行：正在确认没有其他 DSH 实例写入该对话。',
        'dialog.hardGraceHint': '彻底删除会先复查日志是否还有第二个写入方；刚使用过的对话可能多等约 1.5 秒。',
        'dialog.loading': '正在读取删除计划…',
        'dialog.done': '已删除 {count} 个对话；移入回收站的记忆条目 {memory} 条。',
        'dialog.partial': '成功 {done} 个，失败 {failed} 个。',
        'dialog.noSession': '该对话已不存在。',
        'dialog.blocked': '该对话无法删除：{message}',
        'dialog.reloadHint': '关闭本对话框后会刷新会话列表。',
        'trash.title': '回收站',
        'trash.empty': '回收站为空。',
        'trash.deletedAt': '删除于 {time}',
        'trash.retention': '条目在删除 {days} 天后自动清理。把 trashRetentionDays 设为 0 可改为一直保留、由你自己彻底删除。',
        'trash.expiresIn': '{days} 天后自动清理',
        'trash.expiresSoon': '下次检查时自动清理',
        'trash.swept': 'Host 已在后台自动清理 {count} 条过期条目。',
        'trash.modeSoft': '软删除',
        'trash.modeHard': '彻底',
        'trash.items': '{sessions} 个对话 · {memories} 条记忆',
        'trash.confirmPurge': '输入 DELETE 彻底删除该条目。',
        'trash.restored': '已恢复。',
        'trash.purged': '已彻底删除。',
        'trash.incompleteTitle': '未完成条目',
        'trash.incompleteHint': '这些条目没有提交成功，可直接清理以释放空间；仍保存着会话日志的条目请先恢复或彻底删除。',
        'trash.restoreIncompleteHint': '把会话日志放回原位，并重新挂回它所属的工作区。',
        'trash.discard': '清理',
        'trash.discarded': '条目已清理。',
        'trash.confirmDiscard': '输入 DELETE 清理该未完成条目。',
        'trash.status.pending': '待处理',
        'trash.status.failed': '失败',
        'trash.status.restoring': '恢复中断',
        'trash.status.purging': '清理中断',
        'trash.status.restored': '已恢复',
        'trash.status.unreadable': '清单不可读',
        'batch.title': '批量删除',
        'batch.hint': '每个对话独立事务；失败时仅回滚该对话。',
        'batch.selected': '已选 {count} 个',
        'batch.deleteSelected': '删除所选…',
        'batch.empty': '没有对话。',
        'batch.overLimit': '所选数量超过当前上限 {limit} 个。',
        'batch.notDeletable': '无法删除',
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
        'state.notDetected': '未检测到',
        'state.rate': '本分钟已删除 {used}/{limit}',
        'state.batch': '单次上限：{limit} 个（受每分钟额度约束）',
        'feedback.button': '反馈',
        'feedback.bannerTitle': '遇到问题，或有改进建议？',
        'feedback.bannerHint': '写一条消息发给维护者，正文之外只附带插件版本、平台与语言，不含任何对话内容。',
        'feedback.title': '发送反馈',
        'feedback.intro': '把遇到的问题或想要的功能告诉维护者。消息由本机宿主通过邮件发送，不会上传到其他位置。',
        'feedback.categoryLabel': '类型',
        'feedback.categoryBug': '问题 / Bug',
        'feedback.categorySuggestion': '建议',
        'feedback.categoryOther': '其他',
        'feedback.titleLabel': '标题',
        'feedback.titlePlaceholder': '用一句话概括',
        'feedback.bodyLabel': '正文',
        'feedback.bodyPlaceholder': '发生了什么、预期是什么、如何复现。',
        'feedback.emailLabel': '你的邮箱（选填）',
        'feedback.emailPlaceholder': 'you@example.com',
        'feedback.emailHint': '作为 Reply-To，便于维护者直接回复你；留空即匿名。',
        'feedback.emailHintAsFrom': '会直接作为这封邮件的发件人（From）。QQ / 163 / Gmail 一类会拒收非登录账号的 From，只有允许任意 From 的中继才生效。',
        'feedback.contextLabel': '自动附带',
        'feedback.contextHint': '插件版本、平台与语言；不会附带任何对话内容。',
        'feedback.contextVersion': '插件版本',
        'feedback.contextPlatform': '平台',
        'feedback.contextLocale': '语言',
        'feedback.send': '发送',
        'feedback.sending': '正在发送…',
        'feedback.sent': '反馈已发送，谢谢！',
        'feedback.tooShortTitle': '标题至少需要 {min} 个字符。',
        'feedback.tooLongTitle': '标题最多 {max} 个字符。',
        'feedback.tooShortBody': '正文至少需要 {min} 个字符。',
        'feedback.tooLongBody': '正文最多 {max} 个字符。',
        'feedback.invalidEmail': '这看起来不是一个邮箱地址。',
        'feedback.tooLongEmail': '邮箱最多 {max} 个字符。',
        'feedback.unavailable': '当前宿主未配置反馈通道。',
        'error.E_FEEDBACK_DISABLED': '当前宿主未配置反馈通道。',
        'error.E_FEEDBACK_INVALID': '反馈内容不完整或超出长度限制。',
        'error.E_FEEDBACK_RATE_LIMITED': '最近已发送多条反馈，请稍后再试。',
        'error.E_FEEDBACK_TRANSPORT': '邮件发送失败，请检查宿主的邮件配置后重试。',
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
        'error.E_LOCK_BUSY': '另一个 DSH 实例正在使用回收站，请稍后重试。',
        'error.E_QUEUE_TIMEOUT': '宿主还在处理另一个变更，这次请求没有执行，请稍后重试。',
        'error.E_ABANDONED': '页面在宿主开始处理前就放弃了等待，本次没有做任何改动，请重试。',
        'error.E_UNAUTHORIZED': '该请求未通过宿主的鉴权。',
        'adapter.lingshu': '灵枢认知图 (md_cg)',
        'adapter.generic-json': '通用 JSON 记忆存储',
        'adapter.none': '无记忆存储',
        'adapter.reason.no-memory-store': '未检测到与对话关联的记忆存储。',
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
        // `dsh-client-locale`'s snapshot is `{ active, locales, revision }`:
        // the ACTIVE locale id lives in `active`, and neither `locale` nor
        // `id` exists. Reading the wrong fields silently fell back to the
        // browser language, so the UI ignored the in-app language switch.
        const id = snapshot?.active ?? snapshot?.locale ?? snapshot?.id
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

    /**
     * Localized adapter label. Host labels are deliberately neutral ids: the
     * Chinese lingshu label and the English `none` reason used to appear
     * untranslated in the other language's UI.
     */
    function adapterLabel(adapter) {
      const key = `adapter.${adapter?.id ?? ''}`
      const table = isZhLocale(currentLocaleId()) ? STRINGS.zh : STRINGS.en
      return table[key] ?? adapter?.label ?? adapter?.id ?? '—'
    }

    /** Localize the stable reason keys; anything else is a raw Host message. */
    function adapterReason(reason) {
      if (typeof reason !== 'string' || reason === '') return ''
      const key = `adapter.reason.${reason}`
      const table = isZhLocale(currentLocaleId()) ? STRINGS.zh : STRINGS.en
      return table[key] ?? reason
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
     * Recycle-bin writes wait for the Host's cross-process lock, and that wait
     * is unbounded in wall-clock terms: the request queues behind whatever
     * mutation is already running (`serialize()` chains in-process first). A
     * 15s budget therefore aborted restore / purge / discard while the Host was
     * still working, so the UI reported a failure for a change that did happen.
     * The Host caps its own lock wait at TRASH_LOCK_BUDGET_MS (180s); this sits
     * just above it so the Host's own answer always wins the race.
     */
    const TRASH_MUTATION_TIMEOUT_MS = 195_000
    /**
     * How long a delete may run before the dialog says what it is waiting for.
     * A hard delete of a conversation written moments ago spends
     * `foreignWriterGraceMs` (1.5s) re-checking the log for a second writer;
     * without a hint the danger button looked stuck.
     */
    const SLOW_SUBMIT_HINT_MS = 1_200

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

    /**
     * Resolve a plugin route against the PAGE, not against the origin.
     *
     * `dsh web` can be mounted under a path prefix (`--public-url
     * https://host/ui/`, stripped by a front proxy). DSH's own client stays
     * document-relative for exactly this reason: `dsh-client-connection` builds
     * its requests with `` `${channel}/${endpoint}`.slice(1) `` and resolves
     * them against `document.baseURI`. An absolute `/conversation-recycle-bin/…`
     * would replace the whole base path, drop the prefix, and 404 every call.
     * Keeping the same rule means one code path works for `http://127.0.0.1:<p>/`,
     * `https://host/<prefix>/` and the desktop shell's `dsh-app://app/`.
     */
    function apiUrl(path) {
      let base = 'http://127.0.0.1/'
      if (typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== '') {
        try {
          // Normalise to the containing directory so a base without a trailing
          // slash (`…/index.html`) does not swallow the last segment.
          base = new URL('.', document.baseURI).href
        } catch {
          base = 'http://127.0.0.1/'
        }
      }
      return new URL(`${API_PREFIX.replace(/^\//, '')}${path}`, base)
    }

    async function api(path, options = {}) {
      const method = options.method ?? 'GET'
      const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : REQUEST_TIMEOUT_MS
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const url = apiUrl(path)
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
      timer: null,
      listeners: new Set(),
      show(message) {
        if (this.timer !== null) clearTimeout(this.timer)
        this.message = message
        for (const listener of this.listeners) listener(this.message)
        this.timer = setTimeout(() => {
          this.timer = null
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
     * The same probe carries `defaultMode`, which the dialog used to ignore
     * (it always started on soft).
     */
    const uiFlagsStore = {
      loaded: false,
      flags: { showRowAction: true, showHeaderAction: true, enabled: true, defaultMode: 'soft' },
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
        const defaultMode = response?.state?.defaultMode
        uiFlagsStore.set({
          showRowAction: ui?.showRowAction !== false,
          showHeaderAction: ui?.showHeaderAction !== false,
          enabled: response?.state?.enabled !== false,
          defaultMode: defaultMode === 'hard' ? 'hard' : 'soft',
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
      reloadTimer = window.setTimeout(() => {
        reloadTimer = null
        reloadPending = false
        window.location.reload()
      }, delay)
    }

    // A fallback reload is armed when the Host cannot close the deleted
    // conversation in place. The result dialog is the only place a partial
    // batch reports its per-session failures, so the reload waits for the user
    // to dismiss it; the timer is only a safety net for a dialog left open.
    const RELOAD_FALLBACK_DELAY = 5_000
    let reloadPending = false
    let reloadTimer = null
    // Set when the user dismisses the result dialog. `refreshAfterMutation`
    // settles after the dialog is already on screen, so the dismissal can
    // arrive first; the reload then happens at once instead of arming a timer.
    let reloadDialogDismissed = false

    function takeReloadPending() {
      const pending = reloadPending
      reloadPending = false
      // Cancel the safety-net timer, otherwise dismissing the dialog would
      // reload once now and once again when the original timer fires.
      if (pending && reloadTimer !== null) {
        if (typeof window !== 'undefined') window.clearTimeout?.(reloadTimer)
        reloadTimer = null
      }
      return pending
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
      const fallbackDelay = Number.isFinite(options.fallbackDelay) ? options.fallbackDelay : RELOAD_FALLBACK_DELAY
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
      if (!refreshed) {
        if (reloadDialogDismissed) reloadApp(0)
        else {
          reloadPending = true
          reloadApp(fallbackDelay)
        }
      }
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

    function GlyphFeedback({ size = 14 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('path', { d: 'M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z' }),
      h('path', { d: 'm3.5 7 8.5 6 8.5-6' }))
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

    /**
     * The recycle-bin retention window, read from the Host payload.
     *
     * `trashRetentionDays` lives under `limits` — the same place as every other
     * Host limit — and the Host also sends a per-entry `daysLeft`. Reading the
     * top level (as 0.3.10 did) yields `undefined`, which used to switch the
     * whole notice off: the bin was purged with no warning at all. The countdown
     * prefers the Host's number so a skewed browser clock cannot promise a
     * different day than the sweep keeps; the local computation is only a
     * fallback for an older Host that does not send `daysLeft`.
     */
    function retentionInfo(state, entry = null, nowMs = Date.now()) {
      const raw = Number(state?.limits?.trashRetentionDays)
      const days = Number.isFinite(raw) && raw > 0 ? raw : 0
      if (days <= 0) return { days: 0, daysLeft: null }
      if (entry === null || entry === undefined) return { days, daysLeft: null }
      // Only `trashed` rows are ever swept, so a restored or mid-transaction row
      // must not advertise a deadline it will never reach.
      if (entry.status !== undefined && entry.status !== 'trashed') return { days, daysLeft: null }
      const hostDays = entry.daysLeft === null || entry.daysLeft === undefined ? Number.NaN : Number(entry.daysLeft)
      if (Number.isFinite(hostDays) && hostDays >= 0) return { days, daysLeft: hostDays }
      const deletedAt = Number(entry.deletedAt)
      if (!Number.isFinite(deletedAt) || deletedAt <= 0) return { days, daysLeft: null }
      const left = deletedAt + days * 86_400_000 - nowMs
      return { days, daysLeft: left <= 0 ? 0 : Math.ceil(left / 86_400_000) }
    }

    /* ------------------------------------------------------------------ *
     * Feedback form (pure helpers, shared with the Host's validation)
     * ------------------------------------------------------------------ */

    // Mirrors FEEDBACK_LIMITS in `lib/host/feedback.js`. The Host re-validates
    // every field; this copy only exists to disable the submit button early and
    // to point at the offending input.
    const FEEDBACK_LIMITS = Object.freeze({
      titleMin: 4,
      titleMax: 120,
      bodyMin: 10,
      bodyMax: 4_000,
      emailMax: 200,
    })

    /** Same loose shape the Host accepts: `a@b.cc`, no whitespace or separators. */
    const EMAIL_PATTERN = /^[^\s@,;:<>()[\]\\]+@[^\s@,;:<>()[\]\\]+\.[^\s@,;:<>()[\]\\]{2,}$/

    /**
     * @param {{title?: string, body?: string, email?: string}} input
     * @returns {{ok: true} | {ok: false, key: string, vars: Record<string, number>}}
     */
    function validateFeedbackInput(input) {
      const title = String(input?.title ?? '').trim()
      const body = String(input?.body ?? '').trim()
      const email = String(input?.email ?? '').trim()
      if (title.length < FEEDBACK_LIMITS.titleMin) return { ok: false, key: 'feedback.tooShortTitle', vars: { min: FEEDBACK_LIMITS.titleMin } }
      if (title.length > FEEDBACK_LIMITS.titleMax) return { ok: false, key: 'feedback.tooLongTitle', vars: { max: FEEDBACK_LIMITS.titleMax } }
      if (body.length < FEEDBACK_LIMITS.bodyMin) return { ok: false, key: 'feedback.tooShortBody', vars: { min: FEEDBACK_LIMITS.bodyMin } }
      if (body.length > FEEDBACK_LIMITS.bodyMax) return { ok: false, key: 'feedback.tooLongBody', vars: { max: FEEDBACK_LIMITS.bodyMax } }
      // Same order as the Host (`lib/host/feedback.js:241-250`): shape first,
      // then length. The reverse told a 300-character address it was "not an
      // email" while the Host said "too long" for the identical submission.
      if (email !== '' && !EMAIL_PATTERN.test(email)) return { ok: false, key: 'feedback.invalidEmail', vars: {} }
      if (email.length > FEEDBACK_LIMITS.emailMax) return { ok: false, key: 'feedback.tooLongEmail', vars: { max: FEEDBACK_LIMITS.emailMax } }
      return { ok: true }
    }

    /** Context the dialog shows before sending; nothing here is user content. */
    function collectFeedbackContext() {
      const userAgent = typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
        ? navigator.userAgent
        : ''
      return {
        platform: userAgent.slice(0, 160),
        locale: currentLocaleId(),
      }
    }

    /* ------------------------------------------------------------------ *
     * Confirmation dialog
     * ------------------------------------------------------------------ */

    function DeleteDialog({ payload }) {
      useLocaleTick()
      const flags = useUiFlags()
      const sessionIds = payload.sessionIds
      const count = sessionIds.length
      const fallbackTitle = payload.displayTitle ?? ''
      // `config.defaultMode` was dead configuration: the dialog always started
      // on soft, so the Host's documented "initial mode" never applied.
      const [mode, setMode] = useState(flags.defaultMode === 'hard' ? 'hard' : 'soft')
      const [includeMemory, setIncludeMemory] = useState(false)
      const [preview, setPreview] = useState(null)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [phrase, setPhrase] = useState('')
      const [done, setDone] = useState(null)
      // Set when a submission outlives SLOW_SUBMIT_HINT_MS, so the dialog can
      // explain the wait instead of showing a frozen danger button.
      const [slow, setSlow] = useState(false)

      // Dismissing the result must also complete a reload the Host armed
      // because it cannot close the deleted conversation in place; otherwise
      // the safety-net timer would fire later and reload under the user's feet.
      function closeDone() {
        reloadDialogDismissed = true
        dialogStore.close()
        if (takeReloadPending()) reloadApp(0)
      }
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
          // Escape dismisses the result dialog too, so it must release the
          // armed reload exactly like the Close button does.
          if (event.key === 'Escape' && busy !== true) closeDone()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [busy])

      useEffect(() => {
        if (busy !== true) {
          setSlow(false)
          return undefined
        }
        const timer = setTimeout(() => setSlow(true), SLOW_SUBMIT_HINT_MS)
        return () => clearTimeout(timer)
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
        // A new submission starts a new result cycle: a dismissal from the
        // previous one must not force this run's reload to happen at once.
        reloadDialogDismissed = false
        setBusy(true)
        setError(null)
        try {
          // The Host's own worst-case estimate for THIS plan (live drains,
          // memory locks, per-item moves) replaces the client's flat guess:
          // aborting while the Host keeps deleting left a consumed token and a
          // half-changed list behind.
          // The Host publishes the budget it actually enforces: the lock wait
          // plus the queue grace period. The lock-only estimate used to abort
          // 60 s before the Host gave up, so a busy bin looked like a failure
          // while the deletion was still running.
          const planTimeout = Number.isFinite(preview?.limits?.queueTimeoutMs)
            ? Math.max(1_000, preview.limits.queueTimeoutMs)
            : Number.isFinite(preview?.limits?.planTimeoutMs)
              ? Math.max(1_000, preview.limits.planTimeoutMs)
              : mutationTimeoutMs(sessionIds.length)
          const result = await api('/delete', {
            method: 'POST',
            timeoutMs: planTimeout,
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
        return h('div', {
          className: 'dc-backdrop',
          onMouseDown: (event) => { if (event.target === event.currentTarget) closeDone() },
        },
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
              h(Button, { variant: 'primary', onClick: () => closeDone() }, t('action.close')))))
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

          // Permanent deletion waits out `foreignWriterGraceMs` when the log was
          // written moments ago (measured: ~1.5s once per batch). Say so before
          // the click, not after the user thinks the button is stuck.
          mode === 'hard' ? h('p', { className: 'dc-hint' }, t('dialog.hardGraceHint')) : null,

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
                // A phrase exists only for a multi-item soft batch (the Host's
                // `expectedPhrase` returns '' for hard mode), so the label is
                // always the batch instruction.
                t('dialog.batchWarning', { count })),
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

          slow === true
            ? h('div', { className: 'dc-live-warning', role: 'status' }, t('dialog.stillWorking'))
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
      if (first !== undefined) return adapterReason(first.reason)
      const stores = Array.isArray(memory?.stores) ? memory.stores : []
      const store = stores.find((item) => item.available === false && typeof item.reason === 'string')
      // `not detected` used to be hard-coded English, so a Chinese page showed
      // `记忆存储不可用：not detected`. Everything else here already routes
      // through the string table.
      return store === undefined ? t('state.notDetected') : adapterReason(store.reason)
    }

    /* ------------------------------------------------------------------ *
     * Feedback dialog
     * ------------------------------------------------------------------ */

    /**
     * Settings page "反馈" button.
     *
     * The Host performs the delivery, so the page never holds a mail
     * credential. The auto-attached context is rendered BEFORE the user
     * commits, so nothing leaves the machine that they did not see.
     */
    function FeedbackDialog({ payload }) {
      useLocaleTick()
      const feedback = payload?.feedback ?? null
      const version = typeof payload?.version === 'string' ? payload.version : ''
      const [category, setCategory] = useState('bug')
      const [title, setTitle] = useState('')
      const [body, setBody] = useState('')
      const [email, setEmail] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const validation = validateFeedbackInput({ title, body, email })
      const context = collectFeedbackContext()
      // A Host without a mail transport advertises `enabled: false`; the form is
      // still rendered read-only so the explanation is visible instead of a
      // button that fails on click.
      const unavailable = feedback?.enabled !== true
      // Nothing has been typed on the first render, so the "too short" rule must
      // not greet the user. It starts applying once the user edits a field OR
      // leaves one: gating on `dirty` alone left the disabled submit button with
      // no visible reason for anyone who only tabbed through the form.
      const [dirty, setDirty] = useState(false)
      const [touched, setTouched] = useState(false)
      const validationVisible = (dirty === true || touched === true) && validation.ok !== true

      useEffect(() => {
        function onKey(event) {
          if (event.key === 'Escape' && busy !== true) dialogStore.close()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [busy])

      async function submit() {
        if (busy || unavailable || validation.ok !== true) return
        setBusy(true)
        setError(null)
        try {
          await api('/feedback', {
            method: 'POST',
            timeoutMs: 30_000,
            body: {
              category,
              title: title.trim(),
              body: body.trim(),
              email: email.trim(),
              context: {
                pluginVersion: version,
                platform: context.platform,
                locale: context.locale,
              },
            },
          })
          flashStore.show(t('feedback.sent'))
          dialogStore.close()
        } catch (caught) {
          // The Host log already records the stable code; this keeps the form
          // path debuggable from the browser console without a network tab.
          console.error('[conversation-recycle-bin] feedback submission failed:', caught?.code ?? caught)
          setError(caught)
        } finally {
          setBusy(false)
        }
      }

      return h('div', {
        className: 'dc-backdrop',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget && busy !== true) dialogStore.close()
        },
      },
      h('div', { className: 'dc-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dc-feedback-title' },
        h('h2', { id: 'dc-feedback-title', className: 'dc-dialog-title' }, t('feedback.title')),
        h('p', { className: 'dc-dialog-body' }, t('feedback.intro')),
        unavailable ? h('div', { className: 'dc-error', role: 'alert' }, t('feedback.unavailable')) : null,
        h(ErrorBanner, { error }),

        h('label', { className: 'dc-field' },
          h('span', { className: 'dc-field-label' }, t('feedback.categoryLabel')),
          h('select', {
            className: 'dc-input',
            value: category,
            disabled: busy,
            onBlur: () => setTouched(true),
            onChange: (event) => { setDirty(true); setCategory(event.target.value) },
          },
          h('option', { value: 'bug' }, t('feedback.categoryBug')),
          h('option', { value: 'suggestion' }, t('feedback.categorySuggestion')),
          h('option', { value: 'other' }, t('feedback.categoryOther')))),

        h('label', { className: 'dc-field' },
          h('span', { className: 'dc-field-label' }, t('feedback.titleLabel')),
          h('input', {
            type: 'text',
            className: 'dc-input',
            value: title,
            maxLength: FEEDBACK_LIMITS.titleMax,
            placeholder: t('feedback.titlePlaceholder'),
            disabled: busy,
            autoFocus: true,
            onBlur: () => setTouched(true),
            onChange: (event) => { setDirty(true); setTitle(event.target.value) },
          })),

        h('label', { className: 'dc-field' },
          h('span', { className: 'dc-field-label' }, t('feedback.bodyLabel')),
          h('textarea', {
            className: 'dc-input dc-textarea',
            value: body,
            rows: 6,
            maxLength: FEEDBACK_LIMITS.bodyMax,
            placeholder: t('feedback.bodyPlaceholder'),
            disabled: busy,
            onBlur: () => setTouched(true),
            onChange: (event) => { setDirty(true); setBody(event.target.value) },
          })),

        h('label', { className: 'dc-field' },
          h('span', { className: 'dc-field-label' }, t('feedback.emailLabel')),
          h('input', {
            type: 'email',
            className: 'dc-input',
            value: email,
            maxLength: FEEDBACK_LIMITS.emailMax,
            placeholder: t('feedback.emailPlaceholder'),
            autoComplete: 'email',
            disabled: busy,
            onBlur: () => setTouched(true),
            onChange: (event) => { setDirty(true); setEmail(event.target.value) },
          }),
          h('div', { className: 'dc-hint' }, t(feedback?.visitorAsFrom === true ? 'feedback.emailHintAsFrom' : 'feedback.emailHint'))),

        h('div', { className: 'dc-context' },
          h('div', { className: 'dc-context-title' }, t('feedback.contextLabel')),
          h('div', { className: 'dc-hint' }, t('feedback.contextHint')),
          h('ul', { className: 'dc-context-list' },
            h('li', null, `${t('feedback.contextVersion')}: ${version === '' ? '—' : version}`),
            h('li', null, `${t('feedback.contextPlatform')}: ${context.platform === '' ? '—' : context.platform}`),
            h('li', null, `${t('feedback.contextLocale')}: ${context.locale}`))),

        validationVisible ? h('div', { className: 'dc-hint' }, t(validation.key, validation.vars)) : null,
        busy ? h(Spinner, { label: t('feedback.sending') }) : null,

        h('div', { className: 'dc-actions' },
          h(Button, { onClick: () => dialogStore.close(), disabled: busy }, t('action.cancel')),
          h(Button, {
            variant: 'primary',
            onClick: () => { void submit() },
            disabled: busy || unavailable || validation.ok !== true,
          }, busy ? t('feedback.sending') : t('feedback.send')))))
    }

    /* ------------------------------------------------------------------ *
     * Dialog host / overlay entry
     * ------------------------------------------------------------------ */

    /**
     * Dialog host / overlay entry.
     *
     * The dialog is portaled to `document.body` on purpose: the `shell.overlay`
     * slot renders inside the layout's overlay layer
     * (`.overlayLayer{position:absolute;z-index:20}`), which is its own
     * stacking context. A `z-index:1000` backdrop inside it cannot cover the
     * settings modal (also `z-index:1000`, but on `body`), so the batch-delete
     * confirmation opened from Settings was invisible and its first click
     * closed the settings modal instead. Portaling to the body puts the dialog
     * in the same layer as every other modal; the toast follows for the same
     * reason.
     */
    function DialogHost() {
      const payload = useDialogState()
      const flash = useFlashMessage()
      // `kind` is optional: every pre-0.2.2 caller opens a delete dialog, so a
      // payload without a kind keeps its old meaning.
      const dialog = payload === null
        ? null
        : payload.kind === 'feedback'
          ? h(FeedbackDialog, { payload, key: payload.key ?? 'feedback' })
          : h(DeleteDialog, { payload, key: payload.key ?? (payload.sessionIds ?? []).join(',') })
      const content = h(React.Fragment, null,
        dialog,
        flash === null ? null : h('div', { className: 'dc-toast', role: 'status' }, flash))
      return portalIntoBody(content)
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
     *
     * A restorable entry (one whose manifest still points at a moved session
     * log) gets a Restore button: `performDiscard` refuses exactly those
     * entries, so without this the only way out was a manual API call.
     */
    function IncompleteEntries({ entries, discardTarget, discardPhrase, onPhrase, onStart, onCancel, onDiscard, onRestore, restoreBusyId, discardBusyId = null }) {
      return h('div', { className: 'dc-panel dc-incomplete' },
        h('div', { className: 'dc-state-title' }, `${t('trash.incompleteTitle')} (${entries.length})`),
        h('p', { className: 'dc-hint' }, t('trash.incompleteHint')),
        ...entries.map((entry) => {
          // The Host knows what is actually recoverable (a moved log, a memory
          // bundle, or nothing at all). Falling back to `hasSessionLog` keeps
          // older Hosts working, but a memory-only entry used to show Discard
          // only — the route refuses that while memory files remain — so the
          // one action the Host offered was its API, not the UI.
          const canRestore = entry.capabilities === undefined
            ? entry.hasSessionLog === true
            : entry.capabilities?.canRestore === true
          const canDiscard = entry.capabilities === undefined
            ? true
            : entry.capabilities?.canDiscard !== false
          return h('div', { key: entry.trashId, className: 'dc-row' },
            h('div', { className: 'dc-row-main' },
              h('div', { className: 'dc-row-title' }, entry.title || entry.sessionId || entry.trashId),
              h('div', { className: 'dc-hint' }, entry.status === 'unreadable' && entry.error?.message
                ? `${t('trash.status.unreadable')} · ${entry.error.message}`
                : `${t(`trash.status.${entry.status}`)} · ${formatTime(entry.updatedAt ?? entry.deletedAt)} · ${t('trash.items', { sessions: 1, memories: entry.memory ?? 0 })}`)),
            h('div', { className: 'dc-row-actions' },
              canRestore === true && typeof onRestore === 'function'
                ? h(Button, {
                  onClick: () => onRestore(entry.trashId),
                  disabled: restoreBusyId === entry.trashId,
                  title: t('trash.restoreIncompleteHint'),
                }, t('action.restore'))
                : null,
              canDiscard !== true
                ? null
                : discardTarget === entry.trashId
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
                      disabled: discardBusyId === entry.trashId || discardPhrase.trim() !== 'DELETE',
                      onClick: () => onDiscard(entry.trashId),
                    }, t('trash.discard')),
                    h(Button, { disabled: discardBusyId === entry.trashId, onClick: onCancel }, t('action.cancel')))
                  : h(Button, {
                    onClick: () => onStart(entry.trashId),
                    title: t('trash.confirmDiscard'),
                  }, t('trash.discard')))
          )
        }))
    }

    /**
     * One batch-picker row. A conversation the Host would refuse (subagent,
     * orphan, outside the allowed roots, protected) is rendered disabled with
     * the reason, instead of selectable and then failing the whole batch.
     */
    function BatchSessionRow({ session, checked, onToggle }) {
      const notDeletable = session.deletable === false
      return h('label', { key: session.id, className: `dc-row dc-row-select${notDeletable ? ' dc-disabled' : ''}` },
        h('input', {
          type: 'checkbox',
          checked,
          disabled: notDeletable,
          onChange: () => onToggle(session.id),
        }),
        h('div', { className: 'dc-row-main' },
          h('div', { className: 'dc-row-title' }, session.title || session.id),
          h('div', { className: 'dc-hint' },
            `${session.cwd ?? '—'}${session.archived ? ' · archived' : ''}${session.live || session.running ? ' · live' : ''}`
            + (notDeletable ? ` · ${t('batch.notDeletable')}: ${errorText(session.policy)}` : ''))),
        h('div', { className: 'dc-row-time' }, formatTime(session.updatedAt)))
    }

    /** Ids "select all" may mark: every row the Host has not vetoed. */
    function selectableSessionIds(sessions) {
      return sessions.filter((session) => session.deletable !== false).map((session) => session.id)
    }

    function SettingsSection() {
      useLocaleTick()
      const mutationVersion = useMutationVersion()
      const [tab, setTab] = useState('trash')
      const [state, setState] = useState(null)
      const [sessions, setSessions] = useState([])
      const [trash, setTrash] = useState([])
      const [incomplete, setIncomplete] = useState([])
      // What the background retention sweep did last time, straight from the
      // Host: entries that vanished between two refreshes get an explanation
      // instead of looking like a rendering bug.
      const [lastSweep, setLastSweep] = useState(null)
      const [audit, setAudit] = useState([])
      // Which tab is fetching right now. `null` means idle: the panels stay
      // mounted while a refresh runs, so the user keeps scroll position and
      // never sees the whole section blink on every restore/purge.
      const [tabBusy, setTabBusy] = useState(null)
      const [error, setError] = useState(null)
      const [selected, setSelected] = useState(() => new Set())
      const [purgeTarget, setPurgeTarget] = useState(null)
      const [purgePhrase, setPurgePhrase] = useState('')
      const [discardTarget, setDiscardTarget] = useState(null)
      const [discardPhrase, setDiscardPhrase] = useState('')
      const [restoreBusyId, setRestoreBusyId] = useState(null)
      const [purgeBusy, setPurgeBusy] = useState(false)
      const [discardBusyId, setDiscardBusyId] = useState(null)

      // Two refreshes can overlap (mount, mutation broadcast, and the refresh a
      // purge triggers), and the older response must not overwrite the newer.
      const refreshSerial = useRef(0)
      // The mutation version each tab's data was fetched at. `-1` = never.
      const loadedRef = useRef({ trash: -1, batch: -1, audit: -1 })

      const refreshState = useCallback(async () => {
        const response = await api('/state')
        setState(response.state)
      }, [])

      /**
       * Fetch only what the visible tab renders. The section used to pull
       * `/state`, `/sessions`, `/trash` and `/audit` on every mount and every
       * mutation (~31 KB, 4 round trips) even when the user was looking at one
       * tab. `/sessions` is the expensive one (one projection read per row),
       * so opening the recycle bin must not pay for it.
       */
      const loadTab = useCallback(async (which, { force = false } = {}) => {
        if (!force && loadedRef.current[which] === mutationVersion) return
        const serial = refreshSerial.current + 1
        refreshSerial.current = serial
        const stale = () => serial !== refreshSerial.current
        setTabBusy(which)
        setError(null)
        try {
          if (which === 'trash') {
            const response = await api('/trash')
            if (stale()) return
            setTrash(Array.isArray(response.entries) ? response.entries : [])
            setIncomplete(Array.isArray(response.incomplete) ? response.incomplete : [])
            setLastSweep(response.lastSweep ?? null)
          } else if (which === 'batch') {
            const response = await api('/sessions')
            if (stale()) return
            const nextSessions = Array.isArray(response.sessions) ? response.sessions : []
            setSessions(nextSessions)
            // Drop selections whose conversation no longer exists.
            setSelected((current) => {
              const alive = new Set(nextSessions.map((session) => session.id))
              const next = new Set([...current].filter((id) => alive.has(id)))
              return next.size === current.size ? current : next
            })
          } else {
            const response = await api('/audit?limit=50')
            if (stale()) return
            setAudit(Array.isArray(response.records) ? response.records : [])
          }
          loadedRef.current[which] = mutationVersion
        } catch (caught) {
          if (!stale()) setError(caught)
        } finally {
          if (!stale()) setTabBusy(null)
        }
      }, [mutationVersion])

      // `/state` drives the capability block and the limits; refetch it on
      // mount and whenever a mutation happened, not on every tab switch.
      useEffect(() => {
        refreshState().catch((caught) => setError(caught))
      }, [mutationVersion, refreshState])

      // The active tab's own slice, on mount, on tab switch, and after a
      // mutation (which changes `loadTab`'s identity through the version).
      useEffect(() => {
        void loadTab(tab)
      }, [tab, loadTab])

      /** Header "refresh" button: re-read state and the visible tab. */
      const refresh = useCallback(async () => {
        await Promise.all([
          refreshState().catch((caught) => setError(caught)),
          loadTab(tab, { force: true }),
        ])
      }, [tab, refreshState, loadTab])

      /**
       * Mark a slice stale without fetching it. Recycle-bin actions call
       * `refreshAfterMutation({ notify: false })`, so no version bump happens:
       * the visible tab is re-read by `refresh()`, and any other tab must be
       * re-read the next time the user opens it instead of showing rows that
       * were deleted a moment ago.
       */
      const markStale = useCallback((...which) => {
        for (const name of which) loadedRef.current[name] = -1
      }, [])

      async function restore(trashId) {
        setError(null)
        const entry = trash.find((item) => item.trashId === trashId)
        try {
          await api('/trash/restore', {
            method: 'POST',
            body: { trashId },
            timeoutMs: TRASH_MUTATION_TIMEOUT_MS,
          })
          flashStore.show(t('trash.restored'))
          markStale('trash', 'batch')
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

      /**
       * Restore an entry that never committed (pending / failed / interrupted).
       * The same endpoint as the recycle-bin restore: `performRestore` accepts
       * those statuses, and this is the action `performDiscard` tells the user
       * to take when the entry still holds a session log.
       */
      async function restoreIncomplete(trashId) {
        setError(null)
        setRestoreBusyId(trashId)
        try {
          await api('/trash/restore', {
            method: 'POST',
            body: { trashId },
            timeoutMs: TRASH_MUTATION_TIMEOUT_MS,
          })
          flashStore.show(t('trash.restored'))
          markStale('trash', 'batch')
          await refresh()
          await refreshAfterMutation({
            sessionIds: incomplete.find((item) => item.trashId === trashId)?.sessionId
              ? [incomplete.find((item) => item.trashId === trashId).sessionId]
              : [],
            closeCurrent: false,
            notify: false,
          })
        } catch (caught) {
          setError(caught)
        } finally {
          setRestoreBusyId(null)
        }
      }

      async function purge(trashId, phrase) {
        if (purgeBusy === true) return
        setPurgeBusy(true)
        setError(null)
        const entry = trash.find((item) => item.trashId === trashId)
        try {
          await api('/trash/purge', {
            method: 'POST',
            body: { trashId, confirmPhrase: phrase },
            timeoutMs: TRASH_MUTATION_TIMEOUT_MS,
          })
          flashStore.show(t('trash.purged'))
          setPurgeTarget(null)
          setPurgePhrase('')
          markStale('trash', 'batch')
          await refresh()
          // Purging a soft entry detaches the session from its workspace.
          await refreshAfterMutation({
            sessionIds: typeof entry?.sessionId === 'string' ? [entry.sessionId] : [],
            closeCurrent: false,
            notify: false,
          })
        } catch (caught) {
          setError(caught)
        } finally {
          setPurgeBusy(false)
        }
      }

      async function discard(trashId, phrase) {
        if (discardBusyId !== null) return
        setDiscardBusyId(trashId)
        setError(null)
        try {
          await api('/trash/discard', {
            method: 'POST',
            body: { trashId, confirmPhrase: phrase },
            timeoutMs: TRASH_MUTATION_TIMEOUT_MS,
          })
          flashStore.show(t('trash.discarded'))
          setDiscardTarget(null)
          setDiscardPhrase('')
          markStale('trash')
          await refresh()
        } catch (caught) {
          setError(caught)
        } finally {
          setDiscardBusyId(null)
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
      // The Host purges entries on its own after `trashRetentionDays`; both the
      // banner and the per-row hint come from `retentionInfo`, which reads the
      // field where the Host actually sends it (`limits`).
      const retentionDays = retentionInfo(state).days
      const expiryHint = (entry) => {
        const left = retentionInfo(state, entry).daysLeft
        if (left === null) return ''
        return ` · ${left === 0 ? t('trash.expiresSoon') : t('trash.expiresIn', { days: left })}`
      }

      const openFeedback = () => dialogStore.open({
        kind: 'feedback',
        key: 'feedback',
        version: typeof state?.version === 'string' ? state.version : '',
        feedback: state?.feedback ?? null,
      })

      return h('div', { className: 'dc-root' },
        // Top-of-section call to action, above the title: it is the first thing
        // a user unsure about the plugin should see. Rendered only when the Host
        // reports a configured transport, so a profile without mail settings
        // never shows a button that cannot work (the dialog would otherwise
        // explain a failure to send).
        state?.feedback?.enabled === true
          ? h('div', { className: 'dc-feedback-bar' },
            h('div', { className: 'dc-feedback-bar-text' },
              h('div', { className: 'dc-feedback-bar-title' }, t('feedback.bannerTitle')),
              h('div', { className: 'dc-feedback-bar-hint' }, t('feedback.bannerHint'))),
            h(Button, { variant: 'primary', title: t('feedback.button'), onClick: openFeedback },
              h(GlyphFeedback, { size: 14 }), ' ', t('feedback.button')))
          : null,
        h('div', { className: 'dc-header' },
          h('div', null,
            h('h1', { className: 'dc-title' }, t('section.title')),
            h('p', { className: 'dc-hint' }, t('section.subtitle'))),
          h('div', { className: 'dc-header-actions' },
            h(Button, { onClick: () => { void refresh() }, disabled: tabBusy !== null, title: t('action.refresh') },
              h(GlyphRefresh, { size: 13 }), ' ', t('action.refresh')))),

        h(ErrorBanner, { error }),

        state !== null ? h('div', { className: 'dc-state' },
          h('div', { className: 'dc-state-block' },
            h('div', { className: 'dc-state-title' }, t('state.memory')),
            ...(state.memory?.adapters ?? []).map((adapter) => h('div', {
              key: adapter.id,
              className: 'dc-state-row',
            },
            h('span', { className: adapter.available ? 'dc-ok' : 'dc-off' }, adapter.available ? '●' : '○'),
            h('span', null, ` ${adapterLabel(adapter)} `),
            h('span', { className: 'dc-hint' }, adapter.available ? t('state.available') : `${t('state.unavailable')} — ${adapterReason(adapter.reason)}`)))),
          h('div', { className: 'dc-state-block' },
            h('div', { className: 'dc-state-title' }, t('state.limits')),
            h('div', { className: 'dc-hint' },
              t('state.rate', {
                used: state.limits?.rate?.used ?? 0,
                limit: state.limits?.rate?.limit ?? state.limits?.maxDeletesPerMinute ?? 0,
              })),
            h('div', { className: 'dc-hint' }, t('state.batch', { limit: effectiveBatch > 0 ? effectiveBatch : '—' })))) : null,

        h('div', { className: 'dc-tabs', role: 'tablist' },
          h('button', { id: 'dc-tab-trash', type: 'button', role: 'tab', 'aria-selected': tab === 'trash', 'aria-controls': 'dc-panel-trash', className: `dc-tab${tab === 'trash' ? ' dc-tab-active' : ''}`, onClick: () => setTab('trash') }, t('trash.title')),
          h('button', { id: 'dc-tab-batch', type: 'button', role: 'tab', 'aria-selected': tab === 'batch', 'aria-controls': 'dc-panel-batch', className: `dc-tab${tab === 'batch' ? ' dc-tab-active' : ''}`, onClick: () => setTab('batch') }, t('batch.title')),
          h('button', { id: 'dc-tab-audit', type: 'button', role: 'tab', 'aria-selected': tab === 'audit', 'aria-controls': 'dc-panel-audit', className: `dc-tab${tab === 'audit' ? ' dc-tab-active' : ''}`, onClick: () => setTab('audit') }, t('audit.title'))),

        // First paint only: once anything has been rendered, a refresh keeps the
        // panels mounted and shows the inline indicator below instead.
        state === null && tabBusy !== null ? h(Spinner, { label: t('dialog.loading') }) : null,
        state !== null && tabBusy !== null
          ? h('div', { className: 'dc-loading' }, h('span', { className: 'dc-spinner' }), ' ', t('dialog.loading'))
          : null,

        tab === 'trash' ? h('div', { id: 'dc-panel-trash', role: 'tabpanel', 'aria-labelledby': 'dc-tab-trash', className: 'dc-panel' },
          retentionDays > 0 ? h('div', { className: 'dc-hint dc-hint-block' }, t('trash.retention', { days: retentionDays })) : null,
          Number(lastSweep?.purged) > 0
            ? h('div', { className: 'dc-hint dc-hint-block' }, t('trash.swept', { count: Number(lastSweep.purged) }))
            : null,
          trash.length === 0 ? h('div', { className: 'dc-empty' }, t('trash.empty')) : null,
          ...trash.map((entry) => h('div', { key: entry.trashId, className: 'dc-row' },
            h('div', { className: 'dc-row-main' },
              h('div', { className: 'dc-row-title' }, entry.title || entry.sessionId),
              h('div', { className: 'dc-hint' },
                `${t('trash.deletedAt', { time: formatTime(entry.deletedAt) })} · ${entry.mode === 'hard' ? t('trash.modeHard') : t('trash.modeSoft')} · ${t('trash.items', { sessions: 1, memories: entry.memory ?? 0 })}${expiryHint(entry)}`)),
            h('div', { className: 'dc-row-actions' },
              // The Host already knows whether this entry can be restored;
              // the panel used to offer the button and then show the refusal.
              h(Button, {
                disabled: entry.capabilities?.canRestore === false,
                title: entry.capabilities?.canRestore === false ? t('error.E_TRASH_CONFLICT') : t('action.restore'),
                onClick: () => { void restore(entry.trashId) },
              }, t('action.restore')),
              purgeTarget === entry.trashId
                ? h('span', { className: 'dc-inline-confirm' },
                  h('input', {
                    type: 'text', value: purgePhrase, placeholder: 'DELETE', className: 'dc-input dc-input-small',
                    onChange: (event) => setPurgePhrase(event.target.value),
                  }),
                  h(Button, {
                    variant: 'danger',
                    disabled: purgeBusy === true || purgePhrase.trim() !== 'DELETE',
                    onClick: () => { void purge(entry.trashId, purgePhrase.trim()) },
                  }, t('action.purge')),
                  h(Button, { disabled: purgeBusy === true, onClick: () => { setPurgeTarget(null); setPurgePhrase('') } }, t('action.cancel')))
                : h(Button, {
                  variant: 'danger',
                  disabled: entry.capabilities?.canPurge === false,
                  title: entry.capabilities?.canPurge === false ? t('error.E_TRASH_CONFLICT') : t('action.purge'),
                  onClick: () => { setPurgeTarget(entry.trashId); setPurgePhrase('') },
                }, t('action.purge')))))) : null,

        tab === 'trash' && incomplete.length > 0 ? h(IncompleteEntries, {
          entries: incomplete,
          discardTarget,
          discardPhrase,
          onPhrase: setDiscardPhrase,
          onStart: (trashId) => { setDiscardTarget(trashId); setDiscardPhrase('') },
          onCancel: () => { setDiscardTarget(null); setDiscardPhrase('') },
          onDiscard: (trashId) => { void discard(trashId, discardPhrase.trim()) },
          onRestore: (trashId) => { void restoreIncomplete(trashId) },
          restoreBusyId,
          discardBusyId,
        }) : null,

        tab === 'batch' ? h('div', { id: 'dc-panel-batch', role: 'tabpanel', 'aria-labelledby': 'dc-tab-batch', className: 'dc-panel' },
          h('div', { className: 'dc-batch-bar' },
            h('span', { className: 'dc-hint' }, t('batch.selected', { count: selectedIds.length })),
            // "Select all" only marks deletable rows: a batch containing one
            // subagent/orphan/out-of-root conversation is refused as a whole,
            // so selecting it guaranteed a dead button with no hint why.
            h(Button, {
              onClick: () => setSelected(new Set(selectableSessionIds(sessions))),
              title: t('batch.selectAllDeletable'),
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
          ...sessions.map((session) => h(BatchSessionRow, {
            key: session.id,
            session,
            checked: selected.has(session.id),
            onToggle: toggle,
          }))) : null,

        tab === 'audit' ? h('div', { id: 'dc-panel-audit', role: 'tabpanel', 'aria-labelledby': 'dc-tab-audit', className: 'dc-panel' },
          audit.length === 0 ? h('div', { className: 'dc-empty' }, t('audit.empty')) : null,
          ...audit.map((record) => h('div', { key: record.id, className: 'dc-row' },
            h('div', { className: 'dc-row-main' },
              h('div', { className: 'dc-row-title' },
                `${record.action ?? ''} · ${record.sessionId ?? (Array.isArray(record.sessionIds) ? record.sessionIds.join(', ') : '')}`),
              h('div', { className: 'dc-hint' },
                `${formatTime(record.at)} · ${t(`audit.${record.result ?? 'success'}`) ?? record.result ?? ''}`
                + (record.mode ? ` · ${record.mode}` : '')
                + (record.includeMemory ? ' · memory' : '')
                // Automatic clean-up writes the same shape as a manual purge;
                // without the source the two are indistinguishable in the UI.
                + (typeof record.source === 'string' && record.source !== 'web-ui' ? ` · ${record.source}` : '')
                + (record.error?.message ? ` · ${record.error.message}` : ''))),
            h('div', { className: 'dc-row-time' }, record.actor ?? '')))) : null)
    }

    /* ------------------------------------------------------------------ *
     * Stylesheet (one element owned by this plugin's fiber)
     * ------------------------------------------------------------------ */

    const CSS = `
/* 1300 clears the settings modal (1000) and the host panels that also use
   1100, since this backlog shares document.body with them. */
.dc-backdrop{position:fixed;inset:0;z-index:1300;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.38);padding:16px}
.dc-dialog{box-sizing:border-box;width:min(560px,94vw);max-height:88vh;overflow:auto;background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#1f2329);border:1px solid var(--dsw-alias-border-l1,#e5e6eb);border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,.28);padding:20px 20px 16px;font:inherit}
.dc-dialog-title{margin:0 0 8px;font-size:16px;font-weight:600;line-height:1.4}
.dc-dialog-body{margin:0 0 12px;font-size:13px;color:var(--dsw-alias-label-secondary,#646a73);line-height:1.6}
.dc-section{margin-top:10px}
.dc-meta{font-size:12px;color:var(--dsw-alias-label-secondary,#646a73);margin-bottom:10px}
.dc-modes{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
.dc-mode{display:flex;gap:9px;align-items:flex-start;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1,#e5e6eb);border-radius:9px;cursor:pointer;background:var(--dsw-alias-bg-layer-1,#f7f8fa)}
.dc-live-warning{margin-top:10px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-warn-label,#b26a00);background:var(--dsw-alias-state-warn-tertiary,#fff7e6)}
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
.dc-header-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.dc-field{display:flex;flex-direction:column;gap:5px;margin:10px 0}
.dc-field-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}
.dc-textarea{height:auto;min-height:96px;padding:8px 9px;line-height:1.55;resize:vertical}
.dc-context{margin:12px 0 4px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1,#e5e6eb);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#f7f8fa)}
.dc-context-title{font-size:12px;font-weight:600;margin-bottom:2px}
.dc-context-list{margin:6px 0 0;padding-left:16px;font-size:11px;line-height:1.7;color:var(--dsw-alias-label-secondary,#646a73);word-break:break-all}
.dc-actions{display:flex;gap:8px;justify-content:flex-end;align-items:center;margin-top:14px;flex-wrap:wrap}
.dc-btn{height:30px;padding:0 12px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,#c9cdd4);background:var(--dsw-alias-bg-layer-1,#f7f8fa);color:var(--dsw-alias-label-primary,#1f2329);font:inherit;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:5px}
.dc-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#eff0f2)}
.dc-btn:disabled{opacity:.5;cursor:not-allowed}
/* --dsw-alias-brand-primary is a FILL that flips with the theme: near-black
   (#0f1115) in light, near-white (#f9fafb) in dark. Pairing it with a hard-coded
   white label made the primary button's text invisible on dark (contrast
   ~1.04:1) — that is the "确认按钮消失" report. The design system's counterpart
   for text on a primary fill is --dsw-alias-label-primary-inverted: white in
   light, neutral-800 (#353638) in dark. */
.dc-btn-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4d6bfe));border-color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4d6bfe));color:var(--dsw-alias-label-primary-inverted,#fff)}
.dc-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#4d6bfe))}
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
.dc-feedback-bar{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:12px 14px;margin-bottom:16px;border:1px solid var(--dsw-alias-brand-primary,#4d6bfe);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#f7f8fa)}
.dc-feedback-bar-text{min-width:220px;flex:1 1 auto}
.dc-feedback-bar-title{font-size:13px;font-weight:600;line-height:1.5}
.dc-feedback-bar-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#646a73);line-height:1.5;margin-top:2px}
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
.dc-row-select.dc-disabled{opacity:.55;cursor:not-allowed}
.dc-row-main{min-width:0;flex:1}
.dc-row-title{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dc-row-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.dc-row-time{font-size:11px;color:var(--dsw-alias-label-secondary,#646a73);white-space:nowrap}
.dc-inline-confirm{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
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
    // Exposed so the harness can assert the client budget stays ABOVE the
    // Host's own TRASH_LOCK_BUDGET_MS: whichever side gives up first decides
    // whether the user sees "failed" for work that actually completed.
    exports.__requestBudgets = {
      request: REQUEST_TIMEOUT_MS,
      mutation: MUTATION_TIMEOUT_MS,
      trashMutation: TRASH_MUTATION_TIMEOUT_MS,
    }
    exports.__apiUrl = apiUrl
    exports.__api = api
    // Direct component handles keep the hook-level behavior testable without a
    // DOM renderer (the registered wrapper alone only builds an element).
    exports.__components = { DeleteMenuRow, HeaderDeleteAction, DeleteDialog, SettingsSection, IncompleteEntries, BatchSessionRow, FeedbackDialog }
    exports.__validateFeedbackInput = validateFeedbackInput
    exports.__feedbackLimits = FEEDBACK_LIMITS
    exports.__selectableSessionIds = selectableSessionIds
    // Exposed because the retention notice lives inside a hook-heavy component
    // the harness cannot render: this is the piece that decides whether the user
    // is told at all, so it must be assertable against a real Host payload.
    exports.__retentionInfo = retentionInfo
    exports.__adapterLabel = adapterLabel
    exports.__adapterReason = adapterReason
    exports.__loadUiFlags = loadUiFlags
    return module.exports
  },
})
