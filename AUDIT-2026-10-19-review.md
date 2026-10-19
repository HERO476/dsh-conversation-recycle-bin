# dsh-conversation-recycle-bin 优化点审查（2026-10-19）

- 基线：`npm test` 8 个测试文件全部通过（最后一套 34/34，进程退出码 0）；`node --check` 通过。
- 范围：`lib/` 全部 22 个模块、`client.js`（1988 行）、配置与清单文件。
- 说明：2026-10-17 审计（AUDIT-2026-10-17-desktop-web.md）中的 P0/P1/P2 问题经核对均已修复并有测试覆盖，本次不重复列出。
- 标注约定：**[已验证]** = 读代码 + 运行时实测确认；**[代码推断]** = 仅由代码路径推断，未在真实 DSH 环境实测。

> **处置状态（2026-10-19，v0.3.3）**：S1–S3、P1–P5、R1–R4、M1–M4 全部修复并补回归测试，`npm test` 128 用例全绿、`npm run check` 通过；明细见 `CHANGELOG.md` [0.3.3]。

---

## 1. 安全 / 正确性

### S1. Host 头无端口时，同源校验的端口比较被完全跳过（防御纵深缺口）**[已验证]**

位置：`lib/host/api.js:157-161`（`requestOriginVerdict`）

```js
const portMatches = originPort !== '' && originPort === (requestPort === '' ? originPort : requestPort)
```

当 `Host` 头不带端口时 `requestPort === ''`，表达式变成 `originPort === originPort`，恒为 true——任意端口的 Origin 都通过。实测：

```
Host: 127.0.0.1,  Origin: http://127.0.0.1:9999   => PASS（按文档意图应 BLOCK）
Host: 127.0.0.1,  Origin: https://127.0.0.1       => PASS（scheme 也未比较）
Host: localhost,  Origin: http://localhost:9999   => PASS
```

这与 `config.schema.json` 的描述（"a missing port defaults by the Origin's own scheme"）和 `test/api.test.mjs:664-676` 的注释意图不符。现有测试只覆盖了 Host **显式带** 443/80 的情形，未覆盖 Host 无端口的情形。

- 实际可利用性：**低**。浏览器只有在目标端口是 80/443、或经反向代理剥离端口时，Host 头才不带端口；DSH 默认监听回环高端口，此情形默认不可达。
- 建议修复（一行，且不破坏现有测试）：

```js
const effectiveRequestPort = requestPort === '' ? defaultPortFor(parsed.protocol) : requestPort
const portMatches = originPort !== '' && originPort === effectiveRequestPort
```

### S2. 未知 GET 路由返回 405 + 错误文案 **[已验证]**

位置：`lib/host/api.js:842-844`。实测：

```
GET  /api/nope => 405 E_BAD_REQUEST "This endpoint accepts POST requests only."
POST /api/nope => 404 E_NOT_FOUND   "Unknown endpoint."
```

GET 未知路径与 POST 未知路径行为不一致，且 405 文案有误导性。建议将 405 仅用于"路径存在但方法错误"，未知路径统一返回 404 `E_NOT_FOUND`。

### S3. 损坏的 manifest 会让回收站条目永久"隐身"且无法经 UI 清理 **[已验证]**

位置：`lib/core/trash.js:94-102`（`read` 解析失败返回 null）、`listAll` 过滤 null、`discardEntry` 再次 `read` 得到 null 后报 `E_TRASH_NOT_FOUND`。

manifest.json 因磁盘问题损坏（或被截断）后，该条目目录仍占空间，但 `/trash` 列表不显示、discard 接口拒绝，用户只能手动删目录。建议：`listAll` 把目录名合法但 manifest 不可读的条目作为 `unreadable` 项暴露，允许在二次确认后强制 discard（与现有 `performDiscard` 的磁盘检查一致）。

---

## 2. 性能

### P1. live 会话 drain 轮询每次都全量重建会话列表 **[代码推断]**

位置：`lib/host/lifecycle.js:36-40` → `gateway.invalidate()` + `gateway.inspect()`（`lib/host/gateway.js:198-234`）。

每 ≤100ms 一轮、最长 2000ms（最多约 20 轮），每轮在清缓存后执行：`controller.list()`（5s 超时）、**两次** `workspaceRegistry.list()`（`loadList` 与 `workspaceFor` 各一次）、读标题投影、读 `workspace.json`、读单会话投影文件。批量删除多个 live 会话时线性放大。

建议：drain 轮询只查询 running 标志（`sessions` 服务或 `controller.stat`），不调用 `invalidate()`；列表缓存在事务结束后由现有的 `gateway.invalidate()` 统一刷新一次即可。

### P2. `/trash` 每次全量读取并解析全部 manifest，无缓存无分页 **[已验证]**

位置：`lib/core/trash.js:106-117`。回收站条目只能手动 purge（`trashRetentionDays` 在 schema 中明确为"仅展示"，属有意设计），长期使用后每次打开设置页产生 N 次文件读取 + JSON.parse。建议加短 TTL 缓存（参照 gateway 的 1.5s），或列表接口只读必要字段。

### P3. `/audit` 每次全量读取（上限 5MB）并解析全部行 **[已验证]**

位置：`lib/core/audit.js:79-98`，`tail()` 先读整个文件、`JSON.parse` 每一行，再取最后 N 条。设置页每次打开触发。建议从文件尾部按块读取（tail bytes），或缓存解析结果按 mtime 失效。

### P4. 跨进程锁等待 30s，明显短于批量最坏耗时 **[已验证]**

位置：`lib/host/api.js:322-326`（锁 `timeoutMs: 30_000`）对比 `api.js:517`（`planTimeoutMs` 可达 900s）。两个 Host 共用一个 DSH_HOME 时，大批量在第一个 Host 执行超过 30s，第二个 Host 必然收到 `E_LOCK_BUSY`——即使前者仍在正常工作。建议锁等待时间按批量规模估算（复用 `planTimeoutMs` 逻辑），或在 E_LOCK_BUSY 中带回预计等待时长。

### P5. `/preview` 存在 blocked 时仍做全量记忆计数 **[已验证]**

位置：`lib/host/api.js:483-509`：blocked 已确定不发确认令牌，记忆计数结果对用户无意义却仍执行（索引文件读取 + 解析）。建议 `blocked.length > 0` 时跳过 `countForSessions`。

---

## 3. 健壮性 / 行为细节

### R1. 请求体超限后仍继续读完整个 body 才回 413 **[已验证]**

位置：`lib/host/api.js:228-256`。超限后只是停止缓存 chunk，未销毁流；慢速超大请求会一直占用连接。回环场景影响极小，可在 overflow 时立即 `req.destroy()` 或先回 413。

### R2. 反馈邮件发送失败也消耗限流额度 **[已验证]**

位置：`lib/host/feedback.js:407`（`takeSlot()` 在投递之前）。SMTP 临时故障时用户重试 5 次即被锁一小时，失败闭站偏保守。建议仅在投递成功后计数，或传输失败时回退 slot。

### R3. `stopLiveSessions:false` 下批量列表把 hard 模式下不可删的 live 行标为可删 **[已验证]**

位置：`lib/host/api.js:732-733`，`sessionsForUi` 固定用 soft 模式判定 `deletable`；代码注释称"soft 是最宽判定"，但 `stopLiveSessions:false` 时 hard 模式对 live 会话**更严格**（`policy.js:97-107`）。用户在批量列表勾选 live 行、切到 hard 后才被 preview 拦截。边界配置，建议在该行同时给出 hard 模式判定（或在 UI 上按当前 defaultMode 判定）。

### R4. 失败的删除项也占用每分钟限流额度 **[已验证]**

位置：`lib/host/api.js:611`，执行前一次性 `limiter.take(sessions.length)`，随后失败的条目不返还。属保守设计（防重试风暴），是否合理可斟酌；至少批量全失败时可考虑不扣额度。

---

## 4. 可维护性 / 小项（低优先）

- **[已验证]** 死 CSS：`.dc-mode-preferred`（`client.js:1822`）全文件无引用。
- **[已验证]** 会话 ID 正则 `/^[A-Za-z0-9._-]{6,80}$/` 在 `api.js:64` 与 `gateway.js:199` 重复定义，建议抽共享常量。
- **[已验证]** `npm run check` 只 `node --check` 3 个文件；建议覆盖 `lib/**` 全部文件，或改用 `node --test test/` 统一聚合 8 个测试文件（目前手写在 package.json 串行链中）。
- **[已验证]** `GET /state` 把每个记忆适配器的**绝对磁盘路径** `storePath` 返回给客户端（`api.js:701-710` + `registry.js:50-56`），客户端只使用 id/label/available/reason。成功响应不经过 `redactDetails`。属数据最小化问题，建议从 state 响应中剔除。
- **[已验证]** `lib/host/api.js:826` 起 try 块内多缩进一层，纯格式问题。
- **[已验证]** 中英文案键完全对齐（147/147，脚本校验无缺失），此项无需处理。

---

## 5. 已核实为正常、无需改动的方面

- 跨进程文件锁（nonce 校验、pid 存活、stale 判定、心跳 unref）、确认令牌单次使用与计划绑定、事务回滚顺序、错误信息路径脱敏、软删除归档路径、记忆 adapter 的 bundle 先写后改与补偿——核心安全机制实现正确。
- `node_modules/` 仅含可选依赖 nodemailer，已在 `.gitignore` 中，未被 git 跟踪。
- `trashRetentionDays` 不自动清理是 schema 中明示的有意设计（purging is always explicit），不是缺陷。
- 2026-10-17 审计的 P0/P1/P2 全部有对应修复与回归测试。

## 6. 不确定性说明

- P1（drain 轮询开销）的实际卡顿程度**未在真实 DSH 环境测量**，结论来自代码路径推断；`controller.list()` 的真实耗时取决于会话规模。
- S1 在真实部署中的可达性（Host 是否可能监听 80/443 或经端口剥离代理）**没有部署环境证据**；默认高端口回环配置下不可达，定为低风险防御纵深项。
- 其余条目均由代码 + 运行时实测确认。
