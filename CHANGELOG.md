# Changelog

All notable changes to `dsh-conversation-recycle-bin` are documented here.
The format follows Keep a Changelog; the project uses Semantic Versioning.

## [0.3.15] — 2026-10-31

dsh-go（Android）适配性审计后的修复。审计结论：Host 半边开箱可用（手机里跑的是真 Node 24 + 原版 DSH 引擎），问题全在**前端座位**与**移动端输入**上。

### Fixed

- **原生界面里删除按钮全都没有反应**（dsh-go 侧 `shell.overlay` 是 opt-in 座位，确认框宿主不挂载）：新增 `useInlineDialogState()`，检测到 overlay 宿主没有挂载时，把**同一个确认框内联**渲染在设置页「批量删除」标签页里。桌面端/网页端有座位时行为不变（`overlaySeatMounted` 标记 + 500ms 宽限，避免闪一下内联副本）。
- **`DELETE` 短语在手机上永远对不上**：Android 输入法会把首字母大写，`purgePhrase.trim() !== 'DELETE'` 于是让按钮永久灰掉、没有任何提示。现在 Client 的 `phraseMatches()` 与 Host 的 `deletePlan`/`purgeEntry`/`discardEntry` 三处比对都**忽略大小写并去空格**；三个输入框补 `autoCapitalize`/`autoCorrect`/`spellCheck`（计数短语用 `inputMode: 'numeric'`）。
- **非 JSON 拒绝被报成「无法解析的响应」**：dsh-go 的 `route-guard.diff` 在插件路由之前返回 `text/plain` 401/503。新增 `httpFallbackError(response)`，按状态码映射成 `E_UNAUTHORIZED`/`E_DISABLED`/`E_BAD_RESPONSE`，并在响应头带 `x-dsh-go-guard: reject` 时把原因写进文案（"dsh-go route guard"）。
- **`E_LOCK_BUSY` 是死胡同**：错误信息补上锁文件路径与"持续出现就删掉它"的指引，`details.lockPath` 一并返回（手机被杀进程后残留锁最长阻塞 20 分钟，用户此前没有任何自救手段）。

### Changed

- 回收站横幅文案补充「清理只在 Host 运行时发生」：App 关闭期间清扫不执行，下次启动补扫。
- README 新增 §8.1「dsh-go（Android）适配」：网页模式/原生界面的差异、opt-in 座位导致的降级路径、市场默认隐藏 web-only 插件需点「显示网页版插件」、DSH Remote 无网页版。

### Tests

- `test/client-module.test.mjs`（25 → 28）：短语忽略大小写与空期望值；非 JSON 拒绝按状态码映射（含 `x-dsh-go-guard` 分支）；**没有 overlay 座位时设置页把同一个确认框内联渲染**（无 payload 时不渲染空壳，有 payload 时挂上真正的 `DeleteDialog` 并给出原因提示）。
- `test/api.test.mjs`（63 → 64）：`DELETE` 短语大小写不敏感（`Delete me` 仍 400 `E_CONFIRM_PHRASE`，`delete` 通过）。
- 合计 188 → **192**（干净树 `rm -rf test/.tmp` 后全绿）。

## [0.3.14] — 2026-10-30

第二轮独立审计（架构 / 安全 / 验收各跑 186 条、并做了变异测试与真实探针）之后的修复：一条会**删掉唯一副本**的读盘失败被当成「空目录」，一条会把用户**刚恢复的对话**再删一次，还有一类条目**三条出路全拒**却仍在 UI 上提供「恢复」按钮。

### Fixed

- **`hasFiles()` 不再把「读不到」当成「没有文件」**（`lib/host/api.js`）：`catch { return false }` 让 Windows 的 EPERM/EBUSY 读失败等价于「空目录」，`canDiscard` 因此为 true，丢弃该条目会连同唯一的 `memory/` bundle 一起删除。现在只有 `ENOENT`/`ENOTDIR` 才算空，其它错误抛出；`entryDisk()` 捕获后按 **「可能有文件」** 上报，`performDiscard()` 的 `hasFiles` 失败同样按「有文件」拒绝。
- **保留期清扫不再删除用户刚恢复的会话**（`lib/core/cascade.js`、`lib/host/api.js`）：`performPurge` 的 soft 分支只看 `session.live`，不看 `archived`；用户 unarchive 之后，1.5s 的 gateway 缓存窗口内执行清扫会 quiesce 并硬删这个**正在使用的**会话。现在 purge 先判 `archived === false` 并抛 `E_SESSION_ALIVE`（409，新增码），清扫在拿锁后先 `gateway.invalidate()` 再 inspect，被跳过的条目按 6 小时退避，不再每轮刷一次失败。
- **purge 的状态写入挪到判定之后**：`inspect()` 曾放在 `trash.update(status:'purging')` 之后且不在 try 内，一次 inspect 异常就把条目永久留在 `purging`（既不可恢复也不再被保留期清扫）。
- **头不可读的日志条目现在有出路**：日志在盘上但读不出 `cwd`（截断、编码不对、缺少 header）时，条目永远到不了终态，而「恢复」会答"没有可恢复的内容"、"丢弃"又说"还持有日志"、purge 因状态不可达 —— 三条路全拒，磁盘空间占着。现在：`entryCapabilities()` 接受 `payloadRecoverable: false`，`canRestore` 为 false、`canDiscard` 为 true；`performRestore` 明确报「日志读不出，请丢弃」；`performDiscard` 在重建路径失败时允许删除（仍要求输入确认短语）。
- **`ops.hasFiles` 的 `readdir` 结果只在目录存在时解释**，未捕获的非 ENOENT 错误不再被静默吞掉。

### Changed

- **`engines.node` 从 `>=20` 提高到 `>=22.15`**：代码用到 22.x 的 `readdir(..., { recursive: true })` 与 `AbortSignal` 行为，而 `>=20` 让 DSH 在 Node 20 上安装本插件后必然崩。
- 测试夹具 `makeTempHome()` 先 `mkdir test/.tmp`：干净检出上 `mkdtemp` 会 ENOENT，之前能过只是因为某个套件恰好先跑并顺手建了目录（干净树实测 160 pass / 26 fail）。

### Tests

- 新增 `session log stage: the mapping is persisted before the directory moves`（真实 `moveToTrash` + 真实文件系统，断言 `beforeMove` 时源目录仍在、目标尚不存在）。把 `catalog.js` 里 `moveDirectory` 与 `beforeMove` 调换后该用例失败——此前这处变异**全套 186 条仍绿**。
- 新增 `unrecoverable log: not restorable, and discard is the way out`（真实目录 + 头不可读 → `canRestore:false`、`canDiscard:true`、restore 报错文案、discard 成功）。
- `trash: a corrupt manifest is surfaced as unreadable and discardable once empty` 更新为符合新语义，并补一条「manifest 损坏但 `memory/` 有文件 → 仍拒绝丢弃」。
- 测试 186 → **188**；干净树（先删 `test/.tmp`）`node --test test/*.test.mjs` 全绿，不再依赖套件执行顺序。

## [0.3.13] — 2026-10-29

2026-10-29 桌面端 / 网页端 bug 复核报告（`AUDIT-2026-10-29-desktop-web.md`）中的 4 条功能缺陷与 1 条文档偏差，本版全部修掉。

### Fixed

- **默认 soft 条目的 30 天自动清理永远不会执行（高）**：清扫过去只要会话"仍可解析"就跳过（`E_SESSION_ALIVE`），而 soft 删除的定义就是保留日志、归档后仍可被 `sessionPersistence.stat` 解析——默认方式删除的条目因此 100% 逃过保留期。现在只有会话**已被用户复活（`archived === false`）或仍在运行**时才跳过；仍处于归档状态（`archived === true`）的 soft 条目会像 hard 条目一样被 `performPurge` 清理。归档状态读不到时继续保守跳过。
- **hard 删除在"日志已移动、manifest 未记录"的崩溃窗口里成为死条目（中）**：`messages` 步骤现在**先**把 `{from,to}` 写入 manifest，再执行目录移动；`session` 步骤也先落盘 catalog 快照再改工作区。即使进程在两步之间崩溃，两侧都可恢复（日志还在原位，或日志在回收站且目标已知）。
- **旧版遗留的死条目仍可恢复**：`performRestore` 发现 `sessionLog: null` 且 `<entry>/session` 存在时，会从日志首行的 `cwd` 重建原路径（按 DSH 的 `projectKey` / `encodeSegment` 规则），把日志移回后再走 catalog 恢复。`node:zlib` 的 zstd 解码在 Node 22.15+ 才存在，故按需加载；更老的 Node 上该恢复路径会明确失败而不是让插件导入失败。
- **`/trash` 的 capabilities 与路由不一致（低）**：`serializeEntry` 现在读取 `<entry>/session` 与 `<entry>/memory` 的磁盘载荷，并以此计算 `canRestore`（无任何载荷的 failed/pending 条目为 `false`）与 `canDiscard`（仍持有日志/记忆文件为 `false`）；无法读取 manifest 的目录也带同一套 capabilities。
- **只有记忆包的未完成条目在 UI 没有恢复入口（低）**：`IncompleteEntries` 改为按 Host 的 `capabilities.canRestore` / `canDiscard` 渲染按钮，不再只看 `hasSessionLog`；旧 Host 未下发 capabilities 时保留原判断作为兜底。
- **CHANGELOG 0.3.12 的 token 描述与实现不符（文档）**：实现只在**整批零失败**时作废 token（`failures.length === 0`）；部分或全部失败都保留 token，便于重试同一计划。0.3.12 条目已按实现更正，README 同步。

### Tests

- 新增 8 条：归档 soft 条目到期被清、复活 soft 条目被保留、日志映射在移动前落盘、崩溃窗口日志映射重建后可恢复、无载荷条目 `canRestore:false`、磁盘载荷阻止 discard、Client 按 capabilities 显示恢复/丢弃、zstd 日志头重建 `projectKey`。测试 178 → **186**。

## [0.3.12] — 2026-10-29

0.3.9 那一轮三方审计留下的 15 条，这次全部清掉。其中一条是**锁毒化**：一次删不掉的锁文件会让后续所有删除/恢复一直返回 `E_LOCK_BUSY`，直到重启进程。

### Fixed

- **锁毒化（P1）**：`release()` 删不掉锁文件时，过去只 `warn` 一句就走人 —— 残留锁的 `owner.pid` 是**自己这个活进程**，而 stale 判定对活 owner 永不放行，于是下一次 `acquire()` 必定失败，之后每一次 mutation 都是 409，只能重启。现在 release 失败会把锁体降级成 `{pid: null, at: 0}`（并把 mtime 拨到纪元），下一次 acquire 按"无主且超龄"立即破锁；实在写不进去才留 warn。
- **PID 复用**：心跳每 5 秒刷新一次 mtime，所以"十拍未刷新"（`staleMs * 10`）就按残留锁处理并告警，不再出现"这个 pid 恰好被别的进程复用、于是永远破不了锁"。
- **队列超时不再撒谎**：计时器过去从入队一直武装到结束，操作其实已经开跑时仍返回"没有执行"。现在操作一开始就 `clearTimeout`，只有真正还在排队时才报 `E_QUEUE_TIMEOUT`。
- **客户端预算不再比宿主早 60 秒**：`/preview` 与 `/state` 的 `limits` 新增 `queueTimeoutMs`（宿主实际使用的队列预算），客户端优先用它；过去客户端只按锁预算推算，宿主的队列预算比它多 60 秒，于是"还在跑"看起来像超时失败。
- **`running` 不再被兜成 `false`**：`gateway.inspect()` 的 `running: fromList?.running ?? false` 让"宿主没说"和"已停止"无法区分，`lifecycle.js` 的 fail-closed 分支成了死代码。现在保留 `undefined`，并且 `probeRunning()` 能回答时以它为准（`agents.get(id)?.status === 'running'`）。
- **空闲会话又能删了**：硬删闸门过去看 `live`（"宿主还知道这个会话"），空闲会话也满足，于是 `stopLiveSessions: false` 时所有空闲对话都删不掉。现在看 `session.running`；宿主不报状态时才按严格读法（未知视为在跑）。
- **`capabilities` 不再是死字段**：回收站行的「恢复」/「彻底删除」按 `entry.capabilities.canRestore/canPurge` 置灰，不再让用户点了才知道会被拒。
- **新错误码有文案了**：`E_QUEUE_TIMEOUT`、`E_ABANDONED` 补上中英文案。
- **审计标题对称**：purge/discard 记录统一写 `title: null`（键保留），delete/restore 仍写真实标题，消费者不必按 action 分支解析。
- **`trash.update()` 不再写垃圾 manifest**：条目读不到时返回 `null`，而不是把 `null` 展开成 `{trashId: null, ...}` 写进目录 —— 那种目录永远列不出、恢复不了、也 discard 不掉。
- **manifest 的 `sessionId` 要过校验**：它会被 `join` 进 workspace 路径，手改 manifest 不能借 `..` 把清扫指到别处。
- **路径守卫 fail-closed**：`performRestore` 在组合没提供 `isInsideSessionsRoot`/`isInsideTrashDir` 时改为拒绝（过去默认放行，等于守卫可选）。
- **确认令牌不再被部分失败烧掉**：只有**整批零失败**时才作废 token；部分失败或全部失败都保留，可用同一个 token 重试剩余项（token 绑定 `(ids, mode, includeMemory)`，重放只会重跑同一计划）。
- **没有 connection 层时 `/state` 仍可读**：过去整站 401，面板只能显示"未授权"，用户无从得知该配 `requireConnection: false`。现在 `/state` 返回 200 并带 `connectionFence: false`，会话列表与回收站照旧 401。

### Tests

- 新增 8 条：锁降级后可再次获取、十拍未心跳破锁、`limits.queueTimeoutMs` 与 `TRASH_LOCK_BUDGET_MS + 60s` 一致、无 fence 时 `/state` 可读而其它端点 401、部分失败后 token 仍可用、`capabilities` 出现在条目上、越界 `sessionId` 的 manifest 不可读、缺路径守卫时拒绝恢复。测试 170 → **178**。

## [0.3.11] — 2026-10-27

0.3.10 的修漏。上一版把「30 天自动清理」接上了，但三位独立审计各自复现出同一批问题：**后端真的在删，前端一个字都没说**，而且插件被关掉之后它还在删。本版把 8 条全部修掉。

### Fixed

- **自动清理的提示根本不会显示**（高，必现）：`client.js` 读的是 `state.trashRetentionDays`，而 Host 把它放在 `state.limits.trashRetentionDays` —— 于是横幅与每行的"N 天后自动清理"永远不渲染，用户看到的只是条目某天凭空消失。现在统一走 `retentionInfo()`，从 `limits` 读，并优先使用 Host 下发的每条 `daysLeft`（浏览器时钟偏差不会再承诺一个 Host 不认的日期）。
- **`enabled: false` 拦不住后台清理**（高，数据销毁）：`sweepExpiredTrash()` 只看 `trashRetentionDays`，不看总开关；`lib/index.js` 的 60 秒/6 小时定时器也无条件注册 —— 用户关掉插件后 HTTP 全部 503（连回收站都打不开），后台却仍在按保留期永久删除条目和记忆包。现在清扫第一行就判 `config.enabled !== true`，禁用时定时器干脆不注册。读接口仍然可用（能看到箱子里有什么），只是不再自动删。
- **打开回收站会等写锁，甚至顺手删掉本次要列出的条目**（中）：`trashList()` 里是 `await sweepExpiredTrash()`，清扫要取跨进程 mutation 锁（预算 180 s，队列预算再加 60 s），而客户端 15 s 就超时 —— 一次 restore/purge 进行中打开回收站，看到的是空白页，重试还会复用同一个 in-flight 请求。现在列表只 `void sweep()`，清扫在后台跑，`GET` 不再有删除副作用。
- **无人值守时可能删掉"复活的会话"**（中）：`performPurge` 对 soft 条目会在会话又能被解析时 quiesce 并硬删。手动清理时这是对的，但 30 天后的定时器不该替用户做这个决定。现在清扫遇到 `mode: 'soft'` 且会话仍可解析的条目会跳过（记 `E_SESSION_ALIVE`，留给用户自己处理）。
- **清理不可见**（中）：`/trash` 现在带 `lastSweep: { at, purged, failed }`，面板会写明"Host 已在后台自动清理 N 条"；审计行也显示 `source`，自动清理与手动彻底删除不再长得一模一样。
- **失败重试无退避**（低）：单条失败从"每 5 分钟无脑重试"改为指数退避（5 min → 10 → 20 …，上限 6 h），并保留失败原因。
- **`daysUntilExpiry()` 是死代码**（低）：现在 Host 在 `serializeEntry()` 里真的用它，每条带 `daysLeft` 与 `expiresAt`；顺带修掉"已恢复的条目也显示倒计时"和"0 d"两种空头承诺。
- 单次清扫上限（20）不再在两处各写一遍常量，`retention.js` 导出 `DEFAULT_MAX_PER_RUN` 给 Host 复用。

### Tests

- `test/retention.test.mjs` 8 → 10 条（默认上限共用、永不清理的行不给倒计时）；`test/client-module.test.mjs` 新增 1 条，直接断言 `__retentionInfo()` 对**真实 Host 形状**（`limits.trashRetentionDays`）的解读；`test/api.test.mjs` 52 → 55 条（禁用不清理、列表不等锁、每条带倒计时）。测试 164 → **170**。

## [0.3.10] — 2026-10-27

回收站「30 天后自动清理」。这一版把一个**从 0.3.0 起就写在配置里、但从来没人读**的旋钮（`trashRetentionDays`）真正接上了逻辑。

### Added

- **`lib/core/retention.js`**：纯函数选期 —— `selectExpired(entries, { retentionDays, now, limit })` 只挑 `status: 'trashed'`、`deletedAt` 可解析且早于窗口的条目，最旧优先；`daysUntilExpiry()` 供 UI 显示剩余天数。任何"说不准"的输入（`retentionDays <= 0`、`deletedAt` 缺失/非法、`trashId` 为空、`now` 非有限值）一律**不清**，宁可留着让人自己删。
- **Host 侧清扫**：`lib/host/api.js` 新增 `sweepExpiredTrash({ force })`，`trashList()` 每次先扫（5 分钟节流）；`lib/index.js` 另加 6 小时定时（启动后 60 秒先扫一次，`unref` 不影响退出）。清扫走与「永久清除」**完全相同**的 `performPurge`，并且在跨进程 mutation 锁内**重新读 manifest、复判 `entryCapabilities().canPurge`**（scan 发生在锁外，期间条目可能已被恢复），单次最多 20 条，单条失败不中断整轮。
- **UI**：回收站面板顶部写明"条目在删除 N 天后自动清理"（`trashRetentionDays: 0` 时不显示），每行显示"N 天后自动清理"。
- 审计：自动清理的记录与手动彻底删除同形，额外带 `source: 'retention'`，可与用户操作区分。

### Changed

- `config.schema.json` 里 `trashRetentionDays` 的说明改为实际行为（每 6 小时 + 每次列表时检查，0 = 关闭）。

### Tests

- 新增 `test/retention.test.mjs`（8 条纯函数用例），`test/api.test.mjs` 追加 3 条集成用例（过期条目被下一次列表清掉、`0` 关闭清扫、从未提交的残留条目永不清扫）。测试 153 → **164**。

## [0.3.9] — 2026-10-27

0.3.8 的紧急修复：**所有删除都会被拒绝**，返回 `409 E_ABANDONED`（"The client disconnected before this request ran; nothing was changed."）。0.3.8 发布后不到一天即被用户在使用中撞到。

### Fixed

- **`clientGone()` 把每一个正常请求都当成"客户端已断开"**：0.3.8 为了修 R-01（客户端中止后 Host 照样执行），在 `lib/host/api.js` 里加了断连检测，其中一条是 `req.destroyed === true`。但 Node 的 `IncomingMessage` 在请求体被读完后就自动 destroy 可读侧，所以**任何一次正常 POST 在读完 body 之后 `req.destroyed` 都是 `true`**（Node 24 实测：`{req.destroyed:true, req.aborted:false, req.complete:true, res.destroyed:false, res.socket.destroyed:false}`）。结果是删除、恢复、彻底删除、丢弃四条路由全部在开跑前被判为"客户端已断开"。
  现在只用**能在正常请求中存活**的信号：`res.destroyed`、`res.writableEnded`、`res.socket`/`req.socket` 的 `destroyed`。`req.destroyed` 与已废弃的 `req.aborted` 不再参与判定，代码注释里记了实测值，避免以后有人再加回去。
- 新增回归用例 **"queue: a fully read body is not a disconnect"**：构造一个 `req.destroyed/readableEnded/complete` 全为 `true` 的请求，断言删除仍然成功、会话确实进了回收站。0.3.8 的写法会让这条用例失败。

### Maintenance

- 测试 152 → **153**；`lib/version.js` 与 `package.json` 同步到 0.3.9。

## [0.3.8] — 2026-10-26

技术方案评审团（架构 / 安全 / 验收三方）对 0.3.7 的复核结论是 15 条问题、142 条测试全绿但 **NEEDS WORK**。本版把它们全部修掉，测试 142 → **152**。

### Fixed — 数据安全

- **ARCH-1 删除崩溃后记忆永久孤儿**：`lib/core/cascade.js` 的记忆步骤只改内存里的 `entry.memory`，从不落盘。若在"记忆已导出"与"manifest 写入 `status: 'trashed'`"之间崩溃，条目会停在 `pending` 且 `memory.total = 0`，而真实 bundle 只存在于 `<trashId>/memory/<adapter>/bundle.json`；此后 restore（"nothing left to restore"）、discard（"still holds memory files"）、purge（"cannot be purged"）三条路全部拒绝，用户没有任何出口。现在导出后立即 `trash.update(entry.trashId, { memory: bundle })`（失败先 `memory.restoreEntry(bundle)` 补偿再抛）；恢复路径在 `includeMemory` 为真但 manifest 说没有记忆时，用新增的 `memory.readExported()` 从磁盘重建摘要。
- **ARCH-1 次生风险**：恢复成功后原本无条件 `trash.remove()`，记忆未回灌时会删掉唯一副本。现在只有 `memory/` 目录确实为空（`ops.hasFiles` 探测，异常按"仍有文件"处理）才删条目，返回值新增 `memoryLeftOnDisk`。
- **R-02 缺 `sessions` 服务时硬删运行中会话**：`lib/host/gateway.js` 的 `isLive()` 原先只看 `sessions`，而宿主的运行判定看 `agents`。现在两个信号任一为真即视为 live，不再跳过 quiesce。
- **ARCH-3 运行态未知被当成"没在跑"**：`lib/host/lifecycle.js` 的 `inspectRunning()` 现在对"探针与 inspect 都给不出布尔值"的情形 fail-closed 返回 `true`，由 `liveDrainMs` 的 deadline 兜底并回滚归档。

### Fixed — 可用性

- **ARCH-2 / R-01 请求永久挂起（P0）**：两层都有问题，一并修。
  - 跨进程锁 `lib/core/file-lock.js`：stale 分支删不掉锁文件时**无 sleep、无 deadline**，实测 3 秒内自旋 3235 次、永不返回。现在每轮都 `sleep`、循环顶部检查预算，连续 3 次删不掉即抛 `E_LOCK_BUSY`；stale 判定改为"pid 可证明已死 → 立即破锁 / 无 owner 只按 age / **持有者活着绝不按 age 破**"（长 GC 不再放第二个写者进来）。
  - 进程内队列 `lib/host/api.js` 的 `serialize()`：`mutationChain.then` 没有任何预算，客户端中止后 Host 照样执行。现在队列预算 = `lockTimeoutMs + 60s` 宽限，超时抛新增的 `E_QUEUE_TIMEOUT`(503)；并在"开跑前"与"拿到跨进程锁后"各查一次客户端是否已断开（`clientGone()`），断开则抛新增的 `E_ABANDONED`(409)，绝不落盘。
- **R-07 软删静默掐断当前回合**：软删同样 `archiveSession(id, { stopActivity: true })`，会中断正在跑的回合。`lib/core/policy.js` 现在对 `mode === 'soft' && live` 给出明确 warning，预览页在点击前就会显示。
- **R-03 恢复后把"已归档"变成"可见"**：`inspect()` 原先 `archived: fromList?.archived ?? false`，而 `controller.list()` 不保证携带归档态。现在以 `workspaceRegistry` 为权威（`state.archived.has(id) || fromList?.archived === true`，pinned 同理），恢复才真正"回到删除前的状态"。
- **ARCH-5 能力判定口径分裂**：新增 `entryCapabilities(entry, disk)` 统一 restore/purge/discard 的判定，`serializeEntry()` 额外输出 `capabilities`，避免再出现"UI 给按钮、三个接口全拒"的死胡同。

### Fixed — 安全加固

- **S1 鉴权层异常时 fail-open**：`connection.requestRejection()` 抛错原先被 `catch { rejection = undefined }` 吞掉并放行。现在记 `logger.error` 并返回 503 `E_INTERNAL`；任何非 `undefined/null` 的拒绝值一律拒绝（`401`→401、`403`→403、其它→503）。
- **S5 无 connection 服务时本机任意进程可删**：新增 `config.requireConnection`（**默认 `true`**）。组合里没有 `connection` 服务时，所有路由返回 401 `E_UNAUTHORIZED` 并提示如何显式降级；`config.schema.json` 已同步。
- **S2 非法回收站 id 变成目录存在性探测**：`discard` 入口先过 `isTrashId()`，`trash.entryDir()` 也改抛 `DeleteError('E_BAD_REQUEST')` 而不是普通 `Error`（原先逃逸成 500，且与 404 可区分）。
- **S3 manifest 可指向任意路径**：恢复前校验 `sessionLog.from` 必须在 `sessionsRoot` 内、`sessionLog.to` 必须在回收站目录内，否则 `E_TRASH_CONFLICT`。
- **S4 彻底删除后标题仍留在审计里**：purge / discard 的审计记录不再写 `title`；`/trash/audit` 的返回统一过 `redactDetails()`，绝对路径不上线。

### Maintenance

- 测试 142 → **152**：新增"stale 锁删不掉必须报错而不是自旋"、"非法 id 必须 400"、"鉴权层抛错必须 503"、"客户端已断开不得执行"、"记忆 bundle 必须落盘"、"pending 条目可从磁盘恢复"、"manifest 越界必须拒绝"、"purge 审计不含标题"、"软删运行中会话必须有 warning"、"无 connection 服务默认被拒"。
- `lib/version.js` 与 `package.json` 同步到 0.3.8。

## [0.3.7] — 2026-10-24

### Fixed

- **深色主题下主按钮文字不可见（「确认按钮消失」）**：`.dc-btn-primary` 用 `--dsw-alias-brand-primary` 作填充、却把文字写死成 `#fff`。该 token 是**会随主题反转的填充色**：浅色主题为 `neutral-bluish-1000`（rgb(15,17,21)，近黑），深色主题为 `neutral-bluish-50`（rgb(249,250,251)，近白）。于是深色主题下是「近白底 + 白字」，对比度约 1.04:1，删除成功对话框右下角只剩一个白块。改为填充用 `--dsw-alias-button-primary-fill`、文字用 `--dsw-alias-label-primary-inverted`（浅色 = 白、深色 = `neutral-bluish-800` rgb(53,54,56)），悬停改用 `--dsw-alias-button-primary-hover` 并去掉 `filter:brightness(.94)`。新增用例把这条配对钉住，防止再用字面色值。

## [0.3.6] — 2026-10-24

对应 `AUDIT-2026-10-24-desktop-web-rc3.md` §7 的四条「建议动作」（A2 / A3 / A5 / A6）。同一节的 A1、A4、A7、A8 复核后判定为产品取舍（不申报未直接消费的 client 依赖、不导出 `Config` 以免设置页脱离非表单语义、归档读保留双源缓存、`missingSessionPaths` 保持成员判定），本版不改。

### Fixed

- **A3 `sessionController` 缺失时抛出的不是插件错误**：`lib/host/lifecycle.js` 新增 `peek()`，把 `ctx.get?.(name) ?? ctx[name]` 的整条退化读取留在 `try` 内。`??` 右侧的属性读会命中 cordis 的 Proxy trap（`cannot get property "sessionController" without inject`），异常类型不是 `DeleteError`，会绕过统一错误映射并让删除在归档前失败。现在 `sessionController` 明确视为可选服务：缺失时跳过 `cancel`，归档与 drain 检查照常执行。新增用例以抛异常的 getter 模拟裁剪组合，断言归档仍然发生。
- **A6 运行中判定永远落到 `inspect()`**：`lib/host/gateway.js` 的 `probeRunning()` 改为主探 `agents.get(id)?.status === 'running'`（与宿主 `dsh-api-session-controller` 列表行的判据一致），旧的 `Session.running/active/busy` 字段探测降为兜底。删除前置的「是否运行中」现在真正走廉价的实时探测，不必为每次判定重读会话。
- **A2 事件数列恒为 `—`**：`stat()` 从不返回 `eventCount`，旧代码读的正是这个不存在的字段。活跃会话改用 `Session.seq`（会话存储将其定义为日志长度，精确、纯数值读，不触发已废弃的 `snapshotEvents()`）；已落盘的非活跃会话没有便宜的精确来源，继续返回 `null`、由 UI 显示 `—`，不拿投影游标冒充精确值。新增两个用例（活跃 = 精确值、非活跃 = `null`），并把测试夹具的 `stat()` 改成 0.2.1 的真实形状（去掉 `eventCount`），避免此前的假绿。

### Added

- **A5 `engines.dsh`**：`package.json` 声明 `"dsh": ">=0.2.1-rc.2"`（本插件的实测下限）。该键在安装/声明时由版本闸门读取，运行时不强制；不设上界，因为更晚的版本尚未验证。

### Maintenance

- 测试 138 → **141**（api 41 → 44：活跃/非活跃事件数、无 `sessionController` 的裁剪组合、agents 三态运行判定）。
- `lib/version.js` 与 `package.json` 同步到 0.3.6（`manifest` 用例守门）。

## [0.3.5] — 2026-10-22

对应 `AUDIT-2026-10-22-desktop-web-compat.md`：把 0.3.4 之后一直只存在于工作树的修复正式发布，并落地该报告 §9 的全部建议。

### Fixed

- **C-01 前缀部署下所有 API 丢失路径前缀**：`client.js` 新增 `apiUrl()`，用 `new URL('.', document.baseURI)` 归一化 base 并去掉 `API_PREFIX` 的前导斜杠，改为文档相对解析。`dsh web --public-url https://host/ui/` 下不再 404；桌面 `dsh-app://app/` 行为不变。0.3.4 的 tarball 仍带此缺陷（`new URL('/conversation-recycle-bin/api…', base)` 会替换整个 base 路径）。新增回归用例断言三种 base（根、`…/ui/`、`…/ui/index.html`、`dsh-app://app/`）解析结果。
- **C-02 回收站写操作超时短于宿主排队**：客户端 `TRASH_MUTATION_TIMEOUT_MS = 195s`，宿主 `TRASH_LOCK_BUDGET_MS = 180s`（此前 15s / 30s）。批量删除进行中再点恢复/彻底删除，不再出现"界面报错但宿主已执行"。
- **C-08 锁预算用例一直是红的**：该用例用软删除条目测 `discard`，而软删除按设计保留会话日志，`performDiscard` 必然返回 `E_TRASH_CONFLICT`（409）。改为 seed 一个从未提交的 `pending` 条目（无 `session/`、无 `memory/`），api 用例数 40 → 41 全绿。此前 0.3.4 的 `npm test` 因该用例无法通过而不能作为发布门禁。

### Added

- **C-03 `allowedHosts`**：反代部署的精确 authority 白名单（`host`、`host:port`、`[v6]:port`）。裸主机放行任意端口，带端口的条目只放行该端口；带 scheme/路径/userinfo/通配符的条目会被丢弃并写入 warnings。默认 `[]` = 仅回环，与 0.3.4 行为一致。这样不必为了让反代可用而整体打开 `allowNonLoopback`。`config.schema.json`、`cordis.patch.yml`、README §4.2 同步。

### Changed / Performance

- **P-01 `/trash` 双扫描合并**：`trash.scanAll()` 一次 `readdir` 产出 `{entries, unreadable}`，每条目只读一次 manifest，读取用 8 并发（此前 `listAll` + `scanUnreadable` 各扫一遍，合计 2 次 readdir + 2N 次读，且 `listAll` 串行）。0/50/200/500 条实测 1.2/17.2/63.3/156.3 ms → **1/4.9/14.4/38.1 ms**。
- **P-02 `/preview` 记忆索引只解析一次**：适配器按 `mtimeMs:size` 缓存已解析快照，`probe()` 与 `countSessions()` 共用；本适配器每次写索引后主动失效，其他进程改写由 stat key 识别。21000 节点（1.9 MB）单条预览 39.2 → **28.9 ms**（剩余部分是单次读盘 + 解析的固有成本）。
- **P-05 设置页按 tab 懒加载**：挂载/切换只拉当前 tab 需要的接口（回收站 `/trash`、批量 `/sessions`、审计 `/audit`），`/state` 仅在挂载与变更后取；刷新期间面板不再卸载，改为顶部细条指示，滚动位置与输入焦点不再丢失。对应把每次刷新 4 个请求（≈31 KB）降为 1–2 个。
- **P-04 宽限等待可见化**：彻底删除模式下对话框说明"刚使用过的对话可能多等约 1.5 秒"；提交超过 1.2s 后显示"仍在执行：正在确认没有其他 DSH 实例写入该对话"。等待本身（`foreignWriterGraceMs`）是安全设计，未取消。

### Maintenance

- 测试 131 → **138**（api 41、client 22、core 15、memory 13、cascade 15、feedback 19、manifest 9、trash-audit 4）。
- README 状态 0.2.2 → 0.3.5，用例计数与设置页/反代说明同步。

## [0.3.4] — 2026-10-20

对应 `AUDIT-2026-10-20-last3-versions.md` 的四条非阻塞隐患 N1–N4，以及测试驱动下新发现的 P3 回归 N5。

### Fixed

- **N1：批量删除中途限流会静默丢尾项**：`deletePlan` 循环里 `!reservation.ok` 分支的 `break` 改为 `continue`。0.3.3 之前当第二 Host 在 preflight 与 take 之间抢走额度、或 `sessions.length > limiter.remaining`（跨进程 / 时间窗滑动）时，第一条被拒之后的所有 session 既不进 `results` 也不进 `failures`——一次 50 项批量 + 20/min 上限下，第 22–50 项从 UI 反馈里凭空消失。`continue` 让每一项各得一条 `E_RATE_LIMITED` 记录；首个项目预算不足直接抛 429 的既有契约不变。新增 `test/api.test.mjs` 用例：monkey-patch limiter 让 take 从第二次起即失败，断言 3 项批量 → 1 结果 + 2 失败。
- **N2：审计 `tail()` 字节窗口对齐到 `\n` 时丢一条完整记录**：`start > 0` 分支不再无条件 `rawLines.slice(1)`——先读 `start-1` 一字节，`\n` 意味着窗口从行首开始，`rawLines[0]` 是完整 JSON 保留；否则才丢。同时 `CHUNK` 抽为 `createAuditLog({ tailWindowBytes })` 便于回归。新增 `test/trash-audit.test.mjs` 用例：对齐窗口断言三条完整记录全在，偏移 1 字节窗口断言撕裂片段被正确丢弃。
- **N5（连带发现）：`tail()` 从未真正做窗口读**：Node `fs.readFile(path, {encoding,flag,signal})` 不接受 `start/end`，0.3.3 P3「只读尾部 256KB」的实现其实每次仍全量读盘。改用 `fsApi.open(filePath, 'r')` + `FileHandle.read(buffer, offset, length, position)` 的位置化读，`stat` 也走 handle；`fsApi` 类型签名加 `open`。修复后 5MB 审计文件 tail 只吃 256KB 内存，与 P3 原意一致。
- **N3：HTTP 反馈通道对自定义鉴权头也强加 `Bearer ` 前缀**：`deliverHttp` 现只在 `authHeader === 'Authorization'` 时前缀 `Bearer `（RFC 7235 语法的合法要求），其它如 `X-Api-Key` / `x-goog-api-key` 直接发送裸 token——多数非 `Authorization` 中转拒绝 Bearer 前缀，此前配任何自定义头都会 401。默认 `Authorization` 通道逐字节不变。新增 `test/feedback.test.mjs` 双 case 用例（Bearer vs 裸 token）。
- **N4：`visitorAsFrom: true` 的 UI 提示未说明与常见发信方冲突**：`feedback.emailHintAsFrom` 词条中英各扩写为完整句子，说明「QQ / 163 / Gmail 一类要求 From 与登录账号一致会拒收，仅允许任意 From 的中继才生效」。行为不变、配置不变。

### Changed / Maintenance

- 回归测试：`api` 38 → 39、`feedback` 18 → 19、`trash-audit` 3 → 4；总 128 → **131 全绿**。

## [0.3.3] — 2026-10-19

本次修复对应 `AUDIT-2026-10-19-review.md` 的 S1–S3、P1–P5、R1–R4 与 M 项；每条均带回归测试。

### Security

- **S1：`Host` 头不带端口时同源端口比较被恒真绕过**：`requestPort === ''` 时旧表达式退化为 `originPort === originPort`，任意端口的 Origin 都通过。现在缺失端口按 Origin 自身 scheme 的默认端口归一（http→80、https→443），`Host: 127.0.0.1` + `Origin: http://127.0.0.1:9999` 被拒为 `403 E_FORBIDDEN_ORIGIN`，而 `http://127.0.0.1`（无端口）仍放行。

### Fixed

- **S2：未知 GET 路由误报 405**：路径不存在时 GET/POST 统一返回 `404 E_NOT_FOUND`，405 只保留给「路径存在但方法错误」。
- **S3：损坏/缺失 manifest 的回收站目录永久隐身**：新增 `trash.scanUnreadable()`（missing / corrupt / unreadable 三类），`/trash` 把它们列为 `status: 'unreadable'` 的 incomplete 项；`discard` 对目录存在但清单不可读的条目走 `performDiscard` 的磁盘检查——空目录可强制清理，仍持有 `session/` 日志或记忆文件则拒绝（`409 E_TRASH_CONFLICT`），不再只能手动删盘。
- **P1：live drain 轮询每轮全量重建会话列表**：`inspectRunning` 先走新增的 `gateway.isRunning(sessionId)` 内存存活表探针（`running/active/busy` 布尔），探针答不出才回退全量 `inspect()`，批量删除多个 live 会话时不再线性放大 `controller.list()` 与工作区扫描。
- **P2：`/trash` 每次全量读盘解析 manifest**：加 1.5s TTL 缓存，delete/restore/purge/discard 成功后主动失效。
- **P3：`/audit` 全量读 5MB 再解析**：`tail()` 只读尾部 256KB 块、丢弃首条残行，malformed 只统计窗口内。
- **P4：跨进程锁等待 30s 短于批量最坏耗时**：`/delete` 锁预算按 `min(900s, 15s + 16s×批量数 + 每 live 会话的 drain 窗口)` 估算，大批量不再被第二个 Host 误判 `E_LOCK_BUSY`。
- **P5：全部 blocked 时仍做全量记忆计数**：`blocked.length > 0` 时跳过 `countForSessions`，返回 `{total:0, skipped:true}` 形状。
- **R1：请求体超限后继续读完整个 body**：超限立即 `finish(413)`，慢速超大请求不再占着连接。
- **R2：反馈投递失败也扣每小时额度**：`takeSlot` 返回 `release()`，传输失败 catch 里先退还槽位再抛 `E_FEEDBACK_TRANSPORT`；成功投递才计数，SMTP/HTTP 临时故障不会把用户锁一小时。
- **R3：批量列表按 soft 固定裁决，与 `defaultMode` 脱节**：`/sessions` 每行裁决改用 `config.defaultMode`；`stopLiveSessions:false` + hard 默认时，不可删的 live 行直接标 `deletable:false`。
- **R4：失败的删除项也占每分钟额度**：`limiter.take(1)` 改为带 `release()` 的预留，单条失败在 catch 里退还槽位，只有真正成功的删除计入窗口；首个 item 预算不足直接抛 429 的既有契约不变。

### Changed / Maintenance

- **M2：会话 ID 正则去重**：抽出 `lib/core/ids.js` 的 `SESSION_ID_PATTERN`，`api.js` / `gateway.js` 共享，删除两处本地副本。
- **M4：`/state` 不再外泄记忆适配器绝对路径**：只输出 `{id,label,available,reason}`，`storePath` 不离开 Host。
- **M1：删除无引用的死 CSS `.dc-mode-preferred`**。
- **M3：`npm run check` 改为 `scripts/check-syntax.mjs` 遍历 `lib/**/*.js` + `client.js` 逐个 `node --check`**（原链式清单只覆盖 3 个文件，新增/改名模块不会再漏检）。
- 回归测试：`feedback` 17 → 18、`core` 13 → 14、`api` 34 → 38；新增覆盖 S1 无端口 Host、S2 未知路由 404、S3 损坏清单列出/清理/冲突、R2 失败退额度、R3 默认模式裁决、R4 失败退额度。

## [0.3.2] — 2026-10-18

### Fixed

- **`feedback.visitorAsFrom` 在 HTTP 通道静默失效**：HTTP 通道此前固定发送配置的 `from`（未配置则省略字段），`visitorAsFrom: true` 只在 SMTP 通道生效。现在 HTTP 通道同样在显式开启且访客填写了邮箱时把访客邮箱作为 `From`；默认配置下发送的请求体逐字节不变。
- **邮件正文把访客邮箱标注为发件人**：正文上下文里的 `from / 发件人` 行改为如实的 `visitor / 访客邮箱`。此前无论 `visitorAsFrom` 是否开启，该行都把访客邮箱标成发件人，与真实 `From`（发信账号或访客邮箱）不符；`reply-to` 行保留不变。

## [0.3.1] — 2026-10-18

### Added

- **表单改为让用户填写自己的邮箱**：反馈对话框里原来的「联系方式」换成「你的邮箱（选填）」`type="email"` 输入框，客户端与 Host 双重校验（必须是 `a@b.cc` 形状、≤200 字）。格式不合法直接以 `400 E_FEEDBACK_INVALID` + `details.field === 'email'` 拒绝，而不是默默发一封无法回复的邮件。
- 新增配置项 **`feedback.visitorAsFrom`**（默认 `false`）：访客填写的邮箱默认写入 `Reply-To`，并在正文的 `from / 发件人` 行展示；设为 `true` 时同时作为 `From`——只有允许任意发件人的中继才行，QQ/163/Gmail 会拒收（要求 From 与登录账号一致）。`/state.feedback.visitorAsFrom` 会同步给前端，用于切换输入框下方的提示文案。

### Changed

- 邮件正文上下文字段由 `contact:` 改为 `from / 发件人:` + `reply-to:` 两行；HTTP 通道的 `reply_to` 取自访客邮箱。
- `test/feedback.test.mjs` 16 → 17 个用例（新增 `resolveSender` 发件人策略单测、非法邮箱拒绝）；`test/client-module.test.mjs` 20 → 19（删除一条逐字节重复的用例外壳，行为覆盖不变），全量仍为 122。`README.md` §9.2 增加 `visitorAsFrom` 行与「发件人不是访客邮箱」排查项；`config.schema.json` / `cordis.patch.yml` 同步新键。

### Fixed

- **删除当前会话后的结果对话框会被兜底刷新抹掉**：Host 无法原地关闭该会话时会 arm 一次兜底刷新，原来是固定 900ms 后 `location.reload()`，弹窗里的「部分失败明细」根本来不及看。现在结果对话框会等用户关闭（按钮 / Escape / 点遮罩）后再刷新，5s 只是对话框被晾着的安全网；关闭时还会 `clearTimeout` 掉安全网计时器，避免关掉之后又被刷一次。对应文案 `dialog.reloadHint` 由「会话列表将自动刷新」改为「关闭本对话框后会刷新会话列表」。
- **反馈表单的邮箱校验顺序与 Host 相反**：客户端先判超长再判格式，300 字的地址会提示「不是邮箱」，而 Host 对同一次提交回的是「太长」。现在两边统一为「先形状、后长度」（对齐 `lib/host/feedback.js:241-250`）。
- **「记忆不可用」的原因混进英文硬编码**：无可用存储时 `not detected` 直接拼进中文文案。改用词条 `state.notDetected`（中英各一条）。
- **反馈表单的校验提示只在「输入过」时出现**：只用 Tab 扫过表单、一个字符没改的用户会看到一个禁用的提交按钮却看不到原因。现在「改过」或「离开过任一字段」（`dirty || touched`）即显示提示。
- **`noValidate` 挂在 `div` 上**：这是 form 的属性，放在对话框的 `div` 上无效，属误导性死属性，已删除（本组件不含 `<form>`，本身也不会触发原生校验）。
- **`test/client-module.test.mjs` 里有一条逐字节重复的用例**：同一段 `test('client: the active locale …')` 出现两次（HEAD 即如此），实际独立用例 19 条而计数写 20。删掉重复的一份，覆盖不变。

## [0.3.0] — 2026-10-18

### Added

- **设置页「反馈」横幅（`feedback` 配置段 + `POST /conversation-recycle-bin/api/feedback`）**：设置页最上方新增一条「反馈」横幅（主色按钮，位于标题之上；`dc-feedback-bar`），表单含类型（问题 / 建议 / 其他）、标题、正文、可选联系方式，并自动附带插件版本、平台与语言（不含任何对话内容）。提交时按钮进入「正在发送…」禁用态，成功后弹 toast 并关闭对话框，失败按错误码给出可读原因。Host 侧 `lib/host/feedback.js` 负责校验、渲染与投递：标题 4–120 字、正文 10–4000 字、联系方式 ≤200 字（Host 复核，客户端只是提前禁用按钮）；每条反馈每小时默认最多 5 条（`feedback.rateLimitPerHour`），全部从操作者自己的邮箱发出。
- **两种投递通道，均为环境变量注入凭证**：`http`（`DSH_CRB_MAIL_API_URL` + `DSH_CRB_MAIL_API_TOKEN`，POST JSON）与 `smtp`（`DSH_CRB_SMTP_URL`，按需 `import('nodemailer')`）。`nodemailer` 只声明为 `optionalDependencies`（`^10.1.2`），装不上不影响插件其余功能，缺失时明确返回 `reason: nodemailer-missing`。收件人/发件人由配置项 `feedback.to` / `feedback.from` 给出，**环境变量 `DSH_CRB_FEEDBACK_TO` / `DSH_CRB_FEEDBACK_FROM` 优先于它们**（同一份包被多人/多机使用时不必改配置文件）；`feedback.to` 默认即维护者收件箱，以 `b64:<base64>` 形式随包分发（避免公开 tarball 中出现可被正则抓取的 `name@domain`；属混淆而非加密，解码器在 `lib/host/feedback.js`，明文地址同样可用），`feedback.from` 默认留空并复用 SMTP 连接串里的用户名（服务商要求 From 与登录账号一致）。**任何凭证都不进配置文件、不进代码库**。
- **反馈通道与删除开关解耦**：`enabled:false` 只关闭删除；`/state.feedback` 单独报告 `enabled`、`transport`、`toConfigured`。通道未配置时设置页不渲染按钮，直接请求也返回 `503 E_FEEDBACK_DISABLED`（带 `reason: not-configured | disabled | off`），而不是在点击后才失败。
- 新增错误码 `E_FEEDBACK_DISABLED`(503) / `E_FEEDBACK_INVALID`(400) / `E_FEEDBACK_RATE_LIMITED`(429) / `E_FEEDBACK_TRANSPORT`(502)；投递失败只记错误码与 HTTP 状态，**正文、标题、联系方式不进 Host 日志**。
- **收件地址以 `b64:<base64>` 打包**：默认收件箱不再以明文 `name@domain` 出现在 `cordis.patch.yml` / `config.schema.json` / README / CHANGELOG 中，避免公开 tarball 被正则抓取。这是**混淆而非加密**——解码器 `decodeAddress()` 就在 `lib/host/feedback.js` 里，拿到包的人总能还原；明文地址与环境变量照旧可用。

### Changed

- `npm test` 增加 `test/feedback.test.mjs`（16 个用例：配置归一化、通道判定、校验/渲染、HTTP 通路、失败状态、限流窗口、未配置、SMTP 缺依赖、两条路由用例），用例总数 104 → 122（按 `^test(` 逐文件实测校正；本行原写 106 → 121 为陈旧错值）；`npm run check` 增加 `lib/host/feedback.js` 语法检查。
- `cordis.patch.yml` / `config.schema.json` 增加 `feedback` 默认段（`to` 默认为维护者公开反馈邮箱、`from` 留空、`transport: auto`、`rateLimitPerHour: 5`）。

## [0.2.2] — 2026-10-18

对 0.2.1 的双环境（桌面/网页）全面审计修复轮。问题编号对应 `AUDIT-2026-10-17-desktop-web.md`；每个问题在该文档中都有平台、复现条件、原因与修复方向的完整记录。

### Security

- **删除路由接入 DSH `connection` 门禁（P1-1）**：插件路由此前完全绕过 `connection.admit()` 与 `connection/request` 瀑布流——桌面端安装更新或退出时，更新任务只排空经过 `/api` 的在途请求，一个耗时删除会被直接截断。现在变更路由先过 `ctx.connection.requestRejection(req)`（401/403 短路），再进 `ctx.waterfall('connection/request', …)`：桌面更新门禁借此返回 503 并等待在途变更，删除事务不会被杀在半路。
- **跨进程 mutation 锁（P1-6）**：桌面端与 `dsh web` 共享同一个 `<DSH_HOME>/delete-conversation/` 时，两个 Host 可能同时读改写 manifest 与审计。所有 mutation（delete/restore/purge/discard）现在在进程内串行链之外再抢 `<dataDir>/mutation.lock` 跨进程文件锁（`{pid,nonce,at}` 注册 + 心跳 + stale 判定，nonce 匹配才删除）；抢不到锁返回可读的 `E_LOCK_BUSY`，而不是写坏同一份 manifest。
- **同源校验比较完整 authority（P3-4）**：原先只比主机名，`http://127.0.0.1:3000` 的 Origin 与 `Host: 127.0.0.1:8080` 会被判同源。现在比较主机名 + 有效端口（缺失端口按 Origin 自身 scheme 归一），「同源校验」名实相符。
- **错误详情脱敏（P2-10）**：`DeleteError.details` 里的绝对路径（`indexFile`/`lockFile`/`from`/`to`/ENOENT 文案等）不再原样进入客户端响应，只保留 basename 级信息，与「客户端只拿计数与状态、不拿文件句柄」的契约对齐；Host 日志侧不变。

### Fixed

- **灵枢锁协议不兼容：请求可能永不返回（P0-1）**：适配器把「锁文件存在」当锁（`open(lockPath,'wx')`），而 md_cg 的 `FileLock` 是 OS 级建议锁、锁文件永远是 0 字节且从不删除——只要灵枢跑过一次，`wx` 必然 `EEXIST`；判 stale 后进入一条既无 sleep、又在超时判断之前的忙循环，Windows 上请求永不返回并堵死整个 mutation 队列（本机审计里连续 3 次 hard+记忆删除因此回滚）。现在改用插件私有锁 `_index.json.conversation-recycle-bin.lock`：pid/nonce 注册、心跳续期、stale 判定、忙等超时（`E_LOCK_BUSY`），**永不触碰也永不删除** md_cg 的永久锁文件。0.1.3 的「0 字节无主锁超过 5s 清除」经核实是误判（0 字节是 md_cg 锁的常态），相关表述已从 README/CHANGELOG 更正。
- **灵枢索引直写不在其写协议内：节点可能回放复活（P0-2）**：md_cg 的持久化是「快照 `_index.json` + `_index_log/` 追加分片，装载时重放」。插件过去只重写快照，被删节点的记录留在分片里，下次装载会把节点加回来而正文已在回收站——典型「索引有条目、文件不存在」的幽灵节点。现在删除追加 `{"id, e:null}` 墓碑分片、恢复追加节点记录分片，`_t` 取「现在」与「最新分片时间 + 1ms」的较大值，保证重放时我们的记录排在最后：已删节点不会复活、已恢复节点不会被旧墓碑覆盖。
- **设置页批量删除的确认框被设置弹层遮住（P0-3）**：设置弹层是 `createPortal(..., document.body)` 的 `position:fixed; z-index:1000`，插件对话框挂在 `.overlayLayer{z-index:20}` 内，遮罩的 `z-index:1000` 只是该 stacking context 内的值，跨不过父级的 20。确认框现在同样 portal 到 `document.body`、层级取 1100；toast 一并处理，恢复/清理的成功反馈在设置页里也可见了。
- **live 会话跳过 foreign-writer 检查（P1-2）**：`assertNoForeignWriter` 开头就是 `if (session.live) return`——而 `quiesce` 只能停**本进程**的 Agent，另一端 Host 的 writer 恰好是本进程视角下的 live 会话，最需要保护的场景被豁免。现在所有模式都做 mtime 复检（grace 窗口通常在 `quiesce` 期间已满足，额外成本是一次 mtime 扫描）。
- **软删除条目恢复失败把会话变成孤儿（P1-3）**：`catalog.restore` 的 undo 无条件 `detachSession`，而软删除的会话本来就在工作区里（归档只是隐藏），回滚把它从侧栏彻底摘掉。现在 undo 只反转本步**实际做过**的变更（是否 attach、是否 unarchive），软删除回滚时重新归档。
- **未完成条目没有恢复入口（P1-4）**：`IncompleteEntries` 只渲染「清理」，但 `discard` 对仍持有 `session/` 的条目会拒绝，UI 提示「请改用恢复」却没有恢复按钮。现在按 `hasSessionLog` 渲染「恢复」按钮（调用已有的 `/trash/restore`），死条目有了出口。
- **记忆导出失败留下永久卡死的条目（P1-5）**：`exportSession` 失败后已写出的 bundle 目录不删，manifest 又没记 memory，恢复与 discard 都拒绝。现在 catch 里还原文件后删除未登记的 bundle 目录。
- **恢复不恢复原位置（P2-1）**：`insertSessionBefore` 要求会话已在 `sessionIds` 里，被 detach 的会话不在，于是必然走 catch 前插到列表顶部，快照的 `nextSessionId` 从未生效。现在先 `attachSession` 再 `insertSessionBefore(id, anchor)`。
- **软删除 purge 的崩溃窗口（P2-2）**：日志已移进条目但 manifest 未写回 `sessionLog`，崩溃后一次恢复可能把仍躺在条目里的 `session/` 一并删掉。现在移动成功后立即更新 manifest；恢复/discard 都先检查磁盘上的 `session/`，不只信 manifest。
- **多适配器恢复边恢复边删 bundle（P2-3）**：第一个适配器成功后 bundle 即被删，第二个失败时条目永远无法重试。现在全部适配器成功后才统一删除 bundle。
- **`defaultMode` 是死配置（P2-4）**：对话框固定 `useState('soft')`，schema 却承诺「Initial mode selected in the confirmation dialog」。现在从 `/state` 的 ui flags 读取 Host 配置的默认模式。
- **语言检测读错字段（P2-5）**：`dsh-client-locale` 快照结构是 `{active, locales, revision}`，插件找 `snapshot.locale ?? snapshot.id` 恒不中，回退 `navigator.language`——DSH 设置里切语言不生效。现在读 `snapshot.active`。
- **`resolveDshHome` 不展开 `~`（P2-6）**：`DSH_HOME=~/dsh-data` 会在 cwd 下创建字面量 `~` 目录，回收站/审计落到错误位置。现在按官方口径展开 `~`/`~/`/`~\` 后 resolve。
- **批量全选被单个不可删会话卡死（P2-7）**：`/preview` 只要一个 id 被策略拒绝就整批不签发 token，客户端禁用按钮且只显示第一条原因。现在 `/sessions` 每行带 `deletable` 裁决与原因，复选框禁用、hint 追加「无法删除: \<原因\>」，全选只选可删项。
- **批量变更超时上限小于最坏耗时（P2-8）**：客户端 `30s + 5s × 数量` 上限 180s，50 个 live 会话可超时后 Host 继续执行、token 已消费。现在 `/preview` 返回 `planTimeoutMs`，客户端按计划规模设超时。
- **`readJsonBody` 不处理请求中止（P2-9）**：客户端发 body 期间断开（超时/关页）时 `end` 永不触发，Promise 不 settle 并堵死 mutation 链。现在监听 `aborted`，以 `E_BAD_REQUEST` 拒绝。
- **每次激活打印 3 条假告警（P3-1）**：`cordis.patch.yml` 把可空字段写成 `null`，`readString` 只接受 `undefined`/string。现在 `null` 作为「未设置」接受。
- **深色主题 live 警告框不跟主题（P3-2）**：`--dsw-alias-text-warning`/`--dsw-alias-fill-warning` 在 0.2.1-rc.2 不存在（实际是 `--dsw-alias-state-warn-label`/`-tertiary`），回退成浅色块。已改用真实变量。
- **桌面 `dsh-app:` 信任分支过宽（P3-5）**：桌面转发已剥离 Origin，该分支在真实链路里不触发；若保留则任何注册 `dsh-app:` scheme 的 Electron 应用都会被视同源。现收紧为 `protocol === 'dsh-app:' && hostname === 'app'`（与 DSH 自身 `origin === "dsh-app://app"` 口径一致），作为纵深防御保留。
- **会话 id 正则不接受 `.`（P3-6）**：DSH `encodeSegment` 允许 `.`/`_`/`-`，fork/自定义 id 会被误拒。已放开。
- **工作区路径大小写比较不一致（P3-7）**：`workspaceFor` 对**所有**路径 `toLowerCase()`，Linux 上 `/a/Foo` 与 `/a/foo` 误配；UNC 未按 Windows 语义处理。现在只对盘符路径与 UNC 根小写，POSIX 路径保持大小写敏感。
- **审计 `source` 固定 `web-ui`（P3-8）**：桌面端发起的操作也记成 `web-ui`，平台取证时误导。现在按 `process.versions.electron` 记 `desktop-ui`/`web-ui`。
- **批量软删除的硬删除文案分支不可达（P3-9）**：`dialog.hardWarning`（「请输入 DELETE」）在 `expectedPhrase === ''` 时不会渲染，hard 模式永远一键。已删除该文案。
- **记忆适配器标签半本地化（P3-10）**：lingshu 的 label 是中英混合常量、`none` 是英文 reason，英文界面里会出现中文。现在 `adapterLabel`/`adapterReason` 按当前语言本地化，未知 key 原样透出。
- **`/sessions` 每行误判 orphan**：`loadList` 只按 membership 解析 workspace，行上无 `workspace` 对象，`evaluateSessionPolicy({workspace: undefined})` 恒为 false，批量选择器全灰。现在增加 cwd 包含回退（与 `inspect` 的 `workspaceFor` 一致）并在行上附 workspace 对象。

### Removed

- `locale/{en,zh}.json`（P3-3）：运行时从无加载方，客户端只读内联 `STRINGS`，JSON 的键集与内联表不同（改了不生效）。两个死文件已删除，`package.json` 的 exports/files 同步清理；manifest 测试现在断言「不发布 locale 资源，Client 内嵌两套文案」。

### Changed

- `BatchSessionRow` 从 `SettingsSection` 的内联 JSX 抽为纯组件并导出，行禁用态、原因文案与 `selectableSessionIds` 过滤因此可被测试直接覆盖（P2-7 的验证基础）。

### Tests

- 104 checks (was 84); added full-authority origin comparison (含异端口/默认端口归一/`dsh-app://app` 信任与 `dsh-app://evil` 拒绝), connection `requestRejection`/waterfall 两道闸, cross-process mutation lock (`E_LOCK_BUSY`), batch-scaled plan timeout, per-row deletable verdict + reason, audit source (desktop/web), mid-body abort → 400, portal-into-body overlay (有空 payload/打开时两种形态), restore action for incomplete entries, batch row disabling with reasons, `defaultMode`/locale `active` from `/state`, adapter localization (per-locale fresh load), md_cg shard-log tombstones, multi-adapter restore atomicity, untracked bundle cleanup.

## [0.2.1] — 2026-10-18

### Fixed

- **包元数据缺少 `repository`**：`package.json` 里没有 `repository` / `homepage` / `bugs` / `author`，npm 页面因此没有源码链接；更关键的是 awesome-dsh-plugin 的 `scripts/probe-npm.mjs` 只在 npm 包的 `repository` 字段回指同一个 GitHub 仓库时才把包写进 `data/npm-map.json`，缺了它市场拿不到 npm 安装源。四个字段已补齐，代码与运行时行为无变化。

## [0.2.0] — 2026-10-17

### Changed

- **Renamed** the package from `dsh-delete-conversation` to `dsh-conversation-recycle-bin`: the old npm name is owned by another author (`jiuling`, 1.0.1, a different implementation). The Client module id, the Cordis row id (`conversation-recycle-bin`), the HTTP prefix (`/conversation-recycle-bin/api`), the private header and all docs now use the new name.
- **Compatibility:** durable data stays under `<DSH_HOME>/delete-conversation/`, so existing recycle-bin entries and the audit trail remain visible after the rename; the storage namespace is intentionally not migrated. A profile must replace the old bundle entry with the new package name and restart DSH.

### Fixed

- **记忆计数自相矛盾**：`preview.memory.adapters[].count` 用 `Object.values(Map)` 求和（对 `Map` 恒为 `[]`），所以每个可用适配器都显示 0 条、而 `memory.total` 却非 0。现在按填充 `bySession` 的同一批查找累加，`Σ adapters[].count === total`。
- **失败的删除永久卡在回收站**：删除含记忆的会话时，记忆阶段回滚成功后 bundle 目录仍留在条目里，`POST /trash/discard` 因此判定「仍持有记忆文件」而拒绝，而 `restore`（status ≠ `trashed`）与 `purge`（status ∉ `trashed/restored`）也拒绝 —— 条目再也无法清理。现在 `restoreEntry` 在数据放回后删除已消费的 bundle 目录，未完成条目恢复可清理。
- **`quiesce` 失败会把会话静默归档**：live 会话在 `liveDrainMs` 内停不下来时，`quiesce` 在抛错前尚未登记逆操作，整笔回滚后会话仍处于「已归档」（活动已停、会话列表隐藏）状态。现在归档的逆操作在等待之前登记，超时先撤销归档再抛 `E_POLICY_LIVE`。
- **catalog 半途失败留下旁路修改**：hard 模式 `remove()` 依次执行 unarchive → unpin → detach，某个后续步骤失败时没有任何逆操作，回滚后会话仍处于「已取消归档/已取消固定」，等于一次失败的删除悄悄把会话放回了列表。现在每完成一步即登记该步的逆操作，失败时按逆序先还原。
- **未完成条目本来无法恢复**：`performRestore` 只接受 `trashed`，但 `discard` 的提示语却说「请改用恢复或彻底删除」，构成死路。现在 `pending / failed / restoring / purging` 也可恢复：只执行 manifest 仍记录着 payload 的步骤（例如日志或 catalog 缺失时只把记忆放回），失败时沿用原状态而不再升格为 `trashed`；确实已无 payload 的条目则明确拒绝并提示改用 `discard`。
- **客户端本地化判断不一致**：`t()` 对 locale id 做小写归一而 `errorText()` 没有，遇到 `ZH-CN` 这类混合大小写 id 时错误文案回退英文、同屏其他标签仍是中文。两者现在共用 `isZhLocale()`。
- **`GET /state` 泄露宿主绝对路径**：响应中的 `storage.{trashDir,auditFile,dataDir}` 未被任何客户端使用，且与本模块「客户端只拿计数与状态、不拿文件句柄」的契约相冲突，已移除。
- **locale 资源文案与实际行为不符**：`locale/{en,zh}.json` 的 `dialog.memoryCount` 写成「删除记忆」（实际是移入回收站）、`dialog.modeHardHint` 写成「从磁盘移除、回收站清理后不可恢复」（实际在回收站条目被清理前仍可恢复），已按实际语义更正。

### Tests

- 84 checks (was 77); added per-adapter count/total consistency, failed-delete → discard cleanup, quiesce rollback + un-archive, catalog half-failure rollback, restore-from-incomplete-entry (3 cases), mixed-case locale text.

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
  - same-origin check, private `x-conversation-recycle-bin: 1` header, loopback-only by default, body-size ceiling;
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
