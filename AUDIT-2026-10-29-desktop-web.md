# 桌面端 / 网页端 Bug 复核报告（2026-10-29）

- 被审对象：`dsh-conversation-recycle-bin` **0.3.12**（工作树 HEAD `bfd303e`，审计开始时 `git status` 干净；本报告是本轮唯一新增文件。桌面 profile 安装副本与工作树的 26 个 `lib/` 文件 + 5 个根文件 SHA-256 全部一致）。
- 对照运行时：
  - 桌面端：`@deepseek-ai/dsh-desktop` **0.2.1-rc.3**（安装于 `D:\Users\34332\AppData\Local\Programs\DeepSeek Harness`，`app.asar` mtime 2026-10-23 16:00:56，Electron 44.7.0）。官方 nightly feed 的 `win-x64/nightly.yml` 当前仍为 `0.2.1-rc.3`（releaseDate 2026-10-23T08:02:12Z），即**已装 = 桌面最新**。
  - 网页端（npm）：`latest = 0.2.1-rc.2`（`dsh web` 默认安装口径）、`next = 0.2.1-rc.4`（2026-10-26T15:28:13Z 发布）、`alpha = 0.2.2-alpha.2`。
  - 活体 Host：桌面端正在运行的 `dsh-desktop-host`（rc.3）监听 `127.0.0.1:9709`（主 Web/插件路由），同一进程另有 `7442`（404）与 `11230`（另一套 401 鉴权监听）；浏览器访问的“网页端”就是这同一个 Host。
- 证据等级：**【实机探测】** 运行中的桌面 Host；**【隔离实测】** 临时 `DSH_HOME` + 真实 `dsh web` 进程（rc.2 / rc.3 / rc.4 各一套）；**【制品读取】** `app.asar` 与 npm 发布物；**【代码走读】** 源码。

> 术语校正：本轮的“桌面端”与“网页端”**不是两套 Host 代码**。桌面 App 起一个 `dsh-desktop-host`，Renderer 通过特权协议 `dsh-app://app` 经外壳 `forwardWebRequest` 访问它；浏览器则直连同一 Host 的 HTTP origin。差异只在传输路径，插件代码、路由表、槽位、存储完全相同。

---

## 0. 结论速览

**适配性：0 条阻断级问题。** 0.3.12 在桌面 0.2.1-rc.3、网页 npm `latest` rc.2、网页 npm `next` rc.4 上都能装载、下发 Client bundle 并完成真实删除链路。三版的槽位名、`uiWorkspace`/`sessions` 服务、`workspaceRegistry`/`Workspace` 方法、`connection.requestRejection` 与 `connection/request` 瀑布流均未变。

**功能缺陷：4 条（1 高 / 1 中 / 2 低）+ 1 条文档不一致。** 全部位于 Host/Client 插件自身逻辑，与桌面/网页版本差异无关；其中最高优先级的一条让**默认 soft 模式下的“30 天自动清理”实际永远不会发生**。

| ID | 级别 | 问题 | 影响 | 证据 |
|---|---|---|---|---|
| **B-01** | 高（功能承诺失效，非数据丢失） | 保留期清扫对 `mode: 'soft'` 且会话仍可解析的条目一律跳过；soft 删除**保留日志**，所以默认模式条目到期后永远不会被自动清理，回收站只增不减 | UI 仍显示“N 天后自动清理”和倒计时，与实际行为相反 | 隔离 rc.4 实测 |
| **B-02** | 中 | “日志已移动、manifest 尚未记录”的崩溃窗口条目：`restore` / `discard` / `purge` 三条路全部拒绝，日志被永久困在回收站目录 | 只能手工移动文件系统才能恢复；UI 只显示一个必然 409 的 Discard | 隔离 rc.4 实测 |
| **B-03** | 低 | `/trash` 的 `capabilities` 未结合磁盘/载荷判断：`canRestore:true`、`canDiscard:true` 与实际路由结论不一致 | 依赖 capabilities 的调用方/UI 会展示必被拒绝的动作；与 0.3.12 “capabilities 不再撒谎”的注释相反 | 隔离 rc.4 实测 |
| **B-04** | 低 | Client 的 incomplete 恢复按钮只看 `hasSessionLog === true`；只有记忆包、没有日志的未完成条目在 UI 中没有恢复入口，而 Discard 又因“仍持有记忆文件”被拒 | 记忆包只能靠手写 API 恢复 | 代码走读 |
| **B-05** | 文档 | CHANGELOG 0.3.12 写“整批全失败时才作废 token”，代码是“零失败才作废 token” | 文档与实现不符；实现本身更宽松且 token 绑定计划，无安全后果 | 代码走读 |

---

## 1. 兼容性验证（三版 × 两端）

| 目标 | 版本 | 插件装载 | 路由/鉴权 | Client bundle | 删除链路 E2E |
|---|---|---|---|---|---|
| 桌面端（活体，只读） | rc.3 | `/state` 200，`version: 0.3.12` | `/sessions` `/trash` `/audit` 200 | `__DSH_BOOT__` 含 `dsh-conversation-recycle-bin`，combo 200（114,313 B） | **未对用户真实会话执行变更** |
| 桌面端（隔离，同 rc.3 包） | rc.3 | 启动日志 `API registered` | 同上 | 200（2,124,214 B combo），`exports.name` / `exports.inject = ['slots']` 均在 | 软删→恢复、硬删→恢复 全部通过 |
| 网页端 npm `latest` | rc.2 | 启动日志 `API registered` | `/state` 200 `connectionFence: true` | 200（2,031,565 B），导出正确 | 软删→恢复 通过 |
| 网页端 npm `next` | rc.4 | 启动日志 `API registered` | `/state` 200 `connectionFence: true` | 200（2,124,214 B），导出正确 | 软删→恢复、硬删→恢复、软条目 purge 全部通过 |

补充证据：

- 桌面 Web 传输：`app.asar` 的 `lib/main.js:8268-8299` 的 `forwardWebRequest` 只接受 `origin === "dsh-app://app"`，随后删除 `host` / `origin` / `cookie` / `sec-fetch-site` 并注入 Host 签发的 cookie；插件的 `x-conversation-recycle-bin` 头被保留。这与插件 `client.js` 的 `document.baseURI` 相对 URL 策略一致。
- “桌面端”的删除 E2E 用**与已装桌面完全相同版本（rc.3）的 dsh 包 + 真实 `dsh web` 进程**跑通；`dsh-desktop-host` 外壳没有用同版本 npm 包替代（它不发布到 npm），其传输路径单独通过 `app.asar` 源码核对。
- 用 HTTP 直接带 `Origin: dsh-app://app` 探测会得到 403，但错误来自 **DSH connection 层**（“refused at the connection layer”），不是插件自己的 origin 校验；真实桌面路径里外壳已把 Origin 删除，不能把这条 403 当作插件 bug。
- rc.2 → rc.3 → rc.4 的 `dsh-client-ui-workspace` / `dsh-client-ui-conversation` / `dsh-client-ui-settings` 槽位名与 `useMenuOpenState` 注入未变；`uiWorkspace.clearArchivedCurrent` / `clearMain`、`sessions.refresh` 在三版均存在。rc.3→rc.4 的 548 个变更文件里，Client 包的差异基本是 CSS Module hash 与构建机路径；一处 locale key `session.moreViewsCurrent` 被移除，与本插件无关。
- `npm test` **60/60 通过**；`npm run check` **9/9 通过**。上述 4 条功能缺陷没有一条被现有用例覆盖。

---

## 2. 缺陷详情

### B-01（高）默认 soft 模式的“30 天自动清理”永远不会执行

**位置**

- 清扫跳过逻辑：[lib/host/api.js:1118-1131](lib/host/api.js)
- 到期倒计时（未区分 mode）：[lib/core/retention.js:72-82](lib/core/retention.js)
- UI 展示倒计时/横幅：[client.js:1857-1862](client.js)、[client.js:1931-1932](client.js)

**机制**

`performPurge` 对 `mode: 'soft'` 的条目会先 `inspect` 会话，若“仍可解析”就跳过（记 `E_SESSION_ALIVE`），注释的意图是“不去碰用户复活的对话”。但 soft 删除的定义就是**保留日志**（只 `archiveSession`），归档后的会话通过 `sessionPersistence.stat` **依然可解析**。因此只要日志还在（soft 删除的正常状态），条目到期后就必然命中跳过分支，永远不会被自动清除；只有日志被外部删除后才会落入可清扫集合。

**实机复现（隔离 rc.4）**

1. 对一个空白会话执行 soft 删除（返回 200，日志仍在磁盘，条目录入回收站，`daysLeft: 30`）。
2. 把 manifest 的 `deletedAt` 改为 60 天前，重启 Host 重置清扫节流。
3. `GET /trash` 后 `lastSweep = { purged: 0, failed: 2 }`；两条 `daysLeft: 0` 的 soft 条目仍在列表中，目录也仍存在。
（另一条为构造的同形条目，用于排除偶然性。）

**线上旁证**：桌面 Host 的回收站现有 52 条，其中 **48 hard / 4 soft**；4 条 soft 的 `daysLeft` 为 19–30，UI 会承诺自动清理。对这 4 条的 `/preview` 探测均为 `E_NOT_FOUND`（日志已不可解析，因此到期后会被清），属特例；正常 soft 删除保留日志，仍落入“永不自动清理”的代码路径。

**建议修复**（二选一，或两者都做）

- 清扫守卫区分“复活”与“仍归档”：仅在 `session.archived === false`（明确未归档）或 `session.running === true` 时跳过；归档状态（`archived === true`）的 soft 条目按 `performPurge` 正常清理。归档状态读不到时继续按“保守跳过”处理，避免误删。
- 若产品决定 soft 条目永不自动清理，则 `serializeEntry` 对 `mode === 'soft'` 返回 `daysLeft: null`，UI 不再显示倒计时与“N 天后自动清理”横幅，并更新 `config.schema.json` 的说明。

---

### B-02（中）崩溃窗口的 hard 条目三路皆拒，日志被困

**位置**

- 删除顺序（先移动日志，再写 manifest）：[lib/core/cascade.js:153-176](lib/core/cascade.js)
- 恢复要求 `sessionLog` 是对象、目录校验：[lib/core/cascade.js:325-377](lib/core/cascade.js)
- 无可恢复步骤即 409：[lib/core/cascade.js:415-424](lib/core/cascade.js)
- Discard 在磁盘上看到 `session/` 即拒绝：[lib/core/cascade.js:620-638](lib/core/cascade.js)
- Purge 只接受 `trashed` / `restored`：[lib/core/cascade.js:271-274](lib/core/cascade.js)
- Client 只按 `hasSessionLog` 显示 Restore：[client.js:1569-1575](client.js)

**机制**

hard 删除先在 manifest 写入 `status: 'pending'` 且 `sessionLog: null`，随后才把日志目录移入 `<entry>/session` 并回写 `sessionLog`。若进程在“移动完成、manifest 回写前”被杀/断电，就会留下：

- `status: pending`（进程崩溃后不会自愈；异常/人工构造时也可能表现为 `failed`）
- `sessionLog: null`、`catalog: null`
- 磁盘上确有 `<entry>/session/`（日志的唯一副本）

此时 `restore` 因为 `sessionLog === null` 认为“没有东西可恢复”，409；`discard` 因为磁盘检查发现 `session/`，409；`purge` 因为状态不是 `trashed`，409。Client 又因为 `hasSessionLog === false` 不显示 Restore，只显示 Discard —— 必然 409。

**实机复现（隔离 rc.4）**

构造 `pending` + `session/` + `sessionLog: null` 条目后：

```
/trash 行: hasSessionLog=false
capabilities: {"status":"pending","canRestore":true,"canPurge":false,"canDiscard":true}
POST /trash/restore  => 409 E_TRASH_CONFLICT "nothing left to restore; discard it..."
POST /trash/discard  => 409 E_TRASH_CONFLICT "still holds the conversation log; restore or purge..."
POST /trash/purge    => 409 E_TRASH_CONFLICT "cannot be purged in its current state"
```

三条建议（“discard it”“restore or purge it”）全部指向被另一条路拒绝的动作，形成死锁。

**建议修复**

`performRestore` 在 `sessionLog === null` 且 `<entryDir>/session` 存在时，用 `sessionId` + sessions 根目录重建 `{ from, to }`（`gateway.findSessionDir` 已具备该能力），通过既有的根目录守卫后按“日志在回收站”处理；catalog 快照缺失时至少把日志移回原位，再决定是否附回 workspace。这样 `performDiscard` 的“先恢复再删”建议才可执行。

---

### B-03（低）`capabilities` 与实际路由不一致

**位置**：`serializeEntry` 调用 `entryCapabilities(entry)` 时没有传磁盘信息：[lib/host/api.js:1013-1022](lib/host/api.js)；判定函数把“未知”当成可操作：[lib/core/cascade.js:288-301](lib/core/cascade.js)。

**证据**：B-02 的条目返回 `canRestore: true`、`canDiscard: true`，而 restore/discard 均 409；`canRestore` 对“无任何载荷”的 failed/pending 条目也为 `true`。0.3.12 CHANGELOG 所称“回收站行的恢复/彻底删除按 capabilities 置灰”只覆盖 `trashed` 行；incomplete 分支的按钮本来就没有用 `canRestore` 置灰，而 capabilities 自身也没有反映磁盘载荷，两处都依赖它就会展示必被拒绝的动作。

**建议**：`serializeEntry` 前 `pathExists` 检查 `<entry>/session`、`<entry>/memory` 内是否有文件，并据 `sessionLog`/`catalog`/`memory.total` 计算 `canRestore`；`canDiscard` 必须带上 `hasLogFiles` / `hasMemoryFiles`。

---

### B-04（低）只有记忆包的未完成条目在 UI 中没有恢复入口

**位置**：`IncompleteEntries` 只有在 `entry.hasSessionLog === true` 时才渲染 Restore（[client.js:1569-1575](client.js)），Discard 按钮无条件渲染（[client.js:1591-1594](client.js)）。Host 侧 `performRestore` 本身支持仅有记忆包的条目（[lib/core/cascade.js:402-413](lib/core/cascade.js)），而 `performDiscard` 在 `<entry>/memory` 仍有文件时拒绝（[lib/core/cascade.js:633-638](lib/core/cascade.js)）。

**场景**：soft/hard 删除在记忆导出并写入 manifest 后、日志/目录步骤前崩溃 → `pending`，`sessionLog: null`，`memory.total > 0`。API 可恢复，UI 只给 Discard，点击 409。与 B-02 同源（缺“载荷存在性”信号）。

**建议**：Restore 的显示条件改为 Host 下发的 `canRestore`（由 B-03 的修复保证准确），而不是 Client 自己看 `hasSessionLog`。

---

### B-05（文档）确认令牌作废条件与 CHANGELOG 不符

CHANGELOG 0.3.12 写“整批全失败时才作废 token，部分失败可以用同一个 token 重试剩余项”；代码是 `if (failures.length === 0) markConfirmationUsed(validated)`（[lib/host/api.js:853](lib/host/api.js)），即**只有零失败才作废**，全失败时 token 仍保留。实现更宽松且 token 绑定 `(ids, mode, includeMemory)`，重放不会多删，安全上无问题；需要修正的是文档描述。

---

## 3. 非缺陷但容易误判的点

| 现象 | 判定 |
|---|---|
| `/state` GET 不带 `x-conversation-recycle-bin` 头仍 200 | 私有头只在 POST 分支校验（[lib/host/api.js:1259-1262](lib/host/api.js)）；GET 仍受 DSH cookie 围栏保护，跨站读不到数据。README“暴力/脚本调用”一节若被读成“所有请求都要头”，属措辞不精确 |
| HTTP 探测带 `Origin: dsh-app://app` 得到 403 | 拒绝来自 DSH `connection` 层；桌面真实请求已被外壳删除 Origin，插件自身校验实际放行该源 |
| 桌面回收站有 3 条 2026-10-17 的 failed 条目、`hasSessionLog:false` | 旧审计遗留的测试产物，无载荷，Discard 可正常清掉；不是新 bug |
| `lastSweep.failed` 大于 0 | 若由到期 soft 条目产生，就是 B-01 的 `E_SESSION_ALIVE` 计数；目前 UI 只展示 `purged`，不展示失败原因 |

---

## 4. 未验证项（不要当作已验证）

1. **UI 点击链路本轮未完成**：浏览器打开 rc.4 隔离实例后被“预览版说明”模态挡住，未能实际点开侧栏菜单与设置页；只观察到 `/conversation-recycle-bin/api/state` 正常发起、控制台无错误。菜单项/设置页的渲染结论来自槽位与 bundle 代码比对 + 上一轮 rc.3 审计。
2. **真实灵枢记忆的级联未跑**：隔离 Home 没有 `.dsh-memory/data/mdcg/_index.json`，只验证了适配器“可用/不可用”的状态上报；记忆节点/正文/跨节点引用的移动与恢复仍需在有真实记忆库的环境单独验证。
3. **反馈邮件的真实投递未触发**（避免向维护者邮箱发信）。
4. **桌面 Renderer 内没有 DevTools 抓包**；桌面链路是“活体 Host HTTP 只读探测 + 外壳源码 + 同版本 rc.3 隔离 E2E”三段拼合。
5. 本报告的时间基线为 2026-10-29；若之后桌面 feed 或 npm dist-tag 前进，需要重跑。

---

## 5. 方法与清理

- 桌面 `app.asar` 用 `@electron/asar` 全量抽取（307 个顶层 `@deepseek-ai` 包）；npm 侧安装 rc.2 / rc.3 / rc.4 三套完整宿主依赖（`--ignore-scripts`，含 optional 原生包）。
- 隔离 E2E 使用临时 `DSH_HOME`、真实 `dsh web` 进程、真实 `connection` cookie（按 Host 同款 HMAC 自签，未打印 secret）、真实 `workspace.json` + 复制的一份空白会话日志；所有删除/恢复/清理只发生在临时 Home。
- 活体桌面 Host 只做只读探测（`/state`、`/sessions`、`/trash`、`/audit`、首页与插件 bundle），未对用户会话执行任何变更。
- 审计期间的临时目录 `dsh-audit-tmp-20261029`（asar 抽取、三套 npm 宿主、三个隔离 Home）与探测脚本已删除，隔离 Host 已停止。§0–§5 记录 0.3.12 的审计快照；0.3.13 的修复改动见 §6。

---

*本报告 §0–§4 是 0.3.12 的审计快照；用户随后要求“全部修复”，实际改动与复验记录见 §6。*

---

## 6. 修复记录（0.3.13）

审计交付后按“全部修复”落地，版本 0.3.12 → **0.3.13**；`npm test` **186/186**、`npm run check` **9/9**。

| 项 | 改动 | 运行时复验 |
|---|---|---|
| **B-01** | 清扫守卫改为只跳过“已复活（`archived === false`）或仍在运行”的 soft 会话；归档状态（`archived === true`）的 soft 条目照常 `performPurge` | 隔离 rc.4：soft 删除后把 `deletedAt` 改到 60 天前、写入归档标记，`GET /trash` 后 `lastSweep = {purged:1, failed:0}`，条目目录与日志均被清除 |
| **B-02** | `messages` 步骤先写 `{from,to}` 再移动日志；`session` 步骤先落盘 catalog 快照再改工作区；`performRestore` 对旧版遗留的 `sessionLog:null + session/` 条目从日志首行 `cwd` 重建原路径（zstd 按需解码） | 隔离 rc.4：构造 `pending + session/ + sessionLog:null` 条目，`POST /trash/restore` 200，日志回到 `sessions/<slug>/<id>/`，条目目录删除，`/sessions` 重新列出会话 |
| **B-03** | `serializeEntry` 读取 `<entry>/session`、`<entry>/memory` 的磁盘载荷；`canRestore` 要求确有载荷，`canDiscard` 在仍持有日志/记忆文件时为 false；unreadable 目录也带 capabilities | 同一构造条目返回 `{"canRestore":true,"canPurge":false,"canDiscard":false}`，与三条路由的实际结论一致 |
| **B-04** | Client 的 `IncompleteEntries` 改为按 `capabilities.canRestore` / `canDiscard` 渲染；旧 Host 无 capabilities 时回退到 `hasSessionLog` | Client 单元用例：仅记忆包条目显示恢复、隐藏丢弃；无载荷条目相反 |
| **B-05** | 0.3.12 CHANGELOG 的 token 描述改为与实现一致（整批零失败才作废）；README 同步 | 文档走读 |
| 测试 | 新增 8 条：归档 soft 到期清理、复活 soft 保留、日志映射移动前落盘、崩溃窗口日志映射重建、无载荷 `canRestore:false`、磁盘载荷阻止 discard、Client 按 capabilities 显示、`projectKey` + zstd 日志头 | 178 → **186** |

本轮修复同时把 `AUDIT-2026-10-29-desktop-web.md` 加入仓库；审计期间的临时宿主与脚本再次清理，隔离 Host 已停止。产品代码改动见 `CHANGELOG.md#0313`。

---

## 7. 发布记录（0.3.13，2026-10-29）

| 项 | 值 |
|---|---|
| Git 提交 | `a502066`（`release: v0.3.13 — 修复桌面/网页复核的 4 个缺陷与 token 文档偏差`），已推送 `origin/main` |
| Git 标签 | `v0.3.13`（tag 对象 `0fc477f`，指向 `a502066`），已推送 origin |
| npm | `dsh-conversation-recycle-bin@0.3.13`，`dist-tags.latest = 0.3.13` |
| npm tarball | `shasum 704f96ac9cc8a5cd9a57220249a41d76d1d6d6dd`，36 个文件 / 546,795 B 解包 |
| 发布前门禁 | `npm test` 186/186，`npm run check` 9/9 |

发布采用 `npm publish --loglevel=error`，npm 日志为 `PUT 202`；随后 `npm view` 已可见 `latest = 0.3.13` 且 shasum 与发布日志一致。桌面 profile 通过 Junction 指向本工作树，**需重启桌面端**才能加载新的 Host 半与 Client bundle。
