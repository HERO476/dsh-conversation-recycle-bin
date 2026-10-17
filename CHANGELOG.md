# Changelog

All notable changes to `dsh-delete-conversation` are documented here.
The format follows Keep a Changelog; the project uses Semantic Versioning.

## [0.1.5] — 2026-10-17

### Fixed

- 批量**部分失败**不再被客户端当成「宿主拒绝」：`/delete` 完成即返回 `ok: true`（并附 `partial` 标志），`results` / `failures` 同时可见；客户端对旧宿主 `ok:false` + `results/failures` 的响应也按结果处理。此前成功的会话已删除、列表却不刷新，界面只显示英文 `The Host refused the request.`，`dialog.partial` 永远不可达。
- `/delete` 的拒绝保留真实策略码（`E_POLICY_LIVE` / `E_POLICY_PROTECTED` / `E_POLICY_ROOT` / `E_NOT_FOUND`…），不再一律写成 `E_POLICY_ORPHAN`，客户端因此能显示正确的中文原因。
- 批量上限与限流不再互相打架：新增 `limits.effectiveBatch = min(maxBatchSessions, 本分钟剩余额度)`，`/preview` 与 `/delete` 都按它校验；批量页超限时禁用按钮并提示，避免 21–50 的批量必然 429。额度为 0 时 `/preview` 直接返回带 `retryAfterMs` 的 429，不再让用户填完确认框才失败。
- 0.1.3 的无主锁修复补齐：等待预算只在锁为 0 字节时延长到 `ownerlessLockStaleMs + 500ms`（有内容的锁仍用调用方的超时），否则 2.5s 超时仍会早于 5s 判死；锁句柄写入失败时会关闭句柄并删除锁文件，不再遗留 0 字节锁。
- 回收站不再吞掉未完成条目：`GET /trash` 同时返回 `incomplete`（failed/pending/restoring/purging），设置页单独展示并可「清理」（`POST /trash/discard`，需输入 `DELETE`）；清理前检查磁盘上的 `session/` 与 `memory/` 副本（不只信 manifest），仍保存数据的条目会被拒绝并提示改用恢复/彻底删除。本机此前 3 条 `failed` 条目对 UI 完全不可见。
- 客户端变更请求超时按批量大小计算（`30s + 5s × 数量`，上限 180s），不再固定 15s；超时提示明确说明"操作可能仍在后台继续"。此前 8 个 live 会话的硬删除会在服务端仍在执行时先报超时，且 token 已被消费。
- `ui.showRowAction` / `ui.showHeaderAction` 真正生效：客户端启动时读一次 `/state`，按标志隐藏「…」菜单项与头部按钮。
- 0.1.4 设置页「批量删除」在删除后不刷新：新增 mutation 通知，设置页订阅并重取会话/回收站；同时清理已不存在的选中项。
- 0.1.4 当前会话关闭依赖 `uiWorkspace.clearArchivedCurrent/clearMain`（宿主声明为 private）：两者都不存在时回退整页刷新，不再留下"日志已被移走"的幽灵会话。
- 失败后重新预览保留已输入的确认短语（此前每次限流/过期都会清空，批量需重输数量）。
- `performRestore` 的内存步骤在回滚时不再调用 `undefined` 撤销函数。
- 新增 `E_POLICY_FOREIGN_WRITER` 与 `foreignWriterGraceMs`（默认 1500ms）：硬删除移动日志前复检最新 mtime，日志仍在增长（另一个 DSH Host 正在写）则中止，降低桌面端与网页端同时运行时的写坏风险。
- `PLUGIN_VERSION` 改由 `lib/version.js` 提供并与 `package.json` 断言一致（此前长期停在 `0.1.0`）；客户端补齐 `E_INTERNAL` / `E_NOT_FOUND` / `E_BAD_REQUEST` / `E_TRASH_*` / `E_FORBIDDEN_*` 等错误的中文文案。
- 确认 token 超过 512 个时只淘汰最旧的，不再一次性清空所有打开中的计划。

### Tests

- 77 checks; added partial-batch wire shape, real refusal code, effective batch limit, incomplete-entry listing/discard, foreign-writer guard (both directions), fresh ownerless lock, client partial payload, private-method reload fallback, UI-flag hiding, version consistency.

## [0.1.4] — 2026-10-17

### Changed

- 删除、恢复、回收站清理成功后不再整页刷新：Client 通过宿主 `sessions.refresh()` 原地拉取会话列表；若删掉的正是当前打开的会话，再用 `uiWorkspace.clearArchivedCurrent()` / `clearMain()` 关闭当前视图，回到空白页。恢复只刷新列表，不打断当前会话；回收站清理只刷新回收站本身。
- `window.location.reload()` 仅作为兜底：宿主缺少 client `sessions` 服务或刷新接口失败时才启用，避免升级到旧宿主后留下过期列表。

### Tests

- Tests: 64 checks; added `client: updates the shell in place after a mutation`（原地刷新、关闭当前会话、恢复不打断、兜底重载四条路径）。

## [0.1.3] — 2026-10-17

### Fixed

- 彻底删除在「对话框显示未找到关联记忆」时仍失败：灵枢适配器的 `exportSession()` 过去无论有没有要迁移的节点都会获取 `_index.json.lock`；灵枢遗留的 0 字节锁（例如 `_sustain` 写入异常退出）会让每次删除等待 2.5s 后报 `E_MEMORY_FAILED: The memory store is busy`。现在**先读索引、零个可删节点直接返回空 bundle，不取锁、不等待**；非空导出仍在锁内重新计算节点，保持并发安全。
- 无主锁（0 字节、无 pid）超过 `ownerlessLockStaleMs`（默认 5s）即判定为崩溃遗留并清除，不再被 `staleLockMs=120s` 长时间阻塞；带内容的锁仍是原有 120s 阈值。索引只有几十 KB，5s 不会误判正常写入。
- 删除失败的报错不再一闪而过：Client 的 `load()` 重新预览时会清空 `error`，导致失败横幅在重载后立刻消失、按钮看起来「没反应」。现在失败后的刷新使用 `{ preserveError: true }`，错误保留在对话框中。
- Tests: 63 checks; added `a conversation with no linked memory does not need the store lock` and `an ownerless stale lock is broken instead of blocking forever`.

## [0.1.2] — 2026-10-17

### Changed

- 「彻底删除」不再要求输入 `DELETE`（批量也不再输入数量）：在确认框里点删除按钮即执行。Host 仍要求 `/preview` 签发的单次 token（绑定排序后的 sessionIds + includeMemory + mode，TTL 120s），因此过期、篡改、重放的计划仍会被拒绝；批量**软删除**仍输入数量，回收站「永久清除」仍输入 `DELETE`（不可逆操作）。
- Client 在 hard 模式下不再渲染确认短语输入框；live 会话「会先停止该会话」的警告保留。
- Tests: 61 checks; added `batch: permanent deletion is one click, with no batch-size phrase`, updated hard/live/rollback tests to delete without a phrase.

## [0.1.1] — 2026-10-17

### Fixed

- 彻底删除曾被 live 会话策略挡住：DSH 会在内存中保留最近用过的会话（`live: true`），即使空闲，hard 模式也直接返回 `E_POLICY_LIVE`，确认框因此禁用删除按钮，用户无法直接彻底删除。
- Hard 删除与回收站彻底清理现在先执行 `quiesce`：`sessionController.cancel` 取消当前轮次 → `workspaceRegistry.archiveSession({stopActivity:true})` 建立停止栅栏 → 在有界的 `liveDrainMs`（默认 2000ms）内轮询到 `running=false`，再移动日志；停不下来则整个事务回滚并报可读的 `E_POLICY_LIVE`。
- 配置项 `allowLiveSessionDelete` 由 `stopLiveSessions`（默认 `true`）与 `liveDrainMs`（默认 `2000`）取代；`stopLiveSessions: false` 仍可恢复严格拒绝。
- 确认框在 hard 模式选中 live 会话时显示「会先停止该会话」的警告，而不是禁用删除；live 会话的 hard 删除保留归档墓碑，防止已排队的唤醒在日志移走后重建会话（恢复回收站条目时清除）。

## [0.1.0] — 2026-10-17

Initial implementation for DSH `0.2.1-rc.2` (Web profile).

### Added

- Host + Web Client two-half bundle, zero build (plain ESM + `window.__ModuleLoader__`), installed through `plugin_manager install_bundle`.
- Delete entry points:
  - `sidebar.workspaces.session.menu.item` row ("删除对话…", order 500) that closes the menu before opening the dialog;
  - `conversation.session.header.actions` icon action (order 100);
  - `settings.section` page (order 1300) with recycle bin, batch deletion and audit tabs;
  - `shell.overlay` dialog host, so the dialog survives the menu item's unmount.
- Confirmation dialog with soft-delete default, memory checkbox default OFF, live memory count from `POST /preview`, protected-entry count, and typed second confirmation (batch size for batches, `DELETE` for permanent deletion).
- Transactional cascade `memory → messages → session/catalog` with reverse-order rollback per conversation; batch items are independent transactions.
- Recycle bin under `<DSH_HOME>/delete-conversation/trash/`:
  - soft delete archives through `workspaceRegistry.archiveSession({stopActivity:true})` and keeps the log on disk;
  - hard delete moves the session log directory into the bundle;
  - restore/really-delete endpoints; purge requires the `DELETE` phrase.
- Memory adapters:
  - `lingshu`: `_index.json` schema 2 adapter keyed by the node `session` field; protected/immutable nodes preserved; cross-node `edges/depends_on/derived_from` references stripped on export and restored on rollback; holds the store's `_index.json.lock` and writes the restore bundle before rewriting the index;
  - `generic-json`: configurable JSON-index adapter for other local stores;
  - `none`: honest unavailable fallback (reports a reason instead of a misleading zero).
- Safety and audit:
  - same-origin check, private `x-delete-conversation: 1` header, loopback-only by default, body-size ceiling;
  - sliding-window rate limit (default 20 deletions/minute) and `maxBatchSessions` (default 50);
  - single-use confirmation tokens bound to `(sessionIds, includeMemory, mode)` with TTL;
  - JSONL audit trail with success / rolled-back / rollback-incomplete / denied / restore / purge records and size-based compaction;
  - policy refusals for protected ids, orphan sessions, subagent sessions, out-of-root workspaces and live-session hard deletion.
- No agent tool is registered: deletion remains a user-only authority.
- Configuration: `normalizeConfig` (strict defaults, safe fallbacks, warnings), `config.schema.json`, `cordis.patch.yml` defaults layer; deliberately no `Config` schema export (no schema-runtime dependency).
- Tests: 54 checks in seven files covering the required matrix (single delete, batch delete, memory checked, no permission, delete failure + rollback) plus manifest/locale/icon, a browser-free Client-half registration/render harness, and adapter round-trip tests.
- Docs: `README.md` (host contract, data model, cascade, safety, honest limitations), `INSTALL.md` (install, verification checklist, rollback, troubleshooting), this changelog.

### Fixed

- Client bundle registration id changed from `delete-conversation` to the package name `dsh-delete-conversation`. The boot graph keys every client row by `package.json#name`; a bundle registering under another id was treated as "loaded without registering", re-executed from its one-resource URL, and aborted web boot with `client-modules: duplicate factory registration for "delete-conversation"` plus `dsh-delete-conversation: import failed`. `test/client-module.test.mjs` now asserts the registration id equals the package name.

### Known limitations

- DSH exposes no official session-delete API; hard deletion is a plugin-owned offline move and must not run against a live writer.
- The 灵枢 adapter edits the md_cg index directly (with its lock) and does not write 灵枢's own `_deletions.jsonl` ledger; use `lingshu_cg op=forget` when that protocol is required.
- Hindsight (bank-scoped, disabled for DSH, no delete tool) and Mnemon documents (archive-only, cross-session) are intentionally not part of the default cascade and are reported as unsupported.
- The UI is validated at manifest/slot-contract level; visual acceptance requires a browser (see INSTALL §2.4).
