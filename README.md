# dsh-conversation-recycle-bin

给 DeepSeek Harness (DSH) Web 增加「删除对话」：会话列表的「…」菜单与会话详情页头部各有一个删除入口；确认框内可勾选「同时删除关联记忆」（默认不勾选），并实时显示将被影响的记忆条数。删除默认进入插件回收站，可恢复；每次操作写入审计日志；批量删除有上限与限流，批量软删除需输入数量，彻底删除一键执行；事务任一步失败即回滚。

> 状态：`0.2.2`，Host + Web Client 双半，零构建（plain JS ESM），只依赖宿主已发布的公开扩展点。
> 包名：`dsh-conversation-recycle-bin`（原 `dsh-delete-conversation` 因 npm 被他人占用而改名，见 CHANGELOG 0.2.0）。
> 本 README 同时是设计说明与验收依据；安装/回滚步骤见 [INSTALL.md](INSTALL.md)；变更见 [CHANGELOG.md](CHANGELOG.md)。

---

## 1. 宿主平台规范确认（第一步）

以下结论来自对当前安装的 DSH `0.2.1-rc.2`（桌面端 desktop profile）的 `cordis_inspect_query` 与实现源码核对，不是假设：

| 项目 | DSH 事实 | 本插件的落点 |
|---|---|---|
| 插件单元 | 一个 bundle = `package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml` 的 `- insert:` 行；行 `id` 是 Plugins 页与配置的稳定键 | `cordis.patch.yml` 插入一行 `id: conversation-recycle-bin` |
| 权限/配置声明 | 宿主校验服务访问靠 Cordis `inject`；行配置靠 `export const Config`（需要 schema 运行时依赖）。社区插件的无 schema 路径：在 `apply()` 里自校验并在 `/state` 暴露问题 | 无 `Config` 导出；`lib/core/config.js#normalizeConfig` 严格校验 + `config.schema.json` 文档 + `/state` 报告 |
| 服务注入 | Host：`export const inject = [...]`；可选服务用 `ctx.get(name)` 逐次探测。`webServer` 在插件行挂载时可能尚未发布，一次性 `ctx.get('webServer')` 会永久拿到 `undefined` | `inject = ['webServer']`（路由是产品本体）；其余服务请求时探测，缺失返回可读错误 |
| UI 扩展 | 只通过 Slot：`ctx.slots.inject(key, () => ctx.slots.register(options, Component))`；Client 半必须 `exports.inject = ['slots']`，否则 `apply` 可能先于 slot 服务运行而静默不注册 | `client.js` 注册 4 个槽位（见 §3） |
| 会话列表入口 | `sidebar.workspaces.session.menu.item`（list / root）：owner props `{sessionId, displayTitle}`，额外注入 `useMenuOpenState()`，用 `setOpen(false)` 关闭菜单 | 「…」菜单新增一行「删除对话…」 |
| 会话详情页入口 | `conversation.session.header.actions`（list / session）：标准 props 直接含 `sessionId` | 头部新增一个删除图标按钮 |
| 对话框落点 | 菜单项随下拉菜单卸载；对话框必须挂在根级 overlay | `shell.overlay` 里的 `DialogHost`，菜单项只写模块级 dialog store |
| Client→Host | 生成式 `ctx.remote.*` 在构建期固定，纯 JS 插件无法新增命名空间；Client `ctx.connection` 没有 `fetch`；推荐 Host `ctx.webServer.register({kind:'prefix', path, handler})` + 同源 `fetch(document.baseURI)` | 自定义路由 `/conversation-recycle-bin/api/*` |
| 路由鉴权 | Web server 本身不鉴权；官方插件用 `ctx.connection.requestRejection(req)` 兜底。本插件另加：同源校验、loopback 默认、私有无头 header、JSON content-type、体积上限 | 见 `lib/host/api.js#requestOriginVerdict` |
| 桌面/网页传输差异 | 桌面端页面源是特权 scheme `dsh-app://app`（安装包 `out/lib/main.js` 注册），Renderer 对 Host 的请求经外壳 `forwardWebRequest` 转发：**删掉 `origin`/`sec-fetch-site`/`host` 头**并附上 Host 签发的 cookie；网页端是同源 fetch，三个头都在 | Client 一律用 `document.baseURI` 相对路径：桌面走 `dsh-app://app/...` 由外壳转发，网页走同源直连；Origin 完整性校验（主机名+端口）实际约束的是网页路径，桌路径由外壳自己的 `origin === "dsh-app://app"` 闸门 + cookie 保证 |
| Agent 工具 | 用户授权类操作应保持 user-only（skill `user-actions`） | **不注册任何 agent tool**，模型无法执行或授权删除 |

**操作者模型**：DSH 是本地单用户应用，没有账号/角色系统。因此本插件把「操作者权限」落实在传输层（同源页面、默认仅 loopback、私有请求头）与数据归属策略（工作区登记、允许根目录、受保护 id、子代理来源、live 状态）上，而不是虚构一套用户体系。

---

## 2. 会话 / 消息 / 记忆的数据模型与级联（第二步）

### 2.1 存储事实

| 实体 | 位置 / 主键 | 说明 |
|---|---|---|
| 会话 | `<DSH_HOME>/sessions/<project-slug>/<encoded-session-id>/`，主键 `SessionHeader.id`；当前日志 `session.v4.jsonl.zstd`（v0/v3 代际可能并存） | 没有会话目录索引文件；列表是目录扫描 + `workspace.json` 补充 |
| 消息 | **没有独立消息库**。消息是会话日志里的事件：`user/message`、`assistant/message`、`tool/result`、`system/message`、`developer/message`；持久键 `(session.id, event.seq)`，消息对象另带 UUID `id` | 删除消息 = 移走日志；恢复 = 移回 |
| 工作区账本 | `<DSH_HOME>/storages/workspace.json`：`tables.workspaces[wid].sessionIds[]`、`global.archivedSessionIds[]`、`global.pinnedSessionIds[]` | 官方 `workspaceRegistry` / `Workspace.*` 是唯一写入口 |
| 投影缓存 | `<DSH_HOME>/storages/session_projcache/sessions/<id>.json`（v7，权威）；根级 `session_projcache.json` 是旧版残留 | 派生缓存，可自愈；硬删时尽力清理 |
| 灵枢记忆 | `<DSH_HOME>/.dsh-memory/data/mdcg/_index.json`（schema 2）：`nodes.<id>.session` 就是会话 id；正文 `<layer>/<id>.md` | 本插件唯一默认的记忆存储适配器 |
| Hindsight / dsh-mnemon | Hindsight 为 bank 级且 DSH 处已禁用；Mnemon documents 有 `sessionIds[]` 但只有 archive、无 unarchive | 不纳入默认删除路径（理由见 §5.3） |

### 2.2 关系

- **会话 1 : 1 日志**：一个 `session.id` 对应一个目录（多代际日志共存于同一目录）。
- **会话 1 : N 消息事件**：消息由事件派生；`seq` 是稳定顺序，`message.id` 是内容 id。
- **会话 1 : N 灵枢记忆节点**：`_index.json` 的 `nodes[*].session` 等于会话 id。一个节点只归属一个会话；但节点之间可有 `edges / depends_on / derived_from` 引用，因此删除一个会话的节点可能在其他会话的节点里留下悬空引用。
- **孤儿记忆归属**：某节点带 `session`、但该会话的日志已不存在时，**本插件永不自动删除它**。删除入口只会统计并移动「目标会话 id 精确匹配」的节点；跨会话的引用会被清掉并在回收站 bundle 里记录（恢复时原样补回），而孤立节点本身保留给用户/灵枢自行处理。
- **工作区归属**：`workspace.sessionIds[]` 只登记了一部分会话（本机 36/92）。未登记的会话默认拒绝删除（`E_POLICY_ORPHAN`），避免误删游离日志；可在配置中显式放开。

### 2.3 级联顺序与事务

```
memory  →  messages  →  session/catalog
  │           │              │
  │           │              └─ soft: workspaceRegistry.archiveSession(stopActivity)
  │           │                 hard: unarchive → unpin → workspace.detachSession
  │           └─ hard: 把会话日志目录 move 到回收站；soft: 保留日志（软删除语义）
  └─ 勾选时：灵枢节点 + 正文移入回收站 bundle，并记录被剥离的跨节点引用
```

`soft` 模式有意不移动日志：它用宿主官方 archive 把会话从侧栏隐藏，磁盘内容保持完整，直到用户在回收站里「彻底删除」。`hard` 模式移动日志目录（回收站内仍可恢复）；若会话仍被活跃 Agent 持有，会先取消当前轮次、`archiveSession({stopActivity:true})` 并在 `liveDrainMs`（默认 2000ms）内等待其停止，然后才移动日志。**移动前还会复检日志的最新 mtime**：桌面端与 `dsh web` 共享同一个 `DSH_HOME`，本进程的 live 表看不到另一个 Host 的写入；若日志在 `foreignWriterGraceMs`（默认 1500ms）窗口内仍在增长，就中止并报 `E_POLICY_FOREIGN_WRITER`（best-effort，不能替代"关闭另一端的会话"）。两种模式都把条目写进插件回收站与审计。

每次单会话删除是一个 `runSteps` 事务：每一步返回 undo，后续步骤失败时按**逆序**回滚；回滚失败会被收集并在错误详情与审计中标记 `rolledBack: false`，不会被吞掉。批量删除的每个会话各自一个事务，互不连坐。

---

## 3. 删除入口与确认框（第三步）

| 入口 | 槽位 | 行为 |
|---|---|---|
| 会话列表「…」 | `sidebar.workspaces.session.menu.item`（order 500） | 点击后关闭菜单，打开全局确认框 |
| 会话详情页头部 | `conversation.session.header.actions`（order 100） | 图标按钮打开同一确认框 |
| 设置页 | `settings.section`（order 1300） | 「回收站 / 批量删除 / 审计留痕」三个标签页 |
| 全局确认框 | `shell.overlay` | 唯一删除发起处；挂在根级，不会随菜单卸载 |

确认框内容：

- 标题与影响说明（单个显示会话标题；批量显示数量）；
- 删除方式单选：**默认「移入回收站」**，可选「彻底删除」；
- 复选框「同时删除该对话的关联记忆」：**默认不勾选**；勾选状态改变会重新向 Host 取计划，因此条数与确认 token 始终对应同一计划；
- 实时记忆条数：`N 条关联记忆`（未勾选时显示「找到 N 条」，勾选后显示「将把 N 条移入回收站」）；不可用时明确写「记忆存储不可用：原因」，不会伪装成 0；
- 受保护节点单独显示「另有 N 条受保护记忆将保留」；
- 二次确认：批量**软删除**需输入数量；**彻底删除无需输入**，点击删除按钮即执行（Host 仍校验单次 token，过期、篡改、重放的计划会被拒绝）；回收站「永久清除」仍需输入 `DELETE`；
- 失败时显示可读错误码/原因，并自动重新拉取计划（token 已消费或数据已变化时不会执行旧计划）。
- 删除/恢复成功后**不整页刷新**：Client 调 `sessions.refresh()` 原地更新会话列表；若删掉的是当前打开的会话，再关闭当前视图回到空白页。恢复只刷新列表，不打断当前会话；只有 client 半缺少 `sessions` 服务时才回退到 `location.reload()`。

---

## 4. 删除逻辑与安全机制（第四、五步）

### 4.1 执行链（Host，`lib/host/api.js`）

1. `POST /preview`：校验 session 存在、工作区归属、是否受保护/子代理/超出允许根；hard 模式下活跃会话不再拒绝，而是给出「会先停止该会话」的 warning（`stopLiveSessions:false` 时仍拒绝）。随后统计日志条数与记忆数，签发**单次使用**确认 token（绑定排序后的 sessionIds + includeMemory + mode，TTL 默认 120s）。
2. `POST /delete`：
   - 传输层依次过三道闸：本路由自身的 loopback/Origin（比较完整 authority：主机名**和**有效端口，桌面 `dsh-app://app` 外壳源按 DSH 自己的口径豁免）/私有 header 校验 → DSH `connection.requestRejection`（401/403 短路）→ `ctx.waterfall('connection/request', ...)`（桌面更新任务借此在安装更新时返回 503 并排空在途请求，删除事务不会被杀在半路）；
   - token（彻底删除无需短语；批量软删除校验数量）、**有效批量上限** `min(maxBatchSessions, 本分钟剩余额度)`、限流（默认 20 次/分钟，滑动窗口）全部通过后才消费 token；
   - 先对**全部**会话做策略预检，任一被拒绝则整批不执行（不会半成功）；
   - 逐会话执行 `quiesce(live) → memory → messages → session/catalog` 事务；
   - 所有 mutation（delete/restore/purge/discard）串行经过进程内链 + `<dataDir>/mutation.lock` 跨进程文件锁：桌面端与 `dsh web` 共享一个 `DSH_HOME` 时，第二个实例的并发删除会拿到 `E_LOCK_BUSY` 而不是写坏同一份 manifest；
   - 返回 `{ok: true, partial, results, failures}`：`ok` 表示计划已执行，`partial` 表示有会话失败；只有**全部**失败时才抛首个错误（HTTP 状态来自 `ERROR_STATUS`，错误码保留真实策略码）。
3. `GET /trash`（返回 `entries`（可恢复）与 `incomplete`（failed/pending/restoring/purging））、`POST /trash/restore`、`POST /trash/purge`（必须输入 `DELETE`）、`POST /trash/discard`（清理未完成条目，必须输入 `DELETE`；仍保存会话日志的条目应走「恢复」而不是 discard）。未完成条目若还留着会话日志，设置页会给出「恢复」按钮，可以直接把它恢复回会话列表。
4. `GET /audit?limit=N`。

### 4.2 安全清单

| 风险 | 措施 |
|---|---|
| 误删 | 默认软删除；记忆复选框默认关；回收站；彻底删除一键但仍写回收站可恢复；批量软删除需输入数量 |
| 批量误操作 | `maxBatchSessions`（实际上限还会被本分钟剩余额度收紧，避免"合法批量必然 429"）；批量需输入数量；每个会话独立事务 |
| 暴力/脚本调用 | 同源校验（完整 authority：主机名+有效端口）+ `x-conversation-recycle-bin: 1` 私有 header + DSH `connection` 层（`requestRejection` + `connection/request` 瀑布流）+ 限流；默认仅接受 loopback 绑定，`allowNonLoopback=false` |
| 两个 Host 并发写同一回收站 | mutation 串行 + `<dataDir>/mutation.lock` 跨进程文件锁，抢不到锁返回 `E_LOCK_BUSY`（而非写坏 manifest） |
| 越权/越界 | 不在工作区登记的会话默认拒绝；可配置允许根目录白名单；受保护 id 列表；子代理会话默认拒绝 |
| 活跃会话被写坏 | hard 模式对 live 会话先走 `quiesce`：取消当前轮次 → `archiveSession({stopActivity:true})` → 在 `liveDrainMs` 内等待 `running=false`，之后才移动日志；仍停不下来则整笔回滚并报 `E_POLICY_LIVE`。`stopLiveSessions:false` 可恢复为直接拒绝 |
| 另一个 Host 正在写 | 移动前按 `foreignWriterGraceMs` 复检日志 mtime；仍在增长则报 `E_POLICY_FOREIGN_WRITER`。best-effort：两端同时运行时仍应先关闭另一端的会话 |
| 失败半删 | 每会话事务 + 逆序回滚；回滚失败进入错误详情和审计 |
| 不可追溯 | `<DSH_HOME>/delete-conversation/audit.jsonl` 追加成功/失败/回滚/拒绝/恢复/清理记录；设置页可查看 |
| 外部记忆存储损坏 | 灵枢适配器持有其 `_index.json.lock`，先写 restore bundle 再原子改写索引；任何一步失败先还原正文与索引；详情见 §5.3 |

### 4.3 回收站布局

存储目录沿用旧插件的 `delete-conversation`（不是新包名），这样 0.2.0 改名后已有的回收站条目和审计日志仍然可见。

```
<DSH_HOME>/delete-conversation/
  audit.jsonl
  trash/<trashId>/
    manifest.json          # format 1：会话、模式、catalog 快照、memory bundle 引用、状态
    session/               # 仅 hard：移走的会话日志目录
    memory/lingshu/
      bundle.json          # 节点全文、正文文件、被剥离的跨节点引用
      files/<nodeId>.content
```

`manifest.status` 只允许 `pending → trashed → restoring/restored / purging`。`GET /trash` 把**所有**条目都返回：`trashed` 进 `entries`（回收站 UI，可恢复/彻底删除），其余状态进 `incomplete`（设置页单独列出，提供「恢复」与「discard」两个出口，不再出现"失败了却没有任何清理入口"的死条目）。恢复顺序是删除的逆序：日志 → catalog → 记忆。

---

## 5. 记忆适配器与诚实边界

### 5.1 灵枢（默认，已实机核对格式）

- 计数：读 `_index.json`，按 `nodes[*].session === sessionId` 过滤；`protected === true` 或 `immutable === true` 的节点只计数、不删除。
- 删除：持插件私有锁 `_index.json.conversation-recycle-bin.lock`（**不碰** md_cg 的 `_index.json.lock`——那是 md_cg 的永久 0 字节 OS 字节锁文件，存在与否不代表加锁，删它反而会破坏 md_cg 自己的互斥；本锁只协调本插件的多个 Host 进程），把节点正文移到回收站 bundle，从索引删除节点，并剥离其他节点指向被删节点的 `edges/depends_on/derived_from` 引用；先写 bundle 再改索引，失败时还原。**没有任何可删节点的会话会先读索引直接返回空 bundle，不取锁**，因此记忆库繁忙不会拖住一次本来无记忆可删的彻底删除。
- 分片日志：md_cg 的索引是「快照 `_index.json` + `_index_log/` 追加分片，装载时重放」。删除/恢复除改写快照外，还会写入一个**新分片**（`e: null` 墓碑 / 恢复后的节点记录），`_t` 取「现在」与「最新分片时间 + 1ms」的较大值，保证重放时我们的记录排在最后，已删节点不会因重放复活、已恢复节点不会被旧墓碑覆盖。
- 恢复：按 bundle 把正文放回、节点条目与引用补回；若目标 id 已存在则拒绝并报 `E_TRASH_CONFLICT`。
- **边界**：这是「离线索引适配器」，不经过灵枢的 `forget` 工具，因此不会写它的 `_deletions.jsonl` 墓碑、`trash/` 与 review queue；`_recent.jsonl` 滚动窗口里的旧文本会自然过期。对格式做的是 schema 2 的受支持子集。若要求走灵枢自己的软删/审计语义，请使用 `lingshu_cg op=forget`（可能进入 review queue，需校验 receipt），本插件不冒充该协议。

### 5.2 通用 JSON 索引适配器

`memory.generic` 可指向任何形如 `{nodes: {"<id>": {"session": "...", "path": "..."}}}` 的本地索引，用于其他记忆库；同样先 bundle 后索引、可恢复。未配置时不会启用。

### 5.3 为什么没有默认纳入 Hindsight / Mnemon documents

- Hindsight：本机 DSH harness 已禁用；记忆是 bank 级而非会话级，虽有 `metadata.session_id` 但**没有暴露删除工具**。
- Mnemon documents：有 `sessionIds[]` 但删除只有 archive、没有 unarchive，且一个文档可跨多个会话，无法满足「失败回滚/可恢复」的质量要求。
- 两者在 `/state` 与 README 中明确标为未支持，而不是静默忽略。

---

## 6. 目录结构与代码地图

```
dsh-conversation-recycle-bin/
├─ package.json                 # bundle + dsh.client 声明
├─ cordis.patch.yml             # Host 行与默认配置
├─ config.schema.json           # 配置/权限的机器可读声明
├─ client.js                    # Web Client：4 个槽位 + 确认框 + 设置页（内联中英文案）
├─ icon.svg
├─ lib/
│  ├─ index.js                  # apply(ctx, config)：注册路由
│  ├─ core/                     # 纯逻辑（无 DSH 依赖，可单测）
│  │  ├─ config.js              # 默认值/归一化/JSON pointer
│  │  ├─ errors.js              # 错误码 ↔ HTTP 状态
│  │  ├─ policy.js              # 权限与数据归属
│  │  ├─ rate-limit.js          # 滑动窗口限流
│  │  ├─ transaction.js         # 逆序回滚原语
│  │  ├─ cascade.js             # 三阶段级联 + 恢复 + 彻底删除
│  │  ├─ trash.js               # 回收站 manifest
│  │  ├─ audit.js               # JSONL 审计 + 压缩
│  │  └─ memory/                # 记忆适配器（lingshu / generic-json / none）
│  └─ host/                     # DSH 服务适配
│     ├─ paths.js               # DSH_HOME、会话目录发现、原子写
│     ├─ gateway.js             # 会话/标题/归属归一化
│     ├─ catalog.js             # archive/detach/pin 与日志移动
│     ├─ lifecycle.js           # live 会话停机：cancel + archive + drain
│     ├─ memory.js               # 适配器装配
│     ├─ feedback.js             # 反馈校验/渲染/投递（http 或 smtp，凭证只读环境变量）
│     └─ api.js                 # 同源 HTTP API、确认 token、限流
└─ test/                        # 131 个用例，覆盖用户要求的 5 类场景 + live 删除 + 记忆锁 + 原地刷新 + 部分失败/跨进程/未完成条目 + 反馈通道 + Client 半渲染冒烟
```

---

## 7. 测试与验收

```powershell
cd D:\Users\34332\AI\dsh-conversation-recycle-bin
npm test        # = manifest && client-module && core && cascade && memory && trash-audit && feedback && api（131 个用例）
npm run check   # 语法 + manifest
```

| 用户要求场景 | 用例 |
|---|---|
| 单条删除 | `api.test.mjs`「soft delete…」「hard delete…」；`cascade.test.mjs` 顺序/回滚 |
| 批量删除 | `api.test.mjs`「batch: double confirmation…」（软删）「batch: permanent deletion is one click…」（彻底）「a partial failure is a result…」（部分失败）「the effective limit…」（批量/限流上限）；`preview: batch size limit` |
| 勾选记忆 | `api.test.mjs`「preview: counts…」「soft delete…」「restore…」；`memory.test.mjs` 全量 |
| 无权限 | `api.test.mjs`「authorization: orphan / protected」「security…」「confirmation replay」；`core.test.mjs` 策略表 |
| 删除失败回滚 | `api.test.mjs`「rollback: a missing log…」；`cascade.test.mjs` 三个失败/回滚用例；`trash-audit.test.mjs` 审计 `rolled-back` |
| Client 半冒烟 | `client-module.test.mjs`：按宿主 `__ModuleLoader__` 契约加载、`apply()` 注册 4 个槽位、每个组件做一次惰性渲染、部分失败响应不被当作拒绝、UI 开关隐藏入口、私有方法缺失时兜底重载 |
| 回收站/未完成条目 | `api.test.mjs`「trash: an entry that never committed…」；`trash-audit.test.mjs` 审计 `rolled-back` / `discard` |
| 删除后界面更新 | `client-module.test.mjs`「updates the shell in place」：原地刷新、关闭被删的当前会话、恢复不打断当前视图、旧宿主兜底重载 |

宿主规范校验（安装后由宿主完成）：`plugin_manager install_bundle` 会校验 manifest/patch；`cordis_inspect_query Config.listConfigs` 确认行挂载；`Slots.listSubTree` 确认 4 个槽位占用出现。**本 README 不声称浏览器视觉验收已完成**——在未安装/未控制浏览器前，UI 只做到源码与槽位契约级验证（见 INSTALL.md 的验证清单）。

---

## 8. 已知限制

1. DSH 没有官方会话删除 API；hard 模式是插件自己负责的「移动式删除」。对 live 会话会先通过官方 `sessionController.cancel` + `workspaceRegistry.archiveSession({stopActivity:true})` 停机并等待 `liveDrainMs`，但底层日志布局仍可能与宿主升级耦合（升级后请先跑测试/在测试会话上验证）。
2. `workspace.json` 里的 `archivedSessionIds`：非 live 会话的 hard 删除会无条件 `unarchiveSession` 清理归档标记；live 会话则**保留归档墓碑**，防止已排队的唤醒在日志移走后重新创建会话（恢复回收站条目会清除墓碑）。宿主没有公开「Agent 已释放」通知，因此已彻底清理的 live 条目可能留下一个无害的归档 id；若宿主以后改变归档语义需复核。同理，hard 删除 live 会话后，被删会话的 live 对象可能仍留在**当前宿主进程**的内存列表里（磁盘日志已移走），侧栏由归档墓碑隐藏；宿主重启后该对象不再出现。这也是「不整页刷新」仍能立即让列表正确的原因之一。
3. 灵枢适配器不写其删除台账（§5.1）；跨节点引用只处理 `edges/depends_on/derived_from` 三个已知字段。
4. 投影缓存清理是 best-effort；旧日志/附件按宿主语义保留。
5. UI 依赖当前版本的 slot 约定；宿主升级若改 slot props，入口会失效但不会破坏宿主。0.1.4 的原地刷新还会调用 `uiWorkspace.clearArchivedCurrent/clearMain`（宿主 `.d.ts` 中标为 private）；两者都不存在时会退回整页刷新，不会留下过期视图，但属于对私有方法的依赖，宿主升级需复核。
6. 回收站 manifest 的并发写由 `<dataDir>/mutation.lock` 跨进程锁保护（抢不到锁返回 `E_LOCK_BUSY`）；但**会话日志内容**的跨进程写保护仍是 best-effort：`foreignWriterGraceMs` 只能发现"窗口内仍在增长"的日志，另一个 Host 的空闲 live 会话（两次写入之间）无法被本进程识别。桌面端与 `dsh web` 同时运行时，仍应先关闭另一端的会话再彻底删除。
7. 未完成条目（failed/pending/restoring/purging）若仍持有已移动的会话日志或记忆文件，出于数据安全不允许 `discard`（会报 `E_TRASH_CONFLICT`）；设置页对这类条目提供「恢复」按钮，可直接恢复回会话列表，不再出现"失败了却没有出口"的死条目。日志与记忆都已不在磁盘上的条目才可以 discard。

---

## 9. 反馈通道（设置页「反馈」按钮）

设置页**最上方**新增一条「反馈」横幅（主色按钮，位于标题之上）：把问题或建议写成一条消息，由**宿主进程**通过邮件发到维护者邮箱。凭证只在宿主侧读取，页面拿不到、也发不出任何邮件。

### 9.1 为什么是「页面 → 宿主路由 → 邮件」三段

浏览器既不能开 SMTP 连接，也不该持有邮件服务凭证。因此 `client.js` 只负责表单与校验提示，`POST /conversation-recycle-bin/api/feedback` 由 `lib/host/feedback.js` 校验、渲染并投递。表单里的「类型 / 标题 / 正文 / 你的邮箱」之外，只额外附带**对话框里已展示给用户**的上下文（插件版本、平台、语言）；对话内容、会话 id、工作区路径都不会进入邮件。

### 9.2 配置项（`feedback` 段，非机密）

| 键 | 默认 | 说明 |
|---|---|---|
| `feedback.enabled` | `true` | 是否允许该通道。通道本身没配好时按钮依旧不显示 |
| `feedback.to` | `b64:…`（维护者收件箱） | 收件人。默认值以 `b64:<base64>` 形式携带，公开 tarball 里没有可直接抓取的 `name@domain` 串（这是**混淆，不是加密**：解码器就在 `lib/host/feedback.js`，拿到包的人总能解出来）。也接受明文地址；`DSH_CRB_FEEDBACK_TO` 优先于它 |
| `feedback.from` | `''` | 发件人。留空时 SMTP 通道复用连接串里的用户名（服务商通常要求 From 与登录账号一致）；`DSH_CRB_FEEDBACK_FROM` 优先于它 |
| `feedback.transport` | `auto` | `auto` = 有 `DSH_CRB_MAIL_API_URL` 走 http，否则有 `DSH_CRB_SMTP_URL` 走 smtp；`http`/`smtp` 强制单通道（配不全就报未配置，不会静默换道）；`off` 关闭 |
| `feedback.rateLimitPerHour` | `5` | 每宿主每小时发送上限（1–100）。邮件从操作者自己的账号发出，默认值刻意压低 |
| `feedback.visitorAsFrom` | `false` | 访客在表单里填的**自己的邮箱**默认只作为 `Reply-To`（并在正文里列出），`From` 仍是发信账号。设为 `true` 时把访客邮箱放进 `From`——只有允许任意发件人的中继才行，QQ/163/Gmail 会拒收（它们要求 From 与登录账号一致） |

### 9.3 环境变量（优先级高于配置项；凭证只走这里，不进配置文件）

> 冲突时**环境变量赢**：`DSH_CRB_FEEDBACK_TO` 覆盖 `feedback.to`，`DSH_CRB_FEEDBACK_FROM` 覆盖 `feedback.from`。这样多台机器/多人共用一个 package 时，各自改环境变量即可，不必改配置。

| 变量 | 用途 |
|---|---|
| `DSH_CRB_FEEDBACK_TO` | 收件人（优先于 `feedback.to`） |
| `DSH_CRB_FEEDBACK_FROM` | 发件人（优先于 `feedback.from`） |
| `DSH_CRB_MAIL_API_URL` | 邮件 HTTP API 地址（Resend 兼容形状，也可指向自建转发网关） |
| `DSH_CRB_MAIL_API_TOKEN` | 该 API 的鉴权 token |
| `DSH_CRB_MAIL_API_AUTH_HEADER` | 可选，鉴权头名，默认 `authorization`；`authorization` 时值形如 `Bearer <token>`（RFC 7235），其它自定义头（如 `x-api-key`）直接发送裸 token |
| `DSH_CRB_SMTP_URL` | SMTP 连接串，如 `smtps://user:pass@smtp.example.com:465` |

HTTP 通道发出的 JSON 固定为 `{from, to: [收件人], subject, text, reply_to}`，`text` 是纯文本（不生成 HTML）；`reply_to` 取自表单里访客填写的邮箱（留空则不填）。SMTP 通道按需 `import('nodemailer')`：它已声明为 `optionalDependencies`（`^10.1.2`），正常安装会随包就位；以 `link:` 方式开发安装时插件从自身真实目录解析，需在**本仓库**跑一次 `npm install`。仍未安装时返回 `E_FEEDBACK_TRANSPORT` + `reason: nodemailer-missing`。

#### 9.3.1 QQ 邮箱开通示例

QQ 邮箱不能直接用登录密码发信，要先取**授权码**（设置 → 账号 → POP3/SMTP 服务 → 开启 → 生成授权码），再把两件事写进环境变量（`@` 在连接串里必须写成 `%40`；`<你的QQ号>` 换成实际号码）：

```powershell
setx DSH_CRB_SMTP_URL 'smtps://<你的QQ号>%40qq.com:你的授权码@smtp.qq.com:465'
# 可选：换收件人/发件人（不设就用包内默认的维护者收件箱）
setx DSH_CRB_FEEDBACK_TO 'your-feedback@example.com'
# 设置后重启 DSH 桌面端（setx 只对新进程生效）
```

需要自己生成一个 `b64:` 地址（放进 profile patch 而不是环境变量时）：

```powershell
node -e "console.log('b64:' + Buffer.from('your-feedback@example.com','utf8').toString('base64'))"
```


### 9.4 本地验证

```powershell
cd D:\Users\34332\AI\dsh-conversation-recycle-bin
npm run check                      # 语法 + manifest（含 feedback.js）
node test/feedback.test.mjs        # 19 个反馈用例
npm test                           # 全量 131 个用例

# 端到端：用本机收件桩观察真实投递路径，不外发邮件
$env:DSH_CRB_MAIL_API_URL   = 'http://127.0.0.1:9099/emails'
$env:DSH_CRB_MAIL_API_TOKEN = 'dev-token'
$env:DSH_CRB_FEEDBACK_TO    = 'feedback@example.test'
# 另一个终端起桩：
# node -e "require('http').createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{console.log(q.method,q.url,b);s.end('{}')})}).listen(9099)"
```

起桩后打开设置页点「反馈」，填表发送：桩终端应打印 `POST /emails {...}`，页面出现「反馈已发送，谢谢！」。测 SMTP 通路时改设 `DSH_CRB_SMTP_URL`（本仓库已按 `optionalDependencies` 声明 `nodemailer`，先在本仓库 `npm install` 一次；未安装时返回 `E_FEEDBACK_TRANSPORT` + `reason: nodemailer-missing`，这是预期行为）。

### 9.5 失败排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 设置页没有「反馈」按钮 | 通道未配置（`/state.feedback.enabled === false`） | 设好 `DSH_CRB_MAIL_API_URL` + token，或 `DSH_CRB_SMTP_URL`；确认 `feedback.transport` 不是 `off`、`enabled` 不是 `false` |
| 点击后 503 `E_FEEDBACK_DISABLED` | 同上一行（按钮来自旧页面渲染） | 刷新页面；看 `/state.feedback.reason`：`not-configured` / `disabled` / `off` |
| 400 `E_FEEDBACK_INVALID` | 标题 4–120 字、正文 10–4000 字、邮箱 ≤200 字且必须形如 `a@b.cc` | `details.field` 指明字段，`details.min`/`details.max` 给出边界 |
| 429 `E_FEEDBACK_RATE_LIMITED` | 超过 `feedback.rateLimitPerHour` | 等 `details.retryAfterMs` 后重试，或调高上限 |
| 502 `E_FEEDBACK_TRANSPORT` | 邮件服务返回非 2xx / 网络失败 / 未装 nodemailer / 暴露不出 `createTransport` | 看宿主日志 `[conversation-recycle-bin] feedback delivery failed (<transport>): <code> <message>`（只含错误码与通道，不含正文）；核对 URL、token、SMTP 授权码 |
| 邮件里「发件人」不是访客的邮箱 | 默认只把访客邮箱放进 `Reply-To`（`visitorAsFrom: false`），发信人仍是发信账号 | QQ/163/Gmail 必须如此（From 必须等于登录账号）；换用允许任意发件人的中继后再把 `feedback.visitorAsFrom` 设为 `true` |
| 接口 200 但收件箱没有 | 服务端已受理，但被对方退信或进了垃圾箱 | 查发件账号退信；`feedback.from` 用与 SMTP 账号一致的地址，并检查收件人域名 |

> 隐私边界：邮件正文 = 用户输入 + 对话框里已展示的上下文；宿主日志只记错误码、通道与耗时。删除开关（`enabled`）与反馈通道互相独立——关掉删除不影响反馈，反之亦然。
