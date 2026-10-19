# Changelog

All notable changes to `dsh-conversation-recycle-bin` are documented here.
The format follows Keep a Changelog; the project uses Semantic Versioning.

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
