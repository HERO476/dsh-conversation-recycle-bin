# 桌面端 / 网页端缺陷复核报告（2026-10-21）

- 被审对象：`dsh-conversation-recycle-bin` **v0.3.3**（`D:\Users\34332\AI\dsh-conversation-recycle-bin`），git HEAD `816fbcc`，工作区干净。
- 对照运行时：DSH `0.2.1-rc.2`；网页端 Host 在线（本轮探测到 `http://127.0.0.1:8080`、`http://127.0.0.1:3664` 两个实例）；桌面端 `DeepSeek Harness` 已安装于 `C:\Users\34332\AppData\Local\Programs\DeepSeek Harness`（Electron 44.7.0），本轮**未运行**。
- 两端装载状态（实机读取）：
  - `C:\Users\34332\.dsh\profiles\web\package.json` → `"dsh-conversation-recycle-bin": "link:D:/Users/34332/AI/dsh-conversation-recycle-bin"`，且 `dsh.profile.bundles` 含该 id。
  - `C:\Users\34332\.dsh\profiles\desktop\package.json` → 同上（同样的 link）。
  - 即两端共用同一份 0.3.3 源码，不存在版本漂移。
- 本报告**只列本轮新发现或本轮确认仍未修复的缺陷**。`AUDIT-2026-10-17-desktop-web.md`、`AUDIT-2026-10-19-desktop-web-recheck.md`、`AUDIT-2026-10-19-review.md` 中的 W-01…W-07 / S1–S3 / P1–P5 / R1–R4 已修复项不再重复。

## 0. 结论速览

| 编号 | 端 | 严重度 | 结论 | 证据等级 |
|---|---|---|---|---|
| B-01 | 网页端 | 中 | 前缀部署（`--public-url https://host/ui/`）下**全部** API 请求丢失 `/ui` 前缀，整个插件失效 | 最小用例实证 |
| B-02 | 两端 | 中 | 回收站三个写操作（restore / purge / discard）客户端 15s 超时，短于宿主自身的排队与锁等待；批次删除进行中必然"报错但实际执行成功"（purge 不可逆） | 代码走读 + 常量实证 |
| B-03 | 两端 | 低 | `scripts/check-syntax.mjs` 把子进程启动失败误报为"26 个文件语法错误" | 最小用例实证（可复现/可消失） |

已证伪、**不应**再当作缺陷上报的项见第 4 节（共 8 条）。  
未复现、仅作风险提示的项见第 5 节。

## 1. 方法与证据等级

| 等级 | 含义 |
|---|---|
| 实机探测 | 对运行中的 Host / 安装产物直接发请求或读取 |
| 最小用例实证 | 抽出相关代码片段在隔离环境执行，得到确定输出 |
| 代码走读 | 依据源码与常量推导，含跨端对照 |
| 测试运行 | `npm test` / `npm run check` 实际执行结果 |

本轮执行：

```
npm test         → 8 个测试文件全绿，最后一个 api.test.mjs： tests 39 / pass 39 / fail 0 / duration_ms 45415.50，退出码 0
npm run check    → 9/9 pass，退出码 0（danger-full-access 下）
```

> 说明：`npm run check` 在受限沙箱（workspace-write）下会失败，原因见 B-03；在无限制环境下**通过**。因此 B-03 是脚本的健壮性缺陷，不是产品功能缺陷。

## 2. 环境矩阵

| 项 | 桌面端 | 网页端 |
|---|---|---|
| 入口 origin | `dsh-app://app` | `http://127.0.0.1:<port>`（默认 8080） |
| 前端资源 | asar 内 `dsh-web-frontend/dist`，经 `protocol.handle` 提供 | Host 静态服务 |
| 接口传输 | `forwardWebRequest()` 转发到本地 Host | 直连 Host |
| 鉴权 | 壳注入 Cookie | 连接层 browserPeer / token URL |
| `document.baseURI` | `dsh-app://app/` | `http://127.0.0.1:<port>/` 或前缀部署时的 `https://host/<prefix>/` |
| 插件路由 | 前缀路由 `/conversation-recycle-bin/api` | 同左 |
| 本轮实测 | 未启动，无法端到端执行 | 401（见 4.1，属预期） |

## 3. 已证实缺陷

### B-01 网页端 · 前缀部署下所有 API 请求丢失路径前缀（中）

**位置**
- `client.js:472` `const API_PREFIX = '/conversation-recycle-bin/api'`
- `client.js:502-503`
  ```js
  const base = typeof document !== 'undefined' && typeof document.baseURI === 'string' ? document.baseURI : 'http://127.0.0.1/'
  const url = new URL(`${API_PREFIX}${path}`, base)
  ```

**最小用例实证**（`node` 直跑，片段与源码一致）

```
web root         => http://127.0.0.1:8080/conversation-recycle-bin/api/state
web /ui prefix   => https://app.example/conversation-recycle-bin/api/state   ← /ui 被丢弃
desktop shell    => dsh-app://app/conversation-recycle-bin/api/state
```

`API_PREFIX` 以 `/` 开头，按 RFC 3986 属于"绝对路径引用"，`new URL()` 会用它替换 base 的整个 path，前缀因此丢失。

**为什么这是缺陷而不是风格问题**

DSH 官方前端的约定是"document-relative（文档相对）"：

1. `@deepseek-ai/dsh-web-frontend/dist/index.html` 全部资源用相对路径：`./manifest.webmanifest`、`./favicon.svg`、`./assets/index-*.js`、`./assets/index-*.css`，因此前端本身就是按"可挂在任意前缀下"构建的。
2. `@deepseek-ai/dsh-client-connection/lib/client.browser.js` 构造请求时**主动去掉前导斜杠**以保持文档相对：
   - HTTP：`send(\`${channel}/${endpoint}\`.slice(1), { method: 'POST', ... })`
   - WebSocket：`const url = new URL(path.slice(1), base)`
3. `@deepseek-ai/dsh-client-modules/lib/index.js` 明确注释："app-owned browser routes are document-relative, so the route key's leading slash is stripped here"（对应架构笔记 `2026-09-14-web-document-relative-app-routes.md`）。
4. `@deepseek-ai/dsh-web-app/lib/index.js` 的 `--public-url` 语义：`parsePublicUrl()` 要求绝对 http(s) URL 并把 pathname 规范化为以 `/` 结尾；帮助文本说明它是"advertise this HTTP(S) root"，即**Host 侧不做路径重写**（`appRootUrl = () => publicUrl ?? ctx.webServer.getOrigin()`），前缀由外层反向代理剥离。

**影响**：一旦以 `dsh web --public-url https://host/ui/` 部署，插件发出的 4 类请求（`/state`、`/preview`、`/delete`、`/trash/*`、`/audit`、`/feedback`）全部落到 `https://host/conversation-recycle-bin/api/...`，被代理判定为非应用路径而 404。表现为：菜单项在（客户端模块加载正常），但点击后弹窗一直报错，功能整体不可用。**桌面端不受影响**（base 为 `dsh-app://app/`，`new URL` 结果正确，且壳的转发器对非静态路径全量转发）。

**修复建议**：保持文档相对，与 DSH 自身一致。

```js
// client.js:502 附近
const base = typeof document !== 'undefined' && typeof document.baseURI === 'string'
  ? new URL('.', document.baseURI).href   // 归一化为目录式 base，避免 base 无尾斜杠时解析错误
  : 'http://127.0.0.1/'
const url = new URL(`${API_PREFIX.replace(/^\//, '')}${path}`, base)
```

或更稳妥地一次性算出基址：`const API_BASE = new URL(\`${API_PREFIX.replace(/^\//,'')}/\`, new URL('.', base))`。

### B-02 两端 · 回收站三个写操作客户端超时短于宿主排队时间（中）

**位置**
- 客户端：`client.js:1581`（restore）、`1604`（restoreIncomplete）、`1627`（purge）、`1650`（discard）均只传 `{ method: 'POST', body: ... }`，**没有 `timeoutMs`**，因此落到默认值 `REQUEST_TIMEOUT_MS = 15_000`（`client.js:473`）。
- 宿主：`lib/host/api.js:988-1000`
  ```js
  if (path === '/trash/restore') { const result = await serialize(() => restoreEntry(body?.trashId)) ... }
  if (path === '/trash/purge')   { const result = await serialize(() => purgeEntry(body?.trashId, body?.confirmPhrase)) ... }
  if (path === '/trash/discard') { const result = await serialize(() => discardEntry(body?.trashId, body?.confirmPhrase)) ... }
  ```
  三处都**没有**传 `lockTimeoutMs`，于是走共享锁实例的默认值 `timeoutMs: 30_000`（`lib/host/api.js:330-334`）。
- 对照已修复路径：`/delete` 在 `lib/host/api.js:979-980` 显式算出 `lockBudget = Math.min(900_000, 15_000 + batchCount * 16_000 + batchCount * config.liveDrainMs)`，客户端在 `client.js:1019-1024` 读取 `preview.limits.planTimeoutMs` 后传入。**只有 `/delete` 做了这件事。**

**放大器**：`serialize()`（`lib/host/api.js:382-404`）先在进程内 `mutationChain.then(...)` 排队，再获取跨进程锁。也就是说一个 restore 请求的等待时间 = **前面那个删除批次的全部执行时间** + 锁获取时间。50 个会话的批次按宿主预算可达 `15_000 + 50*16_000 + 50*2_000 = 915s`（被 `Math.min` 截到 900s）。而客户端在 15s 就 AbortController 中止并抛 `E_TIMEOUT`（`client.js:532`，"The Host did not answer in time."）。

**后果**：批次删除进行中，用户在回收站点"恢复"或"彻底删除"，界面必然弹出超时错误，但宿主仍在后台把它执行完。`purge` 不可逆——用户看到失败会更谨慎，但 `discard` / `restore` 也都会"报错却已完成"，刷新后状态与错误提示矛盾。这属于数据操作反馈错误，不只是体验问题。

**修复建议**（任选其一，推荐 1）

1. 客户端给这三个请求传显式预算，并让宿主一并接受 `lockTimeoutMs`：
   ```js
   await api('/trash/restore', { method: 'POST', body: { trashId }, timeoutMs: 180_000 })
   ```
   宿主侧在三个 `serialize()` 调用处补 `{ lockTimeoutMs: <同 delete 的预算算法或固定 180_000> }`。
2. 把 `serialize` 在进程内排队阶段的耗时也算进预算，并在等待超过某阈值时先返回 `202 + requestId` 走轮询（改动较大）。
3. 至少在客户端把回收站写操作的默认超时提到与锁预算同量级（30s 以上），使"客户端先放弃"不再成为默认结果。

### B-03 两端（工具链）· `check-syntax.mjs` 把 spawn 失败误报为语法错误（低）

**位置**：`scripts/check-syntax.mjs:23-26`
```js
const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
if (result.status !== 0) { console.error(`SYNTAX FAIL ${file}\n${result.stderr ?? result.stdout}`) }
```

**实证**：
- 受限沙箱下（本会话早期为 workspace-write）：退出码 1，逐文件打印 `SYNTAX FAIL lib\core\audit.js` … `SYNTAX FAIL client.js`，每条后面只有一个字面量 `undefined`。用同样的 `spawnSync` 打印返回值得到 `{"status":null,"err":"EPERM"}` —— 子进程根本没起来（受限环境下管道 stdio 被禁）。
- 同一批文件直接 `node --check lib/core/ids.js` → 退出码 0，说明文件本身没有语法错误。
- 换成 `{ stdio: ['ignore', fdOut, fdErr] }`（文件描述符而非管道）→ `status: 0`，正常通过。
- 在 danger-full-access 下重跑 `npm run check` → **9/9 pass，退出码 0**。

**缺陷实质**：脚本从不检查 `result.error`；当 `status === null` 且 `stderr`/`stdout` 均未定义时，它把"无法启动解析器"报告成"N 个文件语法错误"，且丢掉了真正的错误信息（打印 `undefined`）。这会让开发者在受限环境/CI 里误判为代码损坏，浪费排查时间。

**修复建议**：
```js
if (result.error) {
  console.error(`CHECK UNAVAILABLE ${file}: ${result.error.code ?? result.error.message}`)
  process.exitCode = 2   // 与"语法错误"区分
  continue
}
if (result.status !== 0) { console.error(`SYNTAX FAIL ${file}\n${result.stderr ?? result.stdout}`); failed = true }
```
或者干脆改成进程内解析（`new (await import('node:vm')).SourceTextModule` / `node --check` 的等价 API），彻底不依赖子进程。

## 4. 已证伪的候选（**请勿**作为 bug 上报）

这些是本轮以及前几轮排查中提出、随后被证据否定的条目。保留在此以避免下一轮重复误报。

| # | 曾经的怀疑 | 结论与证据 |
|---|---|---|
| 4.1 | 网页端插件路由返回 401，是不是路由没挂上 | **否，属预期。** `lib/host/api.js:1020-1051` 主动接入 `connection.requestRejection()`：`{"ok":false,"error":{"code":"E_UNAUTHORIZED","message":"This request is not authenticated with the Host."}}` 这个字符串只存在于插件自身与测试中（DSH 全部包内零命中），证明请求**已进入插件 handler**；401 来自连接层鉴权（浏览器需带 `dsh web` 打印的认证 URL 的 cookie/token）。不带凭据的 curl 必然 401。 |
| 4.2 | 桌面端 `auditSource` 恒为 `web-ui`（`process.versions.electron` 在纯 Node 子进程里为 undefined） | **否。** 桌面 Host 是以 Electron 二进制在 Node 模式启动的：壳内 `desktopNodeEnvironment()` 注入 `ELECTRON_RUN_AS_NODE: "1"`、`DSH_DESKTOP_NODE_EXECUTABLE`，启动参数为 `--no-open --host 127.0.0.1 --port 0`。实测该模式下 `process.versions` = `{"electron":"43.3.0","node":"24.18.1"}`，故 `lib/host/api.js:337` 的判定成立，审计会记录 `desktop-ui`（`test/api.test.mjs` 亦有 "audit: the source records which shell asked" 覆盖）。 |
| 4.3 | 前缀路由必须带尾斜杠才能匹配 | **否。** `dsh-host-webserver` 的 `match()` 为 `if (pathname !== prefix && !pathname.startsWith(\`${prefix}/\`)) continue`，`pathname === prefix` 时首条件为假，仍会匹配；实机 `GET /conversation-recycle-bin/api` 返回 401 JSON 亦可佐证。 |
| 4.4 | 客户端不读 `limits.planTimeoutMs`，大批次会被客户端先掐断 | **否。** `client.js:1019-1021` 正是 `Number.isFinite(preview?.limits?.planTimeoutMs) ? Math.max(1_000, preview.limits.planTimeoutMs) : mutationTimeoutMs(...)`，并在 `client.js:1024` 传入。`/delete` 路径已修复。（**但**同一 bug 类在 `/trash/*` 仍未修，见 B-02。） |
| 4.5 | 回收站 id 可路径穿越 | **否。** `lib/core/trash.js:21` `TRASH_ID_PATTERN = /^[0-9a-z]{2,40}-[0-9a-z]{2,20}$/`，`isTrashId` 守卫 `entryDir()`，`read()` 早退。 |
| 4.6 | `package.json` 中文 description 乱码 | **否。** 文件无 BOM、合法 UTF-8；乱码来自 PowerShell 控制台代码页。用 `read` 工具读正常。 |
| 4.7 | 四个 Slot 名或 `dsh.client.inject` 在 0.2.1-rc.2 里不存在 | **否。** 客户端 Slot 注册表实查：`shell.overlay`、`sidebar.workspaces.session.menu.item`、`conversation.session.header.actions`、`settings.section` 均存在，注册形状 `{id, order?, label?}` 一致；`inject` 的 6 个包在已安装 `dsh-client-*` 中全部存在。Host 侧 `webServer.register({kind:'prefix', path, handler})` 与 `WebRoute` 接口一致。 |
| 4.8 | `/plugins/dsh-conversation-recycle-bin/client.js` 返回 404 说明客户端包没发布 | **否。** 该路由按 `${pathname}${search}` 精确键查找（含 `?rev=`），无 `rev` 的裸探针必然 404；且 bundle 资源接口对非 GET/HEAD 返回 405。属预期。 |

## 5. 未复现风险与遗留观察

- **R-1（两端，部署相关，中）**：默认配置 `requireSameOrigin: true` + `allowNonLoopback: false` 下，`requestOriginVerdict()` 要求 `Host` 头是回环地址。若反向代理原样保留外部 Host 头（`app.example`），插件会以 `E_FORBIDDEN_HOST` 拒绝，而 DSH 自身对这类部署提供 `--trusted-host`。插件没有对应开关的自动感知，只能手工把 `allowNonLoopback` 改成 `true`。这既削弱了安全默认（用户为让功能可用会整体放开），也没有细粒度白名单。本轮无法在真实代理后复现。建议增加 `allowedHosts: string[]` 配置项。
- **R-2（桌面端，观察）**：本轮桌面应用未运行，桌面端所有结论来自对 `app.asar` 的走读（转发器、协议注册、Host 启动参数）与离线实测（`ELECTRON_RUN_AS_NODE` 下 `process.versions`），**没有**执行端到端点击验证。建议在有桌面实例时补做：新建会话 → 行菜单删除 → 确认 → 回收站恢复。
- **R-3（桌面端，非本插件）**：历史崩溃日志 `DesktopHostFatalError: cannot create effect on inactive context`（`INACTIVE_EFFECT`）栈帧全部位于 `app.asar/lib/main.js` 与 cordis `lib/index.js`，**无任何插件栈帧**；同批 startup 还跳过了若干与本插件无关的 profile bundle（版本 peer 不匹配）。不归因于本插件。
- **R-4（两端，性能）**：`test/api.test.mjs` 中 "mutation lock: a busy cross-process lock is E_LOCK_BUSY" 单条耗时 33s（真实等待锁超时）。测试正确但拖慢 CI；如非必要可将该用例的锁超时注入为更小值。

## 6. 修复清单（按优先级）

1. **B-01**：`client.js:496-538` 改为文档相对解析（见 3.1 补丁），并补一条测试：注入 `document.baseURI = 'https://host/ui/'` 断言请求 URL 含 `/ui/`。
2. **B-02**：`client.js:1581/1604/1627/1650` 传 `timeoutMs`；`lib/host/api.js:988/993/998` 三个 `serialize()` 补 `lockTimeoutMs`。补测试：删除批次占锁期间发起 restore，断言宿主预算 > 客户端预算。
3. **B-03**：`scripts/check-syntax.mjs` 检查 `result.error` 并以退出码 2 与语法错误区分。
4. **R-1**（可选）：新增 `allowedHosts` 配置，避免用户被迫把 `allowNonLoopback` 整体打开。

## 7. 回归验证记录（本轮）

| 命令 | 结果 |
|---|---|
| `npm test` | 8 文件全绿；末文件 `tests 39 / pass 39 / fail 0`，`duration_ms 45415.50`，退出码 0 |
| `npm run check`（danger-full-access） | 9/9 pass，退出码 0 |
| `npm run check`（workspace-write 沙箱） | 失败，逐文件 `SYNTAX FAIL` + `undefined` → 即 B-03 |
| 实机探测 `GET /conversation-recycle-bin/api/state` | 8080 → 401 JSON；3664 → 401 JSON（路由已挂载，鉴权门禁生效） |
| 两端 profile 装载 | web / desktop 均 `link:` 到工作区，`bundles` 均含插件 id |

## 8. 清理记录

本轮产生的临时文件已在收尾时删除：`%TEMP%\scan1.cjs`、`scan2.cjs`、`scan3.cjs`、`scanfe.js`、`urlproof.js`、`cb2.cjs`、`cb3.cjs`、`asar-header.json`，以及留给本会话的 DSH spill 文本（`%TEMP%\dsh-spill-*\session-*\*.txt`）。仓库内仅新增本报告文件，未改动任何产品代码。