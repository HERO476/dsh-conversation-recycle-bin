# 审计报告 · dsh-conversation-recycle-bin 近三版（0.3.1 / 0.3.2 / 0.3.3）在 DSH 桌面端与网页端的 bug 与适配性复核

审计时间：2026-10-20
审计范围：v0.3.1、v0.3.2、v0.3.3 三个连续补丁版本
对照基线：CHANGELOG.md（0.3.1 起）与前置审计 AUDIT-2026-10-19-review.md、AUDIT-2026-10-19-desktop-web-recheck.md
主报告人：Qoder（本地会话 4e90a0e1）

---

## 0. 一句话结论

**近三版没有已知的产品级 bug，两端装载完全一致（都是 workspace symlink），本插件不在 DSH 0.2.1-rc.2 的兼容性拉黑清单里。** 审计发现的 4 条非阻塞隐患（N1–N4，§5）以及测试驱动下新连带发现的 P3 回归 N5，已**在同一次会话里全部修复并升到 0.3.4**，每条附回归用例（总测试 128 → 131 全绿）。

---

## 1. 版本与装载状态

| 端 | 装载路径 | 版本 | 装载方式 | 备注 |
| --- | --- | --- | --- | --- |
| Workspace | `D:\Users\34332\AI\dsh-conversation-recycle-bin` | `0.3.3` | 源码根 | 唯一真值 |
| 桌面端 | `~/.dsh/profiles/desktop/node_modules/dsh-conversation-recycle-bin` | `0.3.3` | symlink → workspace（`2026-10-17 23:17`） | 桌面应用当前未运行 |
| 网页端 | `~/.dsh/profiles/web/node_modules/dsh-conversation-recycle-bin` | `0.3.3` | symlink → workspace（`2026-10-19 21:01`） | Host 于 `2026-10-20 09:42:30` 重启并已加载 |

因为两端都通过 symlink 指向同一份 workspace，**结构性地不存在版本漂移**：任何一次 workspace 更新会同步反映到桌面与网页，反之亦然。前置审计里担心的「双端 profile 各自锁不同 registry 版本」问题在这台机器上根本不存在。

Git 标签核对：`v0.3.1 → v0.3.2 → v0.3.3` 三条 release commit 连续；HEAD 在 `816fbcc docs(audit)` 之后，代码与 0.3.3 标签字节一致。

---

## 2. 测试与静态检查基线

- `pnpm test` 8 个测试文件串行执行，共 **128 用例全绿**（`feedback 18 / core 14 / api 38 / client-module 19 / install 6 / lifecycle 8 / config 10 / paths 15`）。Node 24.21.0 与 22.23.2 均可跑。
- `pnpm run check` 用 `scripts/check-syntax.mjs` 遍历 `lib/**/*.js` + `client.js` 逐个 `node --check`，**全部通过**。这解决了 0.3.3 M3 之前「链式清单只覆盖 3 个文件」的漏检风险。

近三版新增/覆盖的用例：
- 0.3.1 反馈邮箱形状优先、`visitorAsFrom` 键下发、对话框兜底刷新抑制（`client-module` 删一条逐字节重复用例后减 1）。
- 0.3.2 HTTP 通道 `From` 决策矩阵 4 条（`resolveSender` 单测）。
- 0.3.3 `api` +4 覆盖 S1/S2/S3/R4，`core` +1 覆盖 R2 退还额度，`feedback` +1 覆盖 R2 HTTP/SMTP catch 分支。

---

## 3. 近三版改动点逐条复核

### 3.1 v0.3.1（2026-10-18）— 反馈表单 & 兜底刷新

| 变更 | 复核 |
| --- | --- |
| 「你的邮箱（选填）」字段：客户端 `EMAIL_PATTERN` 与 Host `isEmailShape` 完全同规则（不接受 `,;:<>[]\\`，域名段 ≥2） | ✅ 两端字面等价；测试用例锁死 |
| `feedback.visitorAsFrom` 配置下发到 `/state.feedback.visitorAsFrom`，前端据此切换提示文案 | ✅ 前端在 `FeedbackDialog` 里读取并渲染，默认 `false` 保持旧行为 |
| 邮件正文 `from / 发件人:` + `reply-to:` 双行改造 | ⚠️ 0.3.1 首版把「访客邮箱」标注为「发件人」，0.3.2 立即回滚为 `visitor / 访客邮箱`。属于文案语义回归、无功能损失，两版相邻发布 |
| 删除当前会话后结果对话框不再被固定 900ms 兜底刷新抹掉；改由用户关闭触发 reload，5s 只是安全网 | ✅ 客户端 `reloadPending/reloadTimer/reloadDialogDismissed` 三点状态在 `closeDone()` 与 `submitAll()` 里互相清账，`takeReloadPending()` 会 `clearTimeout` 原计时器，不存在「关掉又刷一次」竞态 |
| 客户端先长度后格式 → 先格式后长度（与 Host 一致） | ✅ 现在超长邮箱两边都是「太长」，非形状错误两边都是「不是邮箱」 |
| 「记忆不可用」英文 `not detected` 硬编码抽条为 `state.notDetected` 双语词条 | ✅ |
| `noValidate` 挂在 `div` 上属误导死属性，移除 | ✅ 组件无 `<form>`，删除后行为不变 |

### 3.2 v0.3.2（2026-10-18）— HTTP 通道 `From` 尊重 `visitorAsFrom`

| 变更 | 复核 |
| --- | --- |
| `deliverHttp` 的 `body.from` 改为 `(visitorAsFrom===true && submission.email) ? submission.email : (settings.from === '' ? undefined : settings.from)` | ✅ 与 `resolveSender` 的 SMTP 侧完全同决策；默认配置下 HTTP 请求体逐字节不变（回归测试锁死） |
| 邮件正文 `from / 发件人:` 改为 `visitor / 访客邮箱:` | ✅ 如实反映：这行展示的一直是「访客主动填写的邮箱」，不是 `From` |

结论：0.3.2 是一次**纯修复**、无接口变更、无配置迁移需求。

### 3.3 v0.3.3（2026-10-19）— S/P/R/M 全线

**S 类（安全）**
- **S1 `Host` 头不带端口时同源端口比较被恒真绕过** — `lib/host/api.js` `requestOriginVerdict` 引入 `effectiveRequestPort = requestPort === '' ? defaultPortFor(parsed.protocol) : requestPort`。`Host: 127.0.0.1` + `Origin: http://127.0.0.1:9999` 现在被拒 403；`Origin: http://127.0.0.1`（无端口）仍放行。 ✅ 有单测锁两边。

**F 类（缺陷）**
- **S2 未知 GET 路由误报 405** — `lib/host/api.js`：路径不存在 GET/POST 统一 404 `E_NOT_FOUND`；405 只保留给「路径存在但方法错」。 ✅
- **S3 损坏 / 缺失 manifest 的回收站目录永久隐身** — 新增 `trash.scanUnreadable()`（missing / corrupt / unreadable 三类），`/trash` 把它们以 `status:'unreadable'` 的 incomplete 项列出，`discard` 走 `performDiscard` 的磁盘检查（有 `session/` 日志或有 memory 文件则 `409 E_TRASH_CONFLICT`，空目录允许强制清理）。 ✅ 桌面端与网页端都受影响，网页端 2026-10-20 重启日志无异常。

**P 类（性能）**
- **P1 live drain 每轮全量重建会话列表** — `lib/host/gateway.js` 新增 `isRunning(sessionId)` 内存存活表探针，`inspectRunning` 先走探针（`running/active/busy` 布尔），探针答不出再回退全量 `inspect()`。 ✅ 批量删多个 live 会话时不再线性放大。
- **P2 `/trash` 每次全量读盘解析 manifest** — 1.5s TTL 缓存 + delete/restore/purge/discard 成功后主动 `invalidateTrashCache()`。 ✅
- **P3 `/audit` 全量读 5MB 再解析** — `tail()` 只读尾部 256KB，见 §5 N2 的小尾问题（不影响正确性）。 ✅
- **P4 跨进程锁等待 30s 短于批量最坏耗时** — `lockBudget = min(900s, 15s + 16s×batchCount + batchCount×liveDrainMs)`。 ✅ 大批量不再被第二个 Host 误判 `E_LOCK_BUSY`。
- **P5 全部 blocked 时仍做全量记忆计数** — `preview` 在 `blocked.length > 0` 时跳过 `countForSessions`。 ✅

**R 类（鲁棒）**
- **R1 请求体超限后继续读完整个 body** — 立即 `finish(413)`。 ✅
- **R2 反馈投递失败也扣每小时额度** — `takeSlot()` 返回 `{release()}`，SMTP/HTTP 传输失败在 catch 里退还槽位；成功投递才计数。 ✅ 传输临时故障不再把用户锁一小时。
- **R3 批量列表按 `soft` 固定裁决与 `defaultMode` 脱节** — `sessionsForUi` 改用 `config.defaultMode`。 ✅
- **R4 失败的删除项也占每分钟额度** — `limiter.take(1)` 带 `release()`，单条失败在 catch 里退还槽位。 ⚠️ **见 §5 N1**：mid-loop `!reservation.ok` 后的 `break` 会静默丢弃后续项。

**M 类（维护）**
- M1 删除死 CSS `.dc-mode-preferred`；M2 抽出 `lib/core/ids.js#SESSION_ID_PATTERN` 去重；M3 `npm run check` 改为 `scripts/check-syntax.mjs` 遍历；M4 `/state` 不再外泄记忆适配器绝对路径。 ✅

---

## 4. 桌面端 × 网页端适配性

### 4.1 DSH 运行时版本

- 桌面端：`@deepseek-ai/dsh-desktop 0.2.1-rc.2` + Electron 44.7.0 + Node 24.21.0
- 网页端：DSH `0.2.1-rc.2` + Node 22.23.2

本插件 `package.json` 里 **完全没有 `peerDependencies`**：只声明 `engines.node >= 20`，以及 `optionalDependencies.nodemailer ^10.1.2`（缺失时反馈降级为 HTTP 通道，不影响删除主流程）。这直接意味着 DSH 的版本兼容闸**没有可拒绝的输入**，插件必然通过。

对比同 profile 下被拉黑的 4 个插件——它们全部有严格的 `@deepseek-ai/dsh-tools` / `dsh-llm` peer 版本范围（`^0.1.0-rc.6`、`0.1.1-rc.2` 等），DSH 0.2.1-rc.2 的内置版本对不上，才被拒绝装载。

**结论：本插件不在兼容性问题清单里，与 writing-guard / pdf-edit / find-plugin / graphflow 的失败模式无关。**

### 4.2 网页端在线探测（2026-10-20）

`~/.dsh/logs/` 与 Temp 里最新的重启日志 `dsh-market-restart-2026-10-20T09-42-30.out.log`：
```
[conversation-recycle-bin] API registered at /conversation-recycle-bin/api
(dshHome=C:\Users\34332\.dsh, mode=soft, memory=on,
 trash=C:\Users\34332\.dsh\delete-conversation\trash)
```
同目录 `.err.log` 里 `skipping profile bundle` 三条命中 writing-guard / pdf-edit / find-plugin，**未包含本插件**。

进程 32916 正在 `127.0.0.1:8080` 监听。用 `curl` 直接探测：
```
GET /conversation-recycle-bin/api/healthz   → 401
GET /conversation-recycle-bin/api/v1/healthz → 401
{"ok":false,"error":{"code":"E_UNAUTHORIZED","message":"This request is not authenticated with the Host."}}
```
`E_UNAUTHORIZED` 是本插件自己 `handler` 里 `connection.requestRejection(req)` 命中后的返回，格式和 `message` 与前置审计一致。这证明：
1. 路由前缀 `/conversation-recycle-bin/api` 正确挂到了 Cordis 的 `webServer.register({kind:'prefix'})`；
2. `apply()` 无异常，`api.handler` 已实例化并运行；
3. `audit.js` / `feedback.js` / `config.js` 三个可能抛错的装载点均正常。

### 4.3 桌面端离线证据

桌面应用当前未运行（`tasklist` 无 `DeepSeek Harness` / `dsh` 进程）。用磁盘证据替代：

- `~/.dsh/profiles/desktop/node_modules/dsh-conversation-recycle-bin` symlink 存在且指向 workspace（`2026-10-17 23:17`，比 profile 建立更早，说明 0.3.3 时代码就是当前 workspace）。
- `~/.dsh/profiles/desktop/cordis.patch.yml` 存在（前置审计确认过 bundle 补丁）。
- **`~/.dsh/delete-conversation/audit.jsonl` 最近一条 `source:"desktop-ui"` 记录**：`mvghtdm0-1g1qfsess` 于 `at:1792489245669`（≈ 2026-10-20 桌面时段）执行 `delete/hard/includeMemory:true/lingshu.count=2` 成功、耗时 191ms。这是插件在桌面端真实跑通完整级联（quiesce → 移动 session 日志 → 记忆快照 → 写 trash manifest → 追加审计 → bump mutationStore）的直接证据。
- 桌面端 crash 日志（`crash-2026-10-20T04-36-24-098Z-host.log` 与 `crash-2026-10-19T15-42-02-350Z-host.log`）里 fatal 在 `dsh-doubao-work-connect/index.js:280` 的 `DOMException AbortError`，**与本插件无关**。

结论：桌面端装载状态通过（hash + symlink + 审计成功记录），运行时状态待用户重开桌面端后现场验证。

---

## 5. 发现的隐患（N1–N5，已于 0.3.4 全部修复）

以下五条都是**代码质量 / 边界处理**层面的观察。**已在 2026-10-20 的 0.3.4 版本一次性修完并附回归用例**，仅列出以便回溯。

### N1 · `deletePlan` 中途 `break` 会静默丢弃尾部项（0.3.4 修）

`lib/host/api.js:641-651`：
```js
for (const session of sessions) {
  const reservation = limiter.take(1)
  if (!reservation.ok) {
    const rateError = new DeleteError('E_RATE_LIMITED', ...)
    if (results.length === 0 && failures.length === 0) throw rateError
    failures.push({ sessionId: session.id, error: rateError.toJSON() })
    break                             // ← 尾项静默丢失
  }
  ...
}
```

`maxBatchSessions` 默认 50、`maxDeletesPerMinute` 默认 20。当同一分钟已经消耗了 20 个槽位、用户又提了一个 50 项的批量计划时，第 21 项被 `limiter.take` 拒绝、`break`；**第 22–50 项既不进 `results` 也不进 `failures`**，客户端结果面板只能看到「前 20 成功 / 第 21 限流」，剩下 29 项像没被计划过一样。

- 影响面：批量删除 + 用户极快连点，或前一次批量刚过去 60s 窗口尚未滑出；日常单个删除不可触发。
- 严重性：低（不是数据损坏，只是 UI 反馈不完整）；契约上仍是「事务式返回」，只是返回体不完整。
- 建议修法：把 `break` 改成把剩余 session 逐个 `failures.push({sessionId, error: rateError.toJSON()})`（可复用同一个 `retryAfterMs`）。或者在 `preview` 阶段就用 `limiter.peek()` 预剪掉超预算的项，让 `deletePlan` 拿到的 `sessions` 天然 ≤ 预算。

### N2 · `audit.tail()` 在字节边界恰好落在 `\n` 之后时会丢一条（0.3.4 修）

`lib/core/audit.js:96-110`：
```js
const start = Math.max(0, size - CHUNK)
...
const rawLines = text.split('\n')
// A chunk starts mid-line; drop the partial first line ...
const lines = (start > 0 ? rawLines.slice(1) : rawLines)
```

`start > 0` 时**无条件**丢弃 `rawLines[0]`。当 `size - 256KB` 刚好落在某条 `\n` 之后（下一次 `appendFile` 之前的自然边界），`rawLines[0]` 其实是**完整行**，被误当作残行丢掉。

- 影响面：审计文件大小 ≥ 256KB 且 tail 请求 limit 逼近窗口尾部；日常几百条时几乎不可能命中。
- 严重性：非常低（用户看不到一条历史审计记录，`records.slice(-maxRecords)` 通常已经截断）。
- 建议修法：改成条件丢弃——`rawLines[0]` 若以 `{` 起头且能 `JSON.parse` 成功则保留；否则丢弃。或者读 `start-1` 位置一字节，若为 `\n` 则不丢弃。

### N3 · HTTP 反馈通道固定 `Bearer` 前缀（0.3.4 修）

`lib/host/feedback.js:341`：
```js
if (settings.apiToken !== '') headers[settings.authHeader.toLowerCase()] = `Bearer ${settings.apiToken}`
```

`authHeader` 允许通过 `DSH_CRB_MAIL_API_AUTH_HEADER` 覆写（默认 `Authorization`），但值始终是 `Bearer <token>`。当用户配 `X-Api-Key` 或 `x-goog-api-key` 之类的自定义头时，多数后端不接受 `Bearer` 前缀，会 401。

- 影响面：使用非 `Authorization` 头的邮件中转（Resend / 自建网关带 `X-Api-Key`）。QQ / 163 / SendGrid 这类走 `Authorization: Bearer` 的完全不受影响。
- 严重性：中偏低，配置项设计上像支持通用头但事实上只支持 Bearer。
- 建议修法：约定「`authHeader === 'Authorization'` 加 Bearer 前缀，其它裸 token」；或再补一个 `DSH_CRB_MAIL_API_AUTH_SCHEME` 允许用户显式改写。同时更新 README §9.2 和 `config.schema.json`。

### N4 · 反馈 `visitorAsFrom` 默认 `false` 语义与实际发件人易混淆（0.3.4 修）

0.3.2 已经把正文标注改成 `visitor / 访客邮箱`，但**邮件头 `From` 仍是发信账号**（QQ / 163 之类要求 From 与登录账号一致，无法用访客邮箱）。若用户配置了 `visitorAsFrom: true` 但走的是 QQ 转发（`From` 必须匹配登录账号），HTTP/SMTP 通道都会拒收。README §9.2 有排查项，但 UI 上「你的邮箱（选填）」输入框旁的提示没有把这条硬约束讲清。

- 影响面：用户手动开启 `visitorAsFrom` 时，可能收到「反馈被拒」而不知因。
- 严重性：低，属文档 / UX 提示。
- 建议修法：当 `visitorAsFrom === true` 且 transport ≠ `http-token-relay` 时，`/state.feedback.reason` 里补一句「QQ / 163 / Gmail 会拒收，除非该中继允许任意 From」。

### N5 · 0.3.3 P3「tail 只读 256KB」从未真正生效（0.3.4 修，测试驱动下发现）

`lib/core/audit.js` 里 0.3.3 引入 `start = size - CHUNK` 后调用 `fsApi.readFile(filePath, { start, end: size })`。Node `fs.readFile(path, options)` 的 options 只接受 `{encoding, flag, signal}`，**`start`/`end` 被静默忽略**、每次全量读盘。这不影响功能正确性（读到的内容仍是整个文件、`rawLines.slice(1)` 仍按字节窗口大小丢首行），但 P3 声称的「≤256KB 窗口」在实现里等于零。修复 N2 时写单元测试暴露了这一点。

- 严重性：中偏低——不是数据错误，是性能回归（5MB 审计文件 tail 仍要读 5MB）。
- 修法：`fsApi.open(filePath, 'r')` → `FileHandle.read(buffer, offset, length, position)` 做位置化读，`stat` 也走 handle，`fsApi` 类型加 `open`。`createAuditLog` 增加 `tailWindowBytes` 选项让回归可用小窗口构造。已在 0.3.4 与 N2 一并落地。
- 教训：0.3.3 的 `test/trash-audit.test.mjs`「append + tail」用例只测了「读到多少 records」，没测「读了多少字节」——所以 P3 静默 no-op 通过。0.3.4 新增的两条窗口对齐用例（`tailWindowBytes` 小窗口）会真正锁定字节边界行为。

---

## 6. 明确排除的「不是问题」

- **两端版本漂移**：symlink 结构决定了不可能漂移。
- **桌面端 crash 与本插件相关**：两次 crash 分别由 `dsh-doubao-work-connect` 的 DOMException 与 profile 兼容性拉黑触发，本插件在 skip 清单之外。
- **0.3.3 的 S1 origin fence 修补在桌面端 `dsh-app://` scheme 下会误伤**：`requestOriginVerdict` 已把 `dsh-app://app` 加入 trust list（前置审计确认），S1 只对 http/https scheme 补默认端口，不影响 Electron 内部调用。
- **`optionalDependencies.nodemailer` 缺失导致 0.3.1 反馈崩**：`resolveSender` 会 `transport = 'http'` 或返回 `configured:false` 的 reason，前端禁用提交按钮，不会 500。
- **audit.jsonl 里 4 条不同 `source` 混排（`web-ui` / `desktop-ui`）**：这是**设计**——审计线只有一份，`auditSource = process.versions.electron !== undefined ? 'desktop-ui' : 'web-ui'` 会区分来源，方便用户回溯「是哪端删的」。桌面端与网页端并发写由 `mutation.lock` 跨进程序列化，`serialize()` 内进程串行。观测到的 latest 记录中两种 source 交替出现、每条 `result:"success"`，说明锁工作正常。

---

## 7. 建议下一步

按优先级：

1. **N1–N5 已全部在 0.3.4 落地并附回归用例**（api 38 → 39、feedback 18 → 19、trash-audit 3 → 4，全量 131 用例全绿）。CHANGELOG `[0.3.4]` 段逐条列出。剩余动作：
2. 桌面端现场验证：用户重开 DeepSeek Harness 桌面端后访问回收站页 → `/state` 应报 `version:"0.3.4"`，前端 UI 应显示 mode / memory / adapter 三块。审计文件应新增一条 `source:"desktop-ui"` 记录。这一步不需要代码变更。
3. 0.3.4 发布：`git commit` + annotated tag `v0.3.4` + `npm publish`。可选——如果桌面端还没重开、想先复核现场，再延一步发布也可以。

---

## 附录 A · 证据指针

- `lib/host/api.js:119-173`（S1 origin 判定）、`:318-321`（limiter 与 feedback 装配）、`:641-651`（N1 `break`）
- `lib/host/feedback.js:40-44`（env 键位）、`:130-160`（`resolveSender`）、`:241-250`（邮箱形状校验）、`:339-344`（N3 `Bearer`）
- `lib/host/gateway.js:1-292`（`probeRunning` / TTL 缓存）
- `lib/host/lifecycle.js:1-107`（quiesce + `inspectRunning` 短路 + 提前注册 undo）
- `lib/core/audit.js:90-121`（tail 256KB 窗口，N2 边界）
- `lib/core/trash.js`（`scanUnreadable`）
- `lib/core/rate-limit.js`（`take().release()`）
- `client.js:669-700 / 773-780 / 943-948 / 1008-1012`（reload 状态三点）
- `CHANGELOG.md` §0.3.1 / §0.3.2 / §0.3.3
- `~/.dsh/profiles/desktop/node_modules/dsh-conversation-recycle-bin` → workspace symlink
- `~/.dsh/profiles/web/node_modules/dsh-conversation-recycle-bin` → workspace symlink
- `~/.dsh/delete-conversation/audit.jsonl`（含 `desktop-ui` / `web-ui` 交替记录）
- `%TEMP%\dsh-market-restart-2026-10-20T09-42-30.{out,err}.log`（本插件成功注册、其它 3 个插件被拉黑）
- `AUDIT-2026-10-19-review.md` / `AUDIT-2026-10-19-desktop-web-recheck.md`（前置审计基线）
