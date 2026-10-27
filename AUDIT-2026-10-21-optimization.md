# 插件优化复核（2026-10-21）

范围：`dsh-conversation-recycle-bin` 工作区当前代码（`package.json` 0.3.4 + 未提交改动）。
目标：找出**可优化项**（缺陷、性能、可维护性），不改产品代码。前几轮 `AUDIT-2026-10-2x` 已确认/已证伪的条目不再重复。

## 0. 结论速览

| 编号 | 级别 | 类型 | 一句话结论 |
|---|---|---|---|
| O-01 | **P0 阻塞** | 测试 | `npm test` 红灯：新增的锁预算用例删除了未 seed 的 `S3`，`preview.confirmation` 为 `null` |
| O-02 | P1 | 正确性 | `enabled: false` 把「恢复/彻底删除/清理」也一起禁了，回收站里的数据无法通过 UI 取回 |
| O-03 | P1 | 一致性 | 恢复/彻底删除成功后若审计写入失败，会返回 500 并留下 `restoring` 条目（数据其实已恢复） |
| O-04 | P2 | UX | 批量选择器只补前 80 行标题；旧缓存缺失时第 81 行起显示裸 session id |
| O-05 | P2 | 性能 | `/trash` 对每个条目读两遍 manifest（`listAll` + `scanUnreadable`） |
| O-06 | P2 | 性能 | 每次 `/preview` 至少完整读 2 次记忆索引（probe + count） |
| O-07 | P2 | 性能 | `inspect()` 每会话调用一次 `registry.list()`（N+1），50 项批量 ≈ 51 次 |
| O-08 | P2 | 性能 | 设置页挂载/每次变更都并发拉 4 个接口并全量重渲染 |
| O-09 | P2 | 性能 | `t()` 每次调用都重读一次 locale 快照（单次渲染 100+ 次） |
| O-10 | P3 | 文档 | README 状态仍写 0.2.2、用例数仍写 131（实际 134） |
| O-11 | P3 | 配置 | `trashRetentionDays` 既不展示也不执行，schema 却写「shown in the recycle bin」 |
| O-12 | P3 | 死代码 | `writeJsonAtomic` / `ok()` / `defaultConfig()` / `workspaceState` 无引用；`restored` 状态永不写入 |
| O-13 | P3 | 发布 | `files` 只带 2026-10-17 的旧审计文档，仓库里另有 4 份；README 等本就会被 npm 自动带上 |
| O-14 | P3 | 工程 | 无 CI、无 lint；`npm test` 串行 `&&`，单文件 96s（其中一个锁用例 33s） |
| O-15 | P3 | 兼容 | `engines: >=20`，但 `readdir({recursive:true})` 需要 20.1+ |
| O-16 | P3 | 工程 | `check-syntax.mjs` 缺尾换行；`test/.tmp` 会残留 fixture 目录 |
| O-17 | P4 | 加固 | `/preview` 回传 `workspace.path`（客户端不用） |
| O-18 | P4 | 加固 | `discard` 在校验 `trashId` 前先探测路径，非法 id 变成 500 而非 400 |
| O-19 | P4 | 健壮性 | `gateway.loadList()` 无兜底；`lifecycle.quiesce` 的 `ctx.get` 未包 try/catch |
| O-20 | P4 | UI | `defaultMode` 晚到不生效；对话框无焦点陷阱 |

## 1. 验证方式

| 检查 | 结果 |
|---|---|
| `npm test`（8 文件链式） | 前 7 个文件通过；`test/api.test.mjs` **40 项 39 过 1 挂**，`exit=1`，耗时 96s |
| `npm run check` | 9/9 通过（含未提交的 `check-syntax.mjs` 退出码修复） |
| 一次性探针（已删除） | ① `preview(S3)` → `blocked=[E_NOT_FOUND]`、`confirmation=null`；② `enabled=false` 时 `restore` → `503 E_DISABLED`；③ `countForSessions` 读 `_index.json` 2 次；④ 5 次 `inspect` 调 `registry.list()` 6 次 |
| `npm pack --dry-run` | 143,622 B / 35 文件；只含 `AUDIT-2026-10-17-desktop-web.md` 一份审计 |

## 2. P0：测试红灯（O-01）

**位置**：`test/api.test.mjs:1055`、`:1082`；`makeFixture` 默认 `sessionIds = [S1, S2, ORPHAN]`（`:44`）。

新增用例「trash mutations ask the file lock for the long batch budget…」用默认 fixture，却执行 `deleteOne(S3, 'soft')`。`S3` 既没有 seed 日志，也不在 `sessionController.list()` 的返回里，`gateway.inspect(S3)` 返回 `null`，`/preview` 把它记入 `blocked`，因此 `confirmation` 为 `null`，用例在 `preview.body.preview.confirmation.token` 处抛 `TypeError`。

**修复**：给该 fixture 显式 seed `S3`：

```js
const fixture = await makeFixture({ mutationLock, sessionIds: [S1, S2, S3] })
```

`S3` 已在 `ws-2` 的 `sessionIds` 里，seed 后策略与日志都在。改完该文件应为 40/40；全量应为 134/134。

> 说明：这不是产品代码缺陷，但当前工作树不能发布——任何 `npm test` 都会红。

## 3. P1/P2：恢复路径、审计语义与选择器标题

### O-02 `enabled: false` 连恢复一起禁用

**位置**：`lib/host/api.js:961`

```js
if (!config.enabled && path !== '/feedback') throw new DeleteError('E_DISABLED', …)
```

这条闸在路由分发之前，所以 `/trash/restore`、`/trash/purge`、`/trash/discard` 与 `/delete` 一起被 503。实测（探针 B）：先正常软删除，再用 `enabled:false` 的实例调用 restore，得到 `503 E_DISABLED`。

问题在于：

- 设置页仍然注册并展示回收站与「恢复」按钮（`SettingsSection` 无条件注册），按钮必然失败；
- `enabled` 的语义是「禁止删除」，但已删除数据的**取回**也被禁止，等于把用户锁在门外；
- `/feedback` 已经被单独豁免，说明「不是所有路由都该被这个开关关掉」是既有设计。

**建议**：把开关收窄到「产生删除」的入口（`/preview`、`/delete`），恢复/清理继续可用；若确实要全禁，至少同步隐藏设置页的回收站操作并在 README 写明「禁用后无法恢复」。

### O-03 恢复/彻底删除的审计失败语义不一致

**位置**：`lib/core/cascade.js:374-386`（restore）、`:488-500`（purge）、`:549-563`（discard）

- 删除：审计是事务的最后一步，写失败 → 回滚整笔删除。这是刻意的（README「不可追溯」）。
- discard：审计 `.catch(() => {})`，失败不影响结果。
- restore：先 `await audit.append(...)`，**再** `trash.remove(...)`。审计抛错时，数据已恢复、条目仍是 `restoring`，接口返回 500。
- purge：`trash.remove` 是事务步骤，成功后 `await audit.append(...)`。审计抛错时，条目已经没了，接口仍返回 500。

结果：磁盘/回收站状态与 HTTP 结果相反，用户看到「失败」但操作已完成（purge），或看到「失败」且回收站多出一条永远不会自愈的 `restoring` 条目（restore）。概率低（磁盘满/权限），但属于「报告与事实不符」。

**建议**：恢复类操作的终态审计改为 best-effort，并在响应里带 `auditWarning: true`（或至少记日志后返回成功）；restore 的 `trash.remove` 应在审计失败时仍然执行。

### O-04 批量选择器标题只补前 80 行

**位置**：`lib/host/gateway.js:272`（`enrichTitles(sessions, limit = 80)`）、`lib/host/api.js:806`（未传 limit）

`loadList()` 的标题来自根级 `storages/session_projcache.json`（README 自己标注为「旧版残留」）。该文件缺失或过期时，`enrichTitles` 是唯一的标题来源，而它只处理前 80 行。按 README 记录的本机规模（92 个会话），第 81–92 行会显示 `session-…` 而不是标题。

**建议**：去掉硬上限，改为有界并发（如 8 个一批）遍历全部行；或在 UI 对空标题显示 cwd 尾部，避免裸 id。

## 4. P2：性能

### O-05 `/trash` 双扫描 manifest

**位置**：`lib/host/api.js:860`、`lib/core/trash.js:106-117`、`:133-162`

`trashList()` 并行调用 `listAll()` 与 `scanUnreadable()`，两者各自 `readdir` 一次，并对**每个**目录 `readFile(manifest)` 一次（`scanUnreadable` 对可读 manifest 也要读一遍才能判定可读）。N 个条目 = 2 次 readdir + 2N 次 readFile，且 `listAll` 内部是串行 `for … await`。

**建议**：合并成一次扫描，返回 `{entries, unreadable}`；读取用 `Promise.all` + 小并发上限。1.5s TTL 缓存可以保留。

### O-06 每次预览读两遍记忆索引

**位置**：`lib/core/memory/registry.js:64`（`availablePairs → status(true)`）、`:86`（`countSessions`）；`lib/core/memory/json-index-adapter.js:240-251`、`:258-275`

探针实测：一次 `countForSessions` 对 `_index.json` 执行 **2 次** `readFile` + `JSON.parse`（`probe()` 一次，`countSessions()` 一次）。索引是整份 JSON，节点多时这两次解析都在预览的关键路径上；`/state` 还会再探一次（3s 缓存）。

**建议**：一次请求内复用同一份 `{index, nodes, sig}`（或让 `probe()` 返回已解析快照）；把 probe 结果的缓存从「仅 status」扩展到 `availablePairs`。

### O-07 `inspect()` 的 N+1 注册表调用

**位置**：`lib/host/gateway.js:205-216`（`workspaceFor → workspaceEntities → registry.list()`）、`:238`

探针实测：5 次 `inspect` 触发 **6 次** `registry.list()`（`loadList` 1 次 + 每会话 1 次）。`preview` 与 `deletePlan` 都对每个 id 调一次 `inspect`，50 项批量 ≈ 51 次 `list()`。

**建议**：在 gateway 内按 1.5s TTL 缓存 `workspaceEntities()`（与 `listCache` 同寿命），或在 `preview/deletePlan` 里先取一次 workspaces 传下去。

### O-08 设置页每次挂载/变更拉 4 个接口

**位置**：`client.js:1571-1602`（`refresh`）、`:1604`（挂载）、`:1608`（变更广播）

一次 `refresh` 并发 `/state`、`/sessions`、`/trash`、`/audit`。其中 `/sessions` 会触发最多 80 次投影文件读取；每次 restore/purge/discard 后都会再跑一遍，并且 `setLoading(true)` 会把三个 tab 面板整体卸载再挂载（闪烁）。

**建议**：按 tab 懒加载（trash 只需要 `/trash`；batch 才需要 `/sessions`；audit 才需要 `/audit`）；变更后只失效相关切片；刷新时保留旧数据，用局部 spinner 代替整块 `loading`。

### O-09 每个字符串都重读 locale 快照

**位置**：`client.js:413-421`（`t`）、`:390-407`（`currentLocaleId`）

`t()` 每次调用都走 `currentLocaleId()` → `locale.getSnapshot()`。一次设置页渲染有 100+ 个 `t()`，即 100+ 次 `getSnapshot()`。虽然开销小，但完全可省。

**建议**：在 `useLocaleTick` 里把 locale id 存进 state，`t` 读取该值；或按渲染批次 memo 一次。

## 5. P3：文档、配置与工程

### O-10 README 过期

- `README.md:5`：「状态：`0.2.2`」，实际 `package.json` 0.3.4；
- `README.md:193/202/291`：「131 个用例」，实际 **134**（40 api + 15 cascade + 21 client + 14 core + 19 feedback + 9 manifest + 12 memory + 4 trash-audit）；
- `CHANGELOG.md` 0.3.4 的「131 全绿」在当次提交时正确，但工作树又加了 3 个用例，发布前需同步。

### O-11 `trashRetentionDays` 是死配置

`config.js:32/208` 定义并归一化，`api.js:573/796` 回传，`client.js` **没有任何引用**；也没有任何定时清理逻辑。`config.schema.json:26` 却写「Informational retention shown in the recycle bin」——既不展示也不执行。

**建议**：三选一——在回收站标题旁展示「保留 N 天」、实现到期自动清理（需谨慎，回收站是安全网）、或从配置/state/schema 中删除。

### O-12 死代码与死状态

| 符号 | 位置 | 状态 |
|---|---|---|
| `writeJsonAtomic` | `lib/host/paths.js:143` | 无任何引用（含测试） |
| `ok()` | `lib/core/errors.js:88` | 无引用 |
| `defaultConfig()` | `lib/core/config.js:266` | 无引用 |
| `workspaceState` | `lib/host/gateway.js:219` | 无引用 |
| `'restored'` | `lib/core/trash.js:24`、`cascade.js:408` | 状态机允许，但**没有任何代码写入**；`performPurge` 对它的分支永远走不到 |
| `trash.list()` | `lib/core/trash.js:120` | 仅测试使用，生产走 `listAll()` |

清理不会改变行为，但能减少「以为有这条路径」的误读。

### O-13 发布产物与仓库文档

`package.json:23-34` 的 `files` 只列了 `AUDIT-2026-10-17-desktop-web.md`（39KB，已过期），仓库里另有 4 份更新的审计；`README/INSTALL/CHANGELOG/LICENSE` 本来就会被 npm 自动包含，无需列出。

**建议**：把审计文档移到 `docs/audit/`（或干脆不发布），`files` 只保留 `lib`、`client.js`、`cordis.patch.yml`、`config.schema.json`、`icon.svg`。tarball 会更小，也不会让安装者读到旧结论。

### O-14 无 CI / 无 lint / 测试串行

- 仓库没有 `.github/workflows`，也没有 eslint/prettier 配置；
- `npm test` 是 8 条 `node … && node …` 串联，任一文件失败后面的文件不跑；本次 96s，其中一个锁用例固定等 33s（既有审计 R-4 已提到）。

**建议**：改用 `node --test "test/*.test.mjs"`（Node 20+ 自带，文件级并行、单份 TAP 汇总），并加一个最小 CI（`npm run check` + `npm test`）。锁用例的等待时间用注入的 `timeoutMs` 缩短。

### O-15 `engines` 与 API 版本

`package.json:36` 写 `"node": ">=20"`，但 `lib/host/api.js:366` 使用 `readdir(target, { recursive: true })`——该选项 Node **20.1.0** 才加入。20.0.x 会直接抛 `ERR_INVALID_ARG_VALUE`。改成 `>=20.9`（或 `>=20.1`）更准确。

### O-16 小项

- `scripts/check-syntax.mjs` 末尾缺换行（`git diff` 的 `\ No newline at end of file`）；
- `test/.tmp/` 会残留 fixture 目录（已 gitignore，但 `rm` 在 Windows 上偶发 EBUSY，建议 cleanup 里加大 `maxRetries` 或失败后打印路径）。

## 6. P4：加固与一致性

### O-17 `/preview` 回传了 `workspace.path`

`lib/host/api.js:528` 直接返回 `session.workspace`（`{id,title,path,index}`），其中 `path` 是绝对路径；客户端从未读取它（只在批量行显示 `cwd`）。`sessionsForUi()` 已经把它裁成 `{id}`，两处不一致；模块头也声称「Client 只收 id 与计数，不收文件系统句柄」。建议同样裁成 `{id}`。

### O-18 `discard` 在校验 `trashId` 前先探测路径

`lib/host/api.js:755`：

```js
const dir = join(paths.trashDir, trashId)
if (!(await ops.pathExists(dir))) …
```

`trash.read()` 对非法 id 早退为 `null`，随后这里用未校验的 `trashId` 拼路径做存在性探测；`performDiscard` 里的 `trash.entryDir()` 会抛普通 `Error`，最终变成 500 而不是 400。**不会造成越界删除**（前轮审计 4.5 的结论仍成立），但建议在 API 边界先用 `isTrashId()` 拒绝，错误码更准确。

### O-19 两个探针缺兜底

- `lib/host/gateway.js:110`：`controller.list({}, AbortSignal.timeout(5_000))` 没有 try/catch，`/sessions` 与每次 `/preview` 都会走 `loadList()`，宿主列表一旦超时/抛错就是 500。另外第二个位置参数是否被宿主识别为 signal，代码里没有兜底，建议核对宿主签名或改成 `{ signal }`。
- `lib/host/lifecycle.js:58`：`ctx.get?.('sessionController') ?? ctx.sessionController` 未包 try/catch，而同文件 `service()` 与 gateway/catalog 的同类探针都包了。

### O-20 UI 细节

- `client.js:968`：`mode` 的初值只读一次 `flags.defaultMode`；若 `/state` 在对话框挂载后才返回，`defaultMode: 'hard'` 不会生效。可加一个「仅在用户未改过 mode 时应用一次」的 effect。
- 两个 dialog 有 `role="dialog"` / `aria-modal`，但没有焦点陷阱与关闭后的焦点归还；键盘用户 Tab 会跑到背景。属于 a11y 完善项。

## 7. 建议实施顺序

1. **O-01**（一行 fixture 参数）——先让 `npm test` 回绿；
2. **O-02**（恢复路径）与 **O-03**（审计语义）——数据安全相关；
3. **O-05 / O-06 / O-07**——三个热点都在删除/预览主路径上，改动局部、收益可测；
4. **O-10 / O-11 / O-12 / O-13**——发布前一次性清理，避免文档与实现继续漂移；
5. **O-08 / O-04 / O-14**——体验与工程效率；
6. **O-15 ～ O-20**——随手项。

## 8. 未纳入的项

- 前几轮已证伪的候选（路由 401、`auditSource`、前缀尾斜杠、`planTimeoutMs`、trash id 穿越、PowerShell 乱码、Slot 名、client 资源 404）未重复上报；
- 本轮未在真实桌面/网页端做点击级 E2E，O-02/O-03 的结论来自路由与 cascade 的代码路径 + 探针；
- 未评估宿主 `webServer` 的请求超时上限（Node 默认 `requestTimeout` 只约束请求体，不约束响应耗时），因此 900s 批量预算是否需要与宿主对齐，建议在实机大批量时观察。
