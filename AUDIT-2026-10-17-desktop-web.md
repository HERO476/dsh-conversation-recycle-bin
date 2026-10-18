# dsh-conversation-recycle-bin 双环境兼容性审计

- 审计对象：`dsh-conversation-recycle-bin` 0.2.0（工作区源码）
- 宿主：DeepSeek Harness `0.2.1-rc.2`（桌面版 Electron 与 CLI `dsh web` 同版本）
- 审计日期：2026-10-17
- 方法：逐文件源码核对 + 与本机 DSH 0.2.1-rc.2 实际实现比对（`resources/app.asar` 与 CLI 安装目录）+ 84 个测试全量运行 + 本机审计/回收站/灵枢锁的只读检查 + 独立临时记忆库上的锁竞争复现。**未**做浏览器 UI 自动化，**未**改动用户的 profile / 记忆库。

---

## 0. 结论

1. **桌面版：插件已安装且确实可用。** `~/.dsh/profiles/desktop/package.json` 以 `link:` 引入并列入 bundles；`~/.dsh/delete-conversation/` 里保留着今天 21:13–21:18 由 UI 发起的 8 条审计记录（5 成功、**3 条 hard + 勾选记忆的删除全部在 memory 阶段回滚**），说明 Host 路由、4 个槽位、确认框与回收站都在桌面端跑通过，同时也直接暴露了 P0-1。84 个测试全部通过。
2. **网页版：插件根本没有安装。** `~/.dsh/profiles/web/package.json` 的 dependencies 与 `dsh.profile.bundles` 都没有它，`profiles/web/node_modules` 里也没有链接。因此“网页版运行表现”目前不是异常，而是**功能不存在**；下文关于网页版的结论是“若按同样方式安装后会怎样”的静态兼容性分析。
3. **即使安装到网页版，仍有三个会直接破坏核心功能的问题**：灵枢记忆锁协议不兼容（可让 `/delete` 永不返回并卡死整个变更队列）、灵枢索引直写不在其写协议内（记忆可能回放复活/被覆盖）、设置页批量删除的确认框被设置弹层遮住（批量删除实际上无法完成）。
4. 桌面端另有一条**平台特有**缺口：插件路由绕过 DSH 的 `connection` 鉴权与桌面更新/退出门禁，应用更新或退出可能在删除事务中途杀掉 Host。

---

## 1. 环境事实（可复核）

| 项 | 桌面版 | 网页版 |
|---|---|---|
| profile 目录 | `~/.dsh/profiles/desktop` | `~/.dsh/profiles/web` |
| 插件安装 | `link:D:/Users/34332/AI/dsh-conversation-recycle-bin`，已列入 bundles | **未安装**（无依赖、无 bundle、无 node_modules 链接） |
| UI 承载 | Electron，页面源 `dsh-app://app/` | 浏览器，`http://127.0.0.1:8080`（当前 `dsh web` 进程） |
| DSH 版本 | 0.2.1-rc.2 | 0.2.1-rc.2 |
| 数据目录 | `~/.dsh/delete-conversation/` | 同左（共享 DSH_HOME） |
| 灵枢存储 | `~/.dsh/.dsh-memory/data/mdcg`（schema 2，审计时 37 节点） | 同左 |
| 本次是否运行 | 审计时为未启动状态 | Host 在 8080 运行，但无插件 |

关键证据：

- `~/.dsh/delete-conversation/audit.jsonl`：8 条记录，其中 3 条为 `result:"rolled-back"`、`failedStep:"memory"`、`cause:"The memory store is busy; try again later."`（21:14:06、21:14:11、21:14:34 连续三次）。
- `~/.dsh/.dsh-memory/data/mdcg/_index.json.lock`：0 字节，mtime 21:13，至今仍存在。
- 桌面 Electron 主进程 `forwardWebRequest`（`app.asar` → `/lib/main.js` 8268 起）在转发前显式删除 `host`、`origin`、`cookie`、`sec-fetch-site` 四个头。
- 设置弹层 `.VOzbGW_overlay{z-index:1000;position:fixed}` 且 `createPortal(..., document.body)`；插件对话框挂在 `.overlayLayer{z-index:20}` 内。

---

## 2. P0：阻断级

### P0-1 灵枢锁协议不兼容：记忆导出可能永不返回；Windows 上表现为挂死，POSIX 上表现为互斥失效

- **平台**：Host 侧，桌面版与网页版共用同一份代码与同一个记忆库；故障形态随操作系统不同。
- **复现条件**：
  1. 会话有 ≥1 条关联灵枢节点（即勾选“同时删除关联记忆”且有实际数据）；
  2. 灵枢进程正在写索引（`_index.json.lock` 被其 `FileLock` 持有）；
  3. 触发 `/delete`（勾选记忆）或 `/trash/purge`/`restore` 走到记忆阶段。
- **实测**：用 `md_cg.fsutil.FileLock` 在独立临时库上按真实方式持锁，再调用适配器 `exportSession`（默认参数，1 个关联节点）：`timeout 8` 与 `timeout 12` 均被杀死（退出码 124），**没有抛出任何错误**；同一库在无关联节点时 2ms 返回（0.1.3 的 fast path 是有效的）。生产审计里对应的失败连续发生了 3 次，错误文案正是 `withLock` 的 “The memory store is busy”。
- **原因**：
  - 灵枢的 `FileLock` 是 **OS 级建议锁**：`open(path, "a+b")` + Windows `msvcrt.locking` / POSIX `flock`，锁文件**永远是 0 字节且永不删除**（`md_cg/fsutil.py` 124–165）。
  - 插件把“文件是否存在”当锁：`open(lockFile, "wx")`。只要灵枢跑过一次，锁文件就一直在，`wx` 必然 `EEXIST`。
  - 插件的“0 字节且超过 5s 即视为崩溃遗留”其实是灵枢的**正常锁**。判定 stale 后进入：    ```js
    if (stale) { await fsApi.rm(lockFile).catch(() => {}); continue }
    ```
    这一分支**既没有 sleep，也在超时判断之前**。Windows 上灵枢持有句柄时 `rm` 永远失败，`stale` 永远为真 → 无退出的忙循环（持续 unlink 系统调用），请求永不返回。
  - 后果不止单个请求：`lib/host/api.js` 的 `serialize()` 用一条 `mutationChain` 串行化所有变更；`/delete` 永不 settle 后，后续删除/恢复/清理全部排队等待，直到重启 Host。
  - 即便某次 `rm` 成功（灵枢此刻恰好没持有句柄），插件也只是删掉锁文件后自己建一个同名文件；md_cg 下次 `open("a+b")` 仍会打开同一路径并加自己的 OS 锁，而插件根本不参与那把锁 → 两个写者仍可同时整份读改写索引。**互斥在任何平台上都没有真正建立**；区别只是 Windows 多了一个“持锁期间永挂”的失败形态，POSIX 则是静默丢更新。
  - **对既有结论的更正**：CHANGELOG 0.1.3 与上一轮审计把 `_sustain`/`_index.json.lock` 的 0 字节锁判为“写入异常退出遗留”，并据此加了“5s 后清除无主锁”。这是误判——0 字节是 md_cg `FileLock` 的常态，锁文件也从不删除。0.1.3 的“修复”实际上制造了本次的挂死/互斥失效。
- **修复方向**：
  1. 不要用“存在性”模拟锁。要么用同一套 OS 锁（Node 侧 `flock`/`msvcrt.locking` 没有内置 API，需原生模块或子进程），要么**放弃直写**（见 P0-2）。
  2. 最低限度先修死循环：stale 分支加 `await sleep(25)`，并在 `rm` 后重新 `stat`/`open` 成功才继续；同时把超时判断放到分支之前。
  3. 永远不要 `rm` 灵枢的 `_index.json.lock`；0 字节不是崩溃信号。
  4. 测试需要按真实协议建模（现在 `test/memory.test.mjs` 把“非空内容的锁”当外部写者、把“0 字节锁”当崩溃遗留，与 md_cg 实际行为相反）。

### P0-2 灵枢索引直写不在其写协议内：删除可能被回放复活，或产生幽灵节点

- **平台**：桌面版、网页版（同一个 `.dsh-memory`，各自的 md_cg 进程）。
- **复现条件**：勾选记忆删除一个含有灵枢节点的会话；随后灵枢重新装载索引或执行自身 compact。
- **原因**（`md_cg/mdcg.py`）：
  - 灵枢的持久化不是单一 `_index.json`，而是“快照 + `_index_log` 分片日志”。装载时 `_load_index` 会先读快照，再 `_apply_log(idx["nodes"])` 逐条重放；记录是 dict 就 `nodes[nid] = e`（覆盖），是 `null` 才是 tombstone。
  - 插件只重写 `_index.json`，**不向 `_index_log` 追加 tombstone、也不清空它**；同时 md_cg 进程内存里还有一份快照。只要被删节点的记录还在 `_index_log`（上次 compact 之后创建/更新过），下次装载就会把节点加回来，而正文文件已被移动到回收站 → 典型“索引有条目、文件不存在”的幽灵节点。
  - 插件也不写灵枢的 `_audit.jsonl` / `_forgetting.jsonl`，灵枢自身完全不知道这次删除。
  - README §5.1 的“持 `_index.json.lock`（与 md_cg 写入方同一把锁，避免丢更新）”与实际实现不符（见 P0-1）。
- **修复方向**：
  1. 首选走灵枢支持的删除入口（其 `mdcg_forget` / bridge 的 forget 语义，带 receipt），而不是直接改索引；
  2. 若必须离线改，至少同时维护 `_index_log`：删除追加 `{"id": nid, "e": null}`，恢复追加节点记录，并在真实 OS 锁内完成；
  3. 在做到之前，把 `memory.deleteMode` 默认改为 `keep`（只统计、不删除），不要让“勾选记忆”成为默认可用选项；
  4. 文档按实际能力降级描述，不要声称“schema 2 的受支持子集”。

### P0-3 设置页“批量删除”的确认框被设置弹层遮住，功能实际不可用

- **平台**：桌面版与网页版（同一份客户端代码、同一版 ui-settings）。
- **复现条件**：设置 → “对话删除” → “批量删除” → 勾选任意会话 → 点“删除所选…”。
- **现象**：确认框不可见；点击原对话框位置会先关掉设置弹层，随后对话框才“突然出现”。批量删除是唯一必须在设置页内发起删除的入口，因此这条路径基本不可用。
- **原因**：
  - 设置面板是 `createPortal(..., document.body)` 的 `.VOzbGW_overlay{position:fixed;z-index:1000}`；
  - 插件的 `DialogHost` 注册在 `shell.overlay`，实际渲染在布局的 `.pI_x6G_overlayLayer{position:absolute;z-index:20}` 内；`.dc-backdrop` 的 `z-index:1000` 只是**该 stacking context 内**的值，无法越过父级的 20。
  - 设置弹层还通过 `useModalLayer(panel, true, onClose)` 接管模态层（焦点/Escape），插件对话框不在宿主的模态栈里；即使 z-index 修好，焦点也可能仍被设置面板锁住。
  - 同一个原因让 `flashStore` 的 toast（`z-index:1200`，同样在 overlayLayer 内）在设置页里不可见，所以“恢复成功/已清理”的反馈也看不到。
- **修复方向**：把确认框用 `createPortal` 挂到 `document.body`，z-index 取 1100+（高于设置弹层），并使用宿主 `ui-primitives` 的 `useModalLayer` 注册为真正的模态层；toast 同样 portal 到 body。

---

## 3. P1：高

### P1-1 桌面端路由绕过 `connection` 鉴权与桌面更新/退出门禁

- **平台**：桌面版（网页版同样没有鉴权，但没有更新锁这一层）。
- **复现条件**：桌面应用内触发“检查更新/安装更新”或退出，同时有一个耗时删除（live 会话、或记忆阶段）在跑。
- **原因**：
  - 插件用 `ctx.webServer.register({kind:'prefix'})` 直接挂路由，未走 `/api`，因此不经过 `connection.admit()`（浏览器 cookie 鉴权）与 `connection/request` waterfall。
  - 桌面端 `installDesktopUpdateTaskControl` 只在 `connection/request` 上拒绝 503 并等待在途请求；插件的请求不在其中，更新会直接进入 shutdown，删除事务可能被截断。
  - `installDesktopQuitInspection` 只看 `agents`/`jobs` 与 schedule，不知道插件在删会话，退出对话框不会提示。
  - 桌面 `forwardWebRequest` 删除了 `origin` 与 `sec-fetch-site`，所以 `requestOriginVerdict` 的 `requireSameOrigin` 在桌面端**实际不生效**；`dsh-app:` 信任分支在真实链路里是死代码（Origin 已被剥离）。剩下的唯一传输层防线是静态 header `x-conversation-recycle-bin: 1`。
- **修复方向**：改用 `ctx.connection.fetch.register({ path: '/api/...', methods, requestBody:'buffered', fetch })`（官方精确路由，天然要求已认证的 owner Peer，且受 `/api` 的 `connection/request` 门禁约束）；至少也在 handler 开头调用 `ctx.connection.requestRejection(req)`。退出侧可注册 `workspace/session-activity` 提供者，在删除进行中报告活动，让桌面退出检查可见。

### P1-2 硬删除 live 会话时跳过 foreign-writer 检查

- **平台**：桌面版 + 网页版同时运行（共享 DSH_HOME）时。
- **复现条件**：同一会话在另一 Host 中仍打开/可写，在当前 Host 执行“彻底删除”（`session.live === true`）。
- **原因**：`lib/host/catalog.js#assertNoForeignWriter` 第一行就是 `if (grace <= 0 || session.live === true) return`。设计上 live 交给 `quiesce`，但 `quiesce` 只能停**本进程**的 Agent；另一个 Host 的 writer 它看不见。于是最需要保护的场景（另一端正在写）恰好被豁免。README §2.3/§4.2/§8.6 都没有提这个豁免。
- **修复方向**：live 会话在 `quiesce` 完成后**仍然**做一次 mtime 复检（不要提前 return），或改为检查日志文件的独占句柄；无法独占就中止并报 `E_POLICY_FOREIGN_WRITER`。

### P1-3 软删除条目恢复失败时，回滚会把会话从工作区摘掉（并取消归档）

- **平台**：两版。
- **复现条件**：软删除时勾选了记忆（条目带 memory bundle）→ 在回收站点“恢复”→ 记忆恢复失败（P0-1 的 busy/挂死、bundle 缺失、第二个适配器失败均可）。
- **原因**：`performRestore` 的步骤是 messages（hard）→ session（catalog.restore）→ memory。memory 失败时回滚 session 步骤，而 `catalog.restore` 的 undo 是**无条件**的：
  ```js
  if (current !== null && current.sessionIds.includes(snapshot.sessionId)) {
    await current.detachSession(snapshot.sessionId)
  }
  ```
  软删除的会话本来就在 workspace 里（归档只是隐藏），`catalog.restore` 只做了 `unarchiveSession`；回滚却把它 **detach** 了 → 会话从侧栏彻底消失（日志还在磁盘、条目还在回收站）。同时 `snapshot.archived` 是删除前状态（false），undo 也不会重新归档。结果：一次失败的恢复让会话变成“孤儿”，重试恢复会 `attachSession` 重新挂回（位置丢到列表顶部），若记忆一直失败就一直是孤儿。
- **修复方向**：`catalog.restore` 要记录本次**实际做的变更**（是否 attach、是否 unarchive），undo 只反转自己做过的事；对软删除条目在回滚时重新 `archiveSession`。

### P1-4 “未完成条目”在 UI 里没有恢复入口

- **平台**：两版。
- **复现条件**：删除在 messages/catalog 阶段失败（或进程在移动日志后崩溃），`GET /trash` 把它列进 `incomplete`。
- **原因**：0.2.0 已让 `performRestore` 支持 `pending/failed/restoring/purging`，但 `client.js` 的 `IncompleteEntries` 只渲染“清理”（Discard）按钮，没有“恢复”。而 `performDiscard` 对仍持有 `session/` 的条目会拒绝——UI 提示“请改用恢复或彻底删除”，但界面没有恢复按钮，用户只能手工调 API。README §8.7 把这描述成“需按 INSTALL 排障手工处理”，实际是 UI 缺口。
- **修复方向**：在 `IncompleteEntries` 增加“恢复”按钮（调用已有的 `/trash/restore`），并按 `hasSessionLog`/`memory` 显示可用动作。

### P1-5 记忆导出失败留下的 bundle 目录让条目永久无法 discard

- **平台**：两版。
- **复现条件**：`exportSession` 已写出 `memory/<adapter>/bundle.json`（以及移动的正文），随后 `writeIndexAtomic` 失败（磁盘满/只读/索引被占）。
- **原因**：`exportSession` 的 catch 只还原 `movedFiles` 与 `pristine` 索引，**不删除已写出的 bundle 目录**；事务失败后 manifest 的 `memory.total` 仍是 0（步骤没返回），于是 `performRestore` 认为没有记忆可恢复、`performDiscard` 又因 `entryDir/memory` 非空而拒绝。这正是 0.2.0 修过的“失败条目卡死”的另一条未覆盖路径。
- **修复方向**：catch 里在还原文件后 `rm -rf bundleDir`；或让 `discard` 允许删除“manifest 未引用”的 memory 目录（并记审计）。

### P1-6 双 Host 共用 `delete-conversation/` 没有跨进程互斥（潜伏）

- **平台**：桌面版与网页版都装插件并同时运行时。
- **复现条件**：两个 Host 同时对同一 `trashId` 操作，或同时写 `audit.jsonl`。
- **原因**：`api.js` 的 `serialize()` 只在本进程内串行；`trash.write` 用固定的 `manifest.json.tmp`，`audit.append` 的压缩是整文件读改写；`performRestore`/`purge` 的 read-modify-write 没有文件锁。跨进程并发会丢更新/覆盖 manifest，审计行也可能被压缩窗口吞掉。
- **修复方向**：给 trash manifest 与 audit 加跨进程锁文件（或用 `proper-lockfile` 语义）；或在 `/state` 明确“同一 DSH_HOME 只允许一个 Host 使用本插件”，并在检测到第二个 Host 时拒绝变更。

---

## 4. P2：中

### P2-1 恢复/回滚不恢复会话在工作区中的位置

- **平台**：两版。
- **复现**：彻底删除一个非列表首位的会话 → 回收站恢复；或让 hard 删除在 catalog 之后的步骤失败触发回滚。
- **原因**：`catalog.restore` 与 `catalog.remove` 的 undo 都先调 `insertSessionBefore(id, anchor)`。但该 API 要求会话**已经在** `sessionIds` 里（否则抛 `WorkspaceMoveInvalidError`）；被 detach 的会话不在，于是必然走 catch → `attachSession`，而 `attachSession` 是 `[id, ...sessionIds]` **前插**。`capture` 记录的 `nextSessionId` 实际从未生效。
- **修复**：先 `attachSession(id)`，再 `insertSessionBefore(id, anchor)`；或在 catch 里先 attach 再 insert。README/catalog 注释里“恢复原位置”的说法需要与实现对齐。

### P2-2 软删除条目的 purge 崩溃窗口：日志会“隐身”，且一次恢复可能把它永久删掉

- **平台**：两版。
- **复现**：对软删除条目执行“彻底删除”，在日志已 move 到 `trash/<id>/session`、但 catalog 步骤尚未执行（或 `trash.remove` 尚未执行）时进程被杀。
- **原因**：`performPurge` 的 soft 分支把日志移进条目目录，却**不把 `sessionLog` 写回 manifest**；崩溃后条目是 `purging`，`entry.sessionLog` 与 `entry.catalog` 都可能是 null。
  - `performRestore` 对 soft 条目没有 messages 步骤，`catalog` 为 null 时只剩 memory 步骤；只要该条目当初勾选了记忆，恢复会在把记忆放回后执行 `trash.remove(entryDir)`，**把仍躺在条目里的 `session/` 日志一并删除** —— 这是真正会丢日志的路径。
  - 若条目没有可恢复的 memory，`performRestore` 报“nothing left to restore”，`performDiscard` 又因 `session/` 存在而拒绝 → 条目卡死，只能手工处理。
- **修复**：移动成功后立即 `trash.update({sessionLog: moved})`（或先写 `purging` + 位置，再移动）；`performRestore`/`performDiscard` 都要先检查磁盘上的 `session/`，不能只信 manifest。

### P2-3 多适配器恢复没有 undo，且边恢复边删 bundle

- **平台**：两版（配置了 lingshu + generic-json 时）。
- **原因**：`memoryService.restoreEntry` 逐个适配器 `restoreBundle` 后立刻 `rm(dirname(bundlePath))`；它不返回 undo。第二个适配器失败时，第一个适配器的 bundle 已被删、数据已回到 live store，条目却仍留在回收站，重试会因 bundle 文件缺失永远失败。
- **修复**：全部适配器成功后再统一删除 bundle；或为每个适配器返回可逆操作并在失败时回滚（至少保留 bundle 文件）。

### P2-4 `defaultMode` 是死配置

- **平台**：两版。
- **原因**：`DeleteDialog` 固定 `useState('soft')`，从不读取 `/state` 或 `/preview` 里的 `defaultMode`；`config.schema.json` 却写着“Initial mode selected in the confirmation dialog”。Host 侧 `normalizeMode` 的默认值只在客户端不传 `mode` 时才生效，而客户端每次都传。
- **修复**：对话框初始值改为 `state?.defaultMode ?? 'soft'`，或在文档/schema 里删掉该承诺。

### P2-5 语言检测读错字段，UI 永远跟随浏览器语言而不是应用语言

- **平台**：两版。
- **复现**：在 DSH 设置里把语言切到 English（系统仍是 zh-CN）→ 插件菜单/对话框仍是中文；反向同理。
- **原因**：`client.js#currentLocaleId` 找 `snapshot.locale ?? snapshot.id`，但 `dsh-client-locale` 的快照结构是 `{ active: '<locale id>', locales, revision }`（`getSnapshot()` 与 `bridge.onChange(locale.getSnapshot().active)` 都证实）。两个字段都不存在 → 回退到 `navigator.language`。
- **修复**：`const id = snapshot?.active ?? snapshot?.locale ?? snapshot?.id`。

### P2-6 `resolveDshHome` 不展开 `~`，与官方 `resolveDshHome` 不一致

- **平台**：两版（跨平台配置差异）。
- **复现**：`DSH_HOME=~/dsh-data` 启动。官方 `resolveRoot` 会 `expandHomePath` 再 `resolve`；插件直接 `join('~/dsh-data','delete-conversation')`，会在 cwd 下创建字面量 `~` 目录，回收站/审计落到错误位置。
- **修复**：复用 `@deepseek-ai/dsh-home-paths`，或至少实现同样的 `~`/`~/`/`~\` 展开与 `resolve()`。

### P2-7 批量“全选”会被单个 subagent/越界会话卡死

- **平台**：两版。
- **复现**：设置 → 批量删除 → 全选（列表含 subagent 会话或不在 `allowedWorkspaceRoots` 的会话）→ 删除。
- **原因**：`/sessions` 返回全部会话，UI 不显示 `origin`；`/preview` 只要有一个 id 被策略拒绝就**整批**不签发 token，客户端禁用删除按钮且只显示第一条原因。用户既不能删、也很难知道该去掉哪一条。
- **修复**：`/sessions` 过滤掉策略必然拒绝的会话（或标记不可选）；或允许“跳过被拒项，仅删除可删项”，并列出全部拒绝原因。

### P2-8 批量变更的超时上限可能小于最坏耗时

- **平台**：两版。
- **原因**：`mutationTimeoutMs = min(180000, 30000 + count*5000)`。最坏情况下每个 live 会话 `liveDrainMs` 2s + 记忆锁最多 6s（修复死循环后）+ 移动日志；50 个会话可超过 180s。客户端先超时，Host 继续执行，token 已消费，用户看到 `E_TIMEOUT` 后重试会与在途事务排队。
- **修复**：按“每项最坏耗时”估算或改为分批 + 进度；Host 侧提供 operation id 供客户端查询，而不是只靠 HTTP 超时。

### P2-9 `readJsonBody` 没有处理请求中止

- **平台**：两版。
- **原因**：只监听 `data`/`end`/`error`；客户端在发 body 期间断开（超时/关页）时 `end` 可能永不触发，Promise 不 settle。`/delete` 在 `serialize()` 里，会让后续变更全部排队。
- **修复**：监听 `req.on('aborted')`/`close`，以 `E_BAD_REQUEST` reject，并确保 `serialize` 的链能继续。

### P2-10 错误详情把宿主绝对路径带到客户端

- **平台**：两版（本地应用，敏感度低，但与“客户端只拿计数与状态”的契约冲突）。
- **原因**：`DeleteError.details` 原样进 `toWireError`；`readIndex`/`withLock`/`E_TRANSACTION_FAILED` 的 details 里带 `indexFile`、`lockFile`、`cause`（ENOENT 路径）。CHANGELOG 0.2.0 只移除了 `/state` 里的 `storage.*`。
- **修复**：错误 details 里对绝对路径做脱敏（只留 basename/相对 DSH_HOME 的路径）。

---

## 5. P3：低 / 文档

| # | 平台 | 问题 | 原因 / 建议 |
|---|---|---|---|
| P3-1 | 两版 | 每次激活打印 3 条假告警 | `cordis.patch.yml` 把可空字段写成 `null`，`readString` 只接受 `undefined`/string → `memory.lingshu.rootDir`、`memory.generic.indexFile/rootDir` 各报 `expected a string`。让 `readString` 接受 `null` 作为“未设置”。 |
| P3-2 | 两版 | 深色主题下 live 警告框不跟主题 | `--dsw-alias-text-warning` / `--dsw-alias-fill-warning` 在 0.2.1-rc.2 中不存在（实际是 `--dsw-alias-state-warn-label` / `-tertiary`），回退成 `#b26a00`/`#fff7e6` 的浅色块。`--dsw-alias-bg-overlay` 是存在的，对话框本身没有这个问题。 |
| P3-3 | 两版 | `locale/{en,zh}.json` 是死文件 | 客户端只读内联 `STRINGS`；JSON 的键集与内联表不同（`messages`/`memoryDeleted`/`error` vs `records`/...）。要么加载，要么删除，避免“改了不生效”。 |
| P3-4 | 网页版 | `sameHostname` 只比主机名，忽略端口与协议 | `http://127.0.0.1:3000` 的 Origin 与 `Host: 127.0.0.1:8080` 会被判同源。自定义 header 让浏览器预检挡住实际利用，但“同源校验”名不副实；应比较完整 authority。 |
| P3-5 | 桌面版 | `dsh-app:` 信任分支过宽且实际是死代码 | 桌面转发已剥离 Origin；若保留该分支，任何注册 `dsh-app:` scheme 的 Electron 应用都会被视为同源。建议删除或改为校验自定义头/nonce。 |
| P3-6 | 两版 | 会话 id 正则不接受 `.` | `SESSION_ID_PATTERN=/^[A-Za-z0-9_-]{6,80}$/`；DSH 的 `encodeSegment` 允许 `.`/`_`/`-`。当前 mint 的 id 不会命中，但 fork/自定义 id 会被误拒。 |
| P3-7 | POSIX | 工作区路径大小写比较不一致 | `gateway.workspaceFor` 对**所有**路径 `toLowerCase()`，Linux 上 `/a/Foo` 与 `/a/foo` 会误配；`policy.normalizePathForCompare` 只对盘符路径小写，且 UNC (`\\server\share`) 未按 Windows 语义处理。 |
| P3-8 | 两版 | 审计 `source` 固定 `web-ui` | 桌面端发起的操作也记成 `web-ui`，做平台取证时误导；建议按 `ctx` 所在宿主或 UA 区分 `desktop-ui`/`web-ui`。 |
| P3-9 | 两版 | 批量软删除的硬删除文案分支不可达 | `dialog.hardWarning`（“请输入 DELETE”）在 `expectedPhrase === ''` 时不会渲染；hard 模式永远一键。删掉该文案或改成分支说明。 |
| P3-10 | 两版 | 记忆适配器标签半本地化 | lingshu 的 label 是中英混合常量，`none` 是英文 reason；英文界面里会出现中文，反之亦然。 |

---

## 6. 平台差异导致的异常（汇总）

| 差异点 | 桌面版表现 | 网页版表现 |
|---|---|---|
| Origin/Sec-Fetch-Site | Electron `forwardWebRequest` 删除，`requireSameOrigin` 失效，`dsh-app:` 分支不可达 | 浏览器带 Origin，同源校验生效（且比官方实现宽松：忽略端口） |
| 鉴权 | 插件路由不走 `/api`，不校验 cookie；本地任意进程知道随机端口即可调用 | 同左（8080 固定，更易被本机进程发现） |
| 更新/退出门禁 | `connection/request` 503 + 等待；插件绕过 → 更新/退出可截断删除 | 无更新锁；Host 常驻，Ctrl+C/重启同样可截断 |
| 端口 | 每次启动 `--port 0` 随机 | 固定 8080（按启动参数） |
| Host 生命周期 | 随 app 退出，事务更易被打断 | 常驻，事务完整概率更高 |
| 远程访问 | 不适用 | `dsh web --host <非回环>` 默认被 `E_FORBIDDEN_HOST` 拒绝；`allowNonLoopback:true` 会放宽到无 cookie 校验的路由 |
| 另一 Host 同时写 | 共享 DSH_HOME；live 会话跳过 foreign-writer 检查 | 同左 |
| 插件安装 | 已安装、已跑通 | **未安装** |
| 记忆库 | 同一个 `.dsh-memory`，各自 md_cg 进程 | 同左；锁问题相同 |

---

## 7. 已验证正常（避免误报）

- 槽位契约与当前 DSH 一致：`sidebar.workspaces.session.menu.item` 的 owner props 是 `{sessionId, displayTitle}` 且提供 `useMenuOpenState`；`conversation.session.header.actions` 的标准 props 确实含 `sessionId`；`settings.section` 的 `label` 支持 thunk（`resolveSlotLabel`）；`shell.overlay` 存在且为 root list。
- Client 半的模块 id、`dsh.client.platform: "web"`、`exports["./client"]` 均符合 `dsh-client-modules` 的校验（桌面与网页都用 `web` 这一平台标识）。
- Host 依赖的服务在 0.2.1-rc.2 均存在：`webServer`、`sessionController.list/cancel`、`sessionPersistence.stat/list`、`sessions.get`、`workspaceRegistry.archive/unarchive/pin/unpin`、`Workspace.attach/insertSessionBefore/detach`。
- 会话目录发现同时兼容 `session-<uuid>` 与历史裸 UUID 目录；投影缓存路径/字段（`record.rows.title.val`、`sessionListMetadata.val.blank`）正确。
- `--dsw-alias-bg-overlay` 在 0.2.1-rc.2 中真实存在（浅色 `neutral-bluish-150`、深色 `neutral-bluish-700`），对话框背景不会在深色主题变白。
- 84 个测试全部通过（manifest 9、client 10、core 13、cascade 15、memory 9、trash-audit 3、api 25）。
- 灵枢库审计时为 37 节点、0 个缺失正文；本次审计**没有**改写过用户的记忆库。
- 记忆导出的“无关联节点”fast path 有效：零节点时 2ms 返回且不碰锁。

---

## 8. 未能验证 / 推断项

1. **没有做浏览器 UI 自动化**：桌面应用审计时未启动；网页版没装插件。P0-3 的“不可见/不可点击”来自 stacking context 与宿主模态层的代码分析，不是截图实证。
2. **`_index_log` 回放导致节点复活**：来自 `md_cg/mdcg.py` 的装载路径与分片日志格式分析，未在用户的真实库上制造删除来实证（避免破坏数据）。
3. **Windows 上 live 会话日志目录 rename 是否会被句柄阻塞**：未实测；Node 的 libuv 打开文件通常带 `FILE_SHARE_DELETE`，但 Agent 的写入方是否另有句柄未逐一核对，故未列为确定 bug。
4. **桌面更新/退出截断删除**：由 `desktop-host` 的门禁实现与插件绕过推出；未在真实更新过程中复现。
5. **网页版安装后的完整 UI 表现**：未安装、未重启 web Host，只做了组合兼容性分析。

---

## 9. 建议修复顺序

1. **先止血**：修 `withLock` 死循环（加 sleep + 超时前置 + 不删锁文件），并在文档/默认配置里把 `memory.deleteMode` 改为 `keep`，直到记忆写入方案重做（P0-1/P0-2）。
2. **修批量删除**：对话框 portal 到 `document.body` + 真正的 modal layer（P0-3）；顺带修 toast。
3. **桌面门禁**：改用 `connection.fetch.register`（或至少 `requestRejection`），并让退出检查能看到在途删除（P1-1）；去掉 live 的 foreign-writer 豁免（P1-2）。
4. **事务回滚正确性**：catalog.restore 的 undo 只反转自身变更（P1-3）；恢复后位置用 attach→insert（P2-1）；未完成条目加恢复按钮（P1-4）。
5. **收尾**：记忆导出失败清理 bundle（P1-5）、purge 记录 sessionLog（P2-2）、多适配器恢复原子性（P2-3）、跨进程锁（P1-6）。
6. **配置/文案**：`defaultMode`、locale `active`、`~` 展开、null 告警、README/CHANGELOG 的锁与同源表述。

---

## 10. 修复状态（2026-10-18，对应 0.2.2）

全部 P0–P3 条目已修复并通过 104 个测试回归（0.2.1 的 84 个之上新增 20 个）。下表为每条审计发现对应的修复落点与验证用例：

| # | 严重度 | 修复落点 | 验证 |
|---|---|---|---|
| P0-1 | 阻断 | `lib/core/file-lock.js`（新建）：插件私有锁 `_index.json.conversation-recycle-bin.lock`，pid/nonce 注册 + 心跳 + stale 判定 + 忙等超时；`lib/core/memory/json-index-adapter.js` 改为持有私有锁，**永不触碰/删除** md_cg 永久锁 | `lingshu adapter: the store lock is neither consulted nor deleted`、`a private lock held by a live owner fails cleanly, not forever`、`a stale private lock is broken instead of blocking forever` |
| P0-2 | 阻断 | `lingshu.js` 删除追加 `{"id, e:null}` 墓碑分片、恢复追加节点记录分片；`_t` 取 `max(now, 最新分片 _t + 1ms)` | `lingshu adapter: export appends tombstones and restored records to the md_cg shard log` |
| P0-3 | 阻断 | `client.js`：确认框 `createPortal(..., document.body)`、层级 1100；toast 一并 portal | `client: the dialog is portaled into document.body to escape the overlay stacking context`、`a host without react-dom still renders the overlay inline` |
| P1-1 | 高 | `lib/host/api.js`：变更路由先 `connection.requestRejection`（401/403 短路），再 `ctx.waterfall('connection/request', …)` | `connection: requestRejection short-circuits 401 and 403 before the route runs`、`a waterfall veto (the desktop update lock) returns 503 without touching the transaction` |
| P1-2 | 高 | `lib/host/catalog.js`：`assertNoForeignWriter` 删除 `session.live === true` 提前 return，所有模式复检 mtime | `hard delete: a log being written by another instance is not moved`、`an idle log is moved after the grace window` |
| P1-3 | 高 | `catalog.js`：`restore` 的 undo 记录实际变更（attach/unarchive），软删除回滚重新归档 | `hard delete: a catalog step refused halfway puts the archive flag back`、`delete: a failing session step rolls the message restore back` |
| P1-4 | 高 | `client.js`：`IncompleteEntries` 按 `hasSessionLog` 渲染「恢复」按钮 | `client: an incomplete entry that still holds its log offers a restore action` |
| P1-5 | 高 | `lingshu.js`：导出 catch 还原后删除未登记的 bundle 目录 | `lingshu adapter: a failed export removes its untracked bundle directory` |
| P1-6 | 高 | `lib/host/api.js`：mutation 串行链 + `<dataDir>/mutation.lock` 跨进程文件锁，抢不到返回 `E_LOCK_BUSY` | `mutation lock: a busy cross-process lock is E_LOCK_BUSY, not a corrupted manifest` |
| P2-1 | 中 | `catalog.js`：先 `attachSession` 再 `insertSessionBefore(id, anchor)` | `hard delete: …restore re-attaches it`、`restore: payload first, catalog second, memory last` |
| P2-2 | 中 | `cascade.js`：purge 移动日志后立即 `trash.update({sessionLog})`；恢复/discard 先查磁盘 `session/` | `purge: a soft entry performs the missing hard stages before removing the bundle`、`purge: a soft entry whose session is already gone only removes the bundle` |
| P2-3 | 中 | `lib/host/memory.js`：全部适配器恢复成功后才统一删除 bundle | `memory service: a multi-adapter restore keeps every bundle until all adapters succeed` |
| P2-4 | 中 | `client.js`：对话框初始模式读 `/state` 的 `defaultMode` | `client: ui flags carry the Host defaultMode instead of a hard-coded soft start` |
| P2-5 | 中 | `client.js`：`currentLocaleId` 读 `snapshot.active` | `client: the active locale is read from the snapshot field the host actually uses` |
| P2-6 | 中 | `lib/host/paths.js`：`~`/`~/`/`~\` 展开后 resolve | `core.test.mjs` 路径归一用例 + `normalizeConfig` 默认值 |
| P2-7 | 中 | `lib/host/api.js`：`/sessions` 每行带 `deletable` + `policyError`；`gateway.js` 修复行上 workspace 归属（cwd 回退）；`client.js`：`BatchSessionRow` 禁用 + 原因 + `selectableSessionIds` 过滤 | `sessions: each row carries a deletable verdict and the reason when it is not`、`client: the batch picker disables rows the Host refuses and says why` |
| P2-8 | 中 | `lib/host/api.js`：`/preview` 返回 `planTimeoutMs = min(900s, 15s + 16s×数量 + live数×liveDrainMs)`；客户端按它设超时 | `preview: the plan timeout grows with the batch so a long delete is not aborted client-side`、`client: mutation timeouts grow with the batch instead of a flat 15s` |
| P2-9 | 中 | `lib/host/api.js`：`readJsonBody` 监听 `aborted`，以 `E_BAD_REQUEST` 拒绝，serialize 链继续 | `body: a client that disconnects mid-body gets a 400, not a parked mutation chain` |
| P2-10 | 中 | `lib/core/redact.js`（新建）：details/cause/message 中的绝对路径降为 basename | `errors: unknown exceptions are normalized without leaking the message` + 安全测试 |
| P3-1 | 低 | `lib/core/config.js`：`readString` 接受 `null` 作为未设置 | `normalizeConfig: empty input yields the documented defaults` |
| P3-2 | 低 | `client.js`：改用 `--dsw-alias-state-warn-label` / `--dsw-alias-state-warn-tertiary` | 源码核对（CSS 变量，无单测） |
| P3-3 | 低 | 删除 `locale/{en,zh}.json` 死文件；`package.json` exports/files 清理；Client 内嵌两套文案 | `manifest: no shipped locale resources — the Client carries both inline tables` |
| P3-4 | 低 | `lib/host/api.js`：`requestOriginVerdict` 比较完整 authority（主机名 + 有效端口，缺失端口按 Origin scheme 归一） | `security: the full origin authority is compared, not just the hostname` |
| P3-5 | 低 | `lib/host/api.js`：桌面信任收紧为 `protocol === 'dsh-app:' && hostname === 'app'`（与 DSH 自身口径一致），`dsh-app://evil` 拒绝 | 同上（同用例覆盖两种分支） |
| P3-6 | 低 | `lib/host/api.js`：`SESSION_ID_PATTERN` 放开 `.` | `api.test.mjs` 会话 id 校验 |
| P3-7 | 低 | `lib/core/policy.js`：`normalizePathForCompare` 只对盘符/UNC 路径小写，POSIX 保持敏感 | `isPathInside compares Windows paths case-insensitively and by segment` |
| P3-8 | 低 | `lib/host/api.js`：`auditSource = process.versions.electron ? 'desktop-ui' : 'web-ui'` | `audit: the source records which shell asked (web UI vs the desktop app)` |
| P3-9 | 低 | `client.js`：删除不可达的 `dialog.hardWarning` 文案 | `client-module` 渲染冒烟 |
| P3-10 | 低 | `client.js`：`adapterLabel`/`adapterReason` 按语言本地化，未知 key 原样透出 | `client: adapter labels and reasons are localized, not raw Host ids` |
| — | 本轮新发现 | `lib/host/gateway.js`：`loadList` 行上无 workspace 对象导致 `/sessions` 每行误判 orphan、批量选择器全灰；增加 cwd 包含回退 | `sessions: each row carries a deletable verdict…` |

遗留的诚实边界（非缺陷，设计取舍）：网页版插件仍未安装到 `profiles/web`（安装动作属于用户操作）；`_index_log` 回放复活未在真实库上实证（避免破坏数据，已按 md_cg 装载路径实现分片写入）；Windows live 日志 rename 与句柄交互未实测；桌面更新截断删除未在真实更新中复现（已加门禁，机理明确）。

---

### 附：本次审计直接引用的实现位置

- 插件：`lib/host/api.js`（`requestOriginVerdict` 76–116、`serialize` 263–267、handler 648）、`lib/host/catalog.js`（`assertNoForeignWriter` 69–87、`remove` 163–220、`restore` 226–258）、`lib/core/memory/json-index-adapter.js`（`withLock` 128–186）、`lib/core/memory/registry.js`（164–184）、`lib/core/cascade.js`（`performRestore` 266–363、`performPurge` 382–467）、`lib/host/paths.js`（17–20）、`lib/core/config.js`（94–99）、`client.js`（locale 273–285、dialog 685–907、DialogHost 922–928、settings 打开 1217、注册 1359–1385、CSS 1249/1317）。
- DSH 0.2.1-rc.2：`app.asar` → `/lib/main.js` 8268–8310（`forwardWebRequest`）、`dsh-desktop-host/lib/index.js` 108–182、`dsh-client-connection/lib/index.js` 240–249/840–858/1035–1060、`dsh-client-ui-settings-general/lib/client.js` 60/280–305、`dsh-client-ui-layout/lib/client.js` 73/344–352、`dsh-client-locale/lib/client.js` 1219–1226/1250、`dsh-workspace/lib/index.js` 111–147。
- 灵枢：`@furongjun1999/dsh-memory/md_cg/fsutil.py` 124–165（FileLock）、`md_cg/mdcg.py` 1508/1513+（`_apply_log`）。
