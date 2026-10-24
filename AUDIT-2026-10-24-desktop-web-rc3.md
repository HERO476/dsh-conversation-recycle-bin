# 桌面端 / 网页端适配性复核报告（2026-10-24）

- 被审对象：`dsh-conversation-recycle-bin` **0.3.5**（`D:\Users\34332\AI\dsh-conversation-recycle-bin`），git HEAD `70377bd`，工作树未提交项只有审计临时目录。
- 对照运行时：
  - 桌面端：`@deepseek-ai/dsh-desktop` **0.2.1-rc.3**（安装于 `C:\Users\34332\AppData\Local\Programs\DeepSeek Harness`，`app.asar` mtime 2026-10-23 16:00）。
  - 网页端：浏览器访问的 Host 面 —— 采样时为 `http://127.0.0.1:14582`（Host PID 23148），会话结束后为 `http://127.0.0.1:1151`（Host PID 30040）。**两轮都是同一个 `dsh-desktop-host`，不是独立的 `dsh web` 进程**。
- 证据等级：**【实机探测】**=对运行中的 Host 实测；**【隔离实测】**=临时 `DSH_HOME` 跑插件真实路由/存储；**【制品读取】**=从 `app.asar` / npm 发布物读代码；**【代码走读】**=只读源码推断。

> 术语校正：本轮"桌面端"与"网页端"**不是两个进程**。桌面 App 起一个 `dsh-desktop-host`（默认绑回环随机端口），桌面渲染进程通过 `dsh-app://app/` 协议访问它；浏览器则直接访问同一个 Host 的 HTTP origin。因此两端共享同一套路由表、同一份 profile 与同一份插件代码，差异只在**传输路径**（外壳转发 vs 同源直连）。

---

## 0. 结论速览

**总体结论：适配。0 条阻断级问题；桌面端与网页端在 0.2.1-rc.3 上均已装载可用。** 本轮共核 27 条适配项（Host 12 + Client 15），全部通过；另记录 12 条"需注意"（无一是本轮 rc.2→rc.3 的回归）。

| 维度 | 桌面端（`dsh-app://app/`） | 网页端（`http://127.0.0.1:<port>/`） | 依据 |
|---|---|---|---|
| 版本 | ✅ 已装 = 桌面 nightly 最新 0.2.1-rc.3 | ✅ 同一 Host；npm `latest` = rc.2 / `next` = rc.3，两者插件都兼容 | §1 |
| 插件装载 | ✅ 路由已注册（401 而非 404） | ✅ 同路由表 | §3.1 |
| 鉴权后可用 | ✅ 经外壳 `forwardWebRequest` 带 Host cookie 转发 | ✅ 自签同款 cookie 实测 200 | §3.1 |
| HTTP 路由契约 | ✅ 不变 | ✅ 不变 | §4 |
| 4 个 UI 槽位 | ✅ 全部存在，props 形状未变 | ✅ 同源，同一套 client 包 | §5 |
| 客户端 bundle 下发 | ✅ combo URL 200（106,137 B） | ✅ 同一 `/plugins/??…&rev=…` 路由 200 | §3.1(c) |
| 三种 origin 下的 `apiUrl()` | ✅ `dsh-app://app/…`（协议注册 `supportFetchAPI:true`） | ✅ `http://127.0.0.1:<port>/…`，同源带 cookie | §5.3 |
| 删除链路（隔离 E2E） | — | ✅ 列/预览/软删/恢复/硬删/purge 全绿 | §3.2 |
| rc.2→rc.3 契约漂移 | ✅ 22 个 Host 包逐字节相同 | ✅ 10 个 client 包逐字节相同 | §6 |
| 今日 crash 日志相关性 | ✅ 无关（旧壳 rc.2，grep 本插件 0 命中） | ✅ 无关 | §3.3 |

---

## 1. 版本基线："最新版"有两个口径

| 口径 | 值 | 证据 |
|---|---|---|
| 桌面端最新（nightly 通道） | **0.2.1-rc.3**，`releaseDate: 2026-10-23T08:02:12.038Z`，安装包 `deepseek-harness-0.2.1-rc.3-win-x64.exe` | `https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml`（`latest.yml`、`latest-nightly.yml` 均 404，`app-update.yml` 里 `channel: nightly`） |
| 桌面端已装 | **0.2.1-rc.3**（= 最新） | `app.asar` 内 `@deepseek-ai/dsh-desktop` / `dsh-desktop-host` / `dsh` 的 `package.json` 版本；Electron 44.7.0 |
| npm `@deepseek-ai/dsh` `latest` | **0.2.1-rc.2** | `npm view @deepseek-ai/dsh dist-tags` |
| npm `next` / `alpha` | `0.2.1-rc.3` / `0.2.1-alpha.5` | 同上 |
| `@deepseek-ai/dsh-desktop` | **未发布到 npm**（404） | `npm view` |

**含义**：桌面端已经是本轮最新版；如果用户用 `dsh web`（装 `latest`）起独立网页端，会跑 **rc.2**——那正是上一轮 `AUDIT-2026-10-22-desktop-web-compat.md` 的基线，同样是兼容的。**两端口径都覆盖：rc.2（上一轮审计）+ rc.3（本轮审计）。**

---

## 2. 方法与证据分布

| 手段 | 覆盖 |
|---|---|
| 实机探测 | Host 端口/进程、插件前缀 401、自签 Host cookie 后 `/api/{state,sessions,trash,audit}` 200、`__DSH_BOOT__` 图、combo bundle 200、今日 crash 日志 |
| 隔离实测 | 临时 `DSH_HOME` + 插件真实 `createDeleteApi`（真路由/回收站/审计/记忆适配器）跑完整删除链路；`npm run check` |
| 制品读取 | `app.asar`（桌面外壳 `lib/main.js`、全部 `@deepseek-ai/*` 包）+ npm 发布物（`@deepseek-ai/dsh@0.2.1-rc.2/rc.3` 及其依赖包） |
| 代码走读 | 插件 `lib/**`、`client.js`、`package.json`、`cordis.patch.yml` 与 Host 各服务契约逐条对照 |

> **工具坑（复现须知）**：`app.asar` 数据区基址是 `16 + headerSize` **再按 4 字节向上取整**。少算这 1 字节会让每个文件读出「前一个文件最后 1 字节 + 真实内容少最后 1 字节」——JSON 因此缺 `}` 解析失败。本轮已修正读取器并全量重抽（305 个 `@deepseek-ai` 包、6190 文件、99.08 MB，`package.json` 校验 305/305 合法）。

---

## 3. 运行时实证

### 3.1 装载的四条正交证据【实机探测】

**(a) 401 而不是 404**

```
GET /conversation-recycle-bin/api/state            → 401  application/json
     {"ok":false,"error":{"code":"E_UNAUTHORIZED","message":"This request is not authenticated with the Host.","details":{}}}
GET /definitely-not-a-route-xyz/api/state          → 404   (控制组：未挂载前缀)
GET /                                              → 401   text/plain（Host 自身的鉴权门，与上者不同层）
```

401 的 code/文案与仓库 `lib/host/api.js:1073` 逐字一致，是插件 handler 在 `connection.requestRejection(req)`（`lib/host/api.js:1064-1071`）之后**自己**构造的响应 ⇒ 能走到这行，说明 `apply()` 已执行、前缀路由已挂到 `webServer`。

**(b) 鉴权后全 200**：用 `~/.dsh/.credentials.yaml` 里 `client-connection/browser-session` 的 secret、按 Host 同款算法（`cookieName = 'dsh-auth-' + base64url(sha256(authority))`，`client-connection/lib/index.js:335`；值 `v1.<payload>.<hmac>`）自签宿主 cookie 复测：

| 请求 | 结果 |
|---|---|
| `GET /api/state` | 200 / 731 B，`{"ok":true,"state":{"enabled":true,"version":"0.3.5","defaultMode":"soft","memory":{…,"adapters":[{"id":"lingshu","available":true},…]},"limits":{…,"rate":{"remaining":20}},…}}` |
| `GET /api/sessions` | 200 / 87,282 B（真实会话列表，含 `running`/`deletable`） |
| `GET /api/trash` | 200 / 7,892 B |
| `GET /api/audit` | 200 / 8,315 B |
| `GET /api/nope-404-control` | 404 `E_NOT_FOUND`（插件自有错误体） |

`version:"0.3.5"`、`rate.remaining`（进程内滑动窗口）、`memory.adapters[].available`（实时探活）只能由运行中的插件代码产生。

**(c) 客户端图收录**：`__DSH_BOOT__`（`rev=26f96c00175d`，`release={"version":"0.2.1-rc.3","commit":"be72761"}`，104 个 entry）里有：

```json
{"id":"dsh-conversation-recycle-bin",
 "url":"plugins/??dsh-conversation-recycle-bin/client.js&rev=a878b576b85c",
 "rev":"a878b576b85c",
 "inject":["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-ui-renderer","@deepseek-ai/dsh-client-ui-workspace","@deepseek-ai/dsh-client-ui-conversation","@deepseek-ai/dsh-client-ui-settings"],
 "immediately":true}
```

取该 URL → `200 text/javascript 106,137 B`。该图由 **live loader entries** 生成（`dsh-client-modules/lib/index.js:106-118,558`：`for (const entry of ctx.loader.entries()) this.dirty.add(entry.options.name)`），故这是"装载层"证据而非仅静态声明。

> **重要更正**：裸路径 `/plugins/<id>/client.js`（不带 `?rev=`）返回 404 **是 rc.3 的设计**——`dsh-client-modules` 只认 combo（`/plugins/??<id>/client.js&rev=`）与带 rev 的包内 chunk（`chunkUrl`）。团队内部一度把它记成"网页端 bundle 前缀不可达"，**该判断错误**；桌面端和网页端走的是同一个 `/plugins/` 路由（同一 Host），URL 必须带 rev。

**(d) 数据面历史**：`~/.dsh/delete-conversation/`（目录名沿用历史 id，见 §7-L2）`audit.jsonl` 22 行 —— `source:"desktop-ui"` 9 条、`"web-ui"` 13 条；`trash/` 22 个条目目录。

**(e) 为什么日志里没有"加载成功"**：加载器只在**失败**时落盘 `~/.dsh/logs/startup-*.log`（`dsh/lib/bin.js:178-180`，由 `StartupError` 触发）；可选插件失败只打一行 stderr warning（`dsh-app-boot` 的 `activationDiagnostic`）。⇒ **"没有成功日志"是正常现象，不能当作未装载的证据**。

### 3.2 删除链路（隔离 E2E）【隔离实测】

临时 `DSH_HOME` + 插件真实 `createDeleteApi`（真 route → 真 trash store → 真 audit → 真 memory adapter），Host 侧会话/工作区用 `test/helpers.mjs` 的内存夹具：

```
[    2.0 ms] GET  /sessions        200 sessions=2
[    2.9 ms] POST /preview(soft)  events=12 memory=1
[   19.5 ms] POST /delete(soft)   200 ok archived=true
[    2.0 ms] GET  /trash           1 条 mode=soft memory=1
[   16.0 ms] POST /trash/restore   200 ok
[ 1513.1 ms] POST /delete(hard)   200 ok   ← zstd 打包会话日志
[    7.2 ms] POST /trash/purge     200 ok
[    0.7 ms] GET  /audit           4 条全部 success
```

断言全绿：预览统计、软删置 `archived` 且记忆索引归零、恢复回滚、硬删后原目录消失、purge 后 `trash/` 清零。

**量级提示**：硬删除单会话约 **1.5 s**（zstd 打包 + 移动）；批量上限 `maxBatchSessions:50`、`effectiveBatch:20`、`maxDeletesPerMinute:20`。

### 3.3 今日两份 crash 日志与插件无关【实机探测】

| 文件 | 内容 | 相关性 |
|---|---|---|
| `crash-2026-10-24T01-33-26-164Z-web-boot.log` | `web boot: 1 entry did not activate` / `dsh-bili-whale: import failed`，header `app: … 0.2.1-rc.2` | 无关（别的插件 + 旧壳） |
| `crash-2026-10-24T06-55-58-550Z-host.log` | `host exited with 4294967295`（= -1）、`experimental-inspector: globalThis.fetch is an accessor…`、大量 qq-bridge stdout，header `0.2.1-rc.2` | 无关（`grep -c "conversation-recycle-bin\|delete-conversation" = 0`） |

> 会话期间桌面端自己重启过一次（Host 端口 14582 → 1151，PID 23148 → 30040，asar 未变=同版本 rc.3）。本轮**未重启、未 kill 任何 DSH 进程**；新实例上插件前缀仍返回 401（=仍挂载）。

---

## 4. Host 侧契约（rc.3）—— 12 条适配 / 0 条不兼容

| # | 插件依赖 | rc.3 证据 | 状态 |
|---|---|---|---|
| H1 | `export const name` / `inject = ['webServer']` / `apply(ctx, config)` | cordis 4.0.5 + cordis-plugin-loader 1.0.6；`ctx.registry.plugin(...)` → `runtime.callback(this.ctx, this.config)`（`cordis/lib/index.js:1067`） | ✅ |
| H2 | 未导出 `Config`，自建 `normalizeConfig()` | `resolveConfig` 无 `Config` 时原样传入、不校验（`cordis/lib/index.js:956-961`） | ✅ |
| H3 | `ctx.effect(() => disposer)` 回收路由 | `effect(execute, label)`，卸载执行返回值（`cordis/lib/index.js:1169`） | ✅ |
| H4 | `ctx.webServer.register({kind:'prefix', path, handler})` | `dsh-host-webserver/lib/index.js:326`，返回 disposer；前缀匹配 `pathname === prefix \|\| startsWith(prefix + '/')`（`:378`） | ✅ |
| H5 | `ctx.get('connection').requestRejection(req)` | `dsh-client-connection/lib/index.js:737`，`undefined`=放行；未信任→403、已释放/未认证→401（`:742+`） | ✅ |
| H6 | `ctx.waterfall('connection/request', req, res, next)` | `cordis/lib/index.js:318-326`；`dsh-desktop-host/lib/index.js:116` 仍以三参监听 | ✅ |
| H7 | `workspaceRegistry` 八个成员 | `dsh-workspace/lib/types/index.js`；`archiveSession(id,{stopActivity:true})`（`:282-304`）跳过活动检查并 `stopSessionActivity`；`unarchiveSession`（`:316-328`）无存在性检查、幂等 | ✅ |
| H8 | `sessionController.list` → `{items}`、`cancel({sessionId})` | `dsh-api-session-controller/lib/index.js:3061-3067` | ✅ |
| H9 | `sessionPersistence.list/stat` | `dsh-session-persistence-jsonl/lib/index.js:2603/2570`，`stat` 返回 `header/revision/sizeBytes/formatStatus` | ✅（见 A2） |
| H10 | 会话日志目录 `<home>/sessions/<projectDir>/<encodeSegment(id)>` | `:858-870` `encodeSegment`（非 `[A-Za-z0-9._-]` → `~XXXX`，`.`→`~002E`，`..`→`~002E~002E`）+ `:907/919-922` | ✅ 逐字符一致 |
| H11 | `storages/workspace.json`（global）与 `storages/session_projcache/sessions/<id>.json`（per-record） | `dsh-storage-json/lib/index.js:179/313`；`dsh-session-projection-cache/lib/index.js:14-15,90` | ✅ |
| H12 | `dsh.bundle.patch: './cordis.patch.yml'` 字符串写法；行 `- insert: [{id,name,config}]` | `dsh-app-boot` 的 `bundlePatchFiles/bundlePatchPaths` 支持字符串或数组；`dsh-plugin-manager/lib/index.js:98` 要求 `dsh.bundle` 存在 | ✅ |

---

## 5. Client 侧契约（rc.3）—— 15 条适配 / 0 条不兼容

| # | 插件依赖（`client.js`） | rc.3 证据 | 状态 |
|---|---|---|---|
| C1 | 模块格式 `window.__ModuleLoader__.load({id, factory})`，id = 包名 | `dsh-client-modules/lib/client.js:1`；校验报错文案 `loaded without registering "<id>" via __ModuleLoader__.load`（`:758/:874`） | ✅ |
| C2 | `require('react')` / `require('react-dom')` | `dsh-web-frontend@rc.3 › dist/assets/index-BXV-oxvX.js` 的 platform seed 含 `react`、`react-dom`、`react-dom/client`；rc.2 的同一列表键名与顺序一致 | ✅ |
| C3 | `exports.inject=['slots']` + `ctx.slots ?? ctx.get('slots')` | 服务名仍为 `slots`（由 `dsh-client-ui-renderer` 提供）；宿主包同写法（`ui-settings-general/lib/client.js:1146`） | ✅ |
| C4 | 内联 `<style>` 注入 | 桌面 `lib/main.js` 与 `web-frontend/dist/index.html` 均**无 CSP 头**（grep 0 命中） | ✅ |
| C5 | `ctx.effect(fn)` 注册/回收 | 各宿主包同写法（`ui-settings-general/lib/client.js:1161`） | ✅ |
| C6 | `shell.overlay`（list/root，order 50） | `ui-layout/lib/client.js:313` `renderSlot("shell.overlay", {})`、`:351` `data-shell-overlay`；类型 `lib/types/client/index.d.ts:95-98` | ✅ |
| C7 | `sidebar.workspaces.session.menu.item`（order 500），读 `sessionId`/`displayTitle`/`useMenuOpenState()` | `ui-workspace/lib/client.js:2345-2348` `renderSlot(…, { sessionId: node.id, displayTitle: row.title }, { hookContext: menuOpenState })`；`contract/slots.d.ts` 的 owner/hookContext 与插件三个用法全命中 | ✅ |
| C8 | `conversation.session.header.actions`（session 作用域，order 100） | `ui-conversation/lib/client.js:18193` `renderSlot(…, {})`；`ConversationHeaderActionOwnerProps { children?: never }` ⇒ 组件拿标准 session props（含 `sessionId`，`ui-session/lib/types/client/index.d.ts:80-86`） | ✅ |
| C9 | `settings.section`（order 1300，`label` 可为 thunk） | `ui-settings-general/lib/client.js:337` `renderSlot("settings.section", { close }, { only: active })`；`resolveSlotLabel` 支持函数（`ui-slots/lib/index.js:27-29`） | ✅ |
| C10 | 15 个 `--dsw-alias-*` 主题 token | `ui-theme/lib/client.js:1413` 亮/暗（`body[data-ds-dark-theme]`）双作用域齐全；命名空间未改名 | ✅ |
| C11 | locale：`getSnapshot().active` + `subscribe` | `dsh-client-locale/lib/client.js:1217/1114/1447`；插件自带 `STRINGS`，不调 `t()` | ✅ |
| C12 | `apiUrl()` 以 `document.baseURI` 归一化 | 网页端无 `<base>` ⇒ `http://127.0.0.1:<port>/conversation-recycle-bin/api/…`；桌面端 `dsh-app://app/`（`main.js:12134`） | ✅ |
| C13 | 桌面端 `fetch()` 到自定义协议 | `protocol.registerSchemesAsPrivileged([{scheme:'dsh-app', privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true,codeCache:true}}])`（`main.js:11880-11890`） | ✅ |
| C14 | 非白名单路径由外壳转发 | `protocol.handle` 的 app 分支（`main.js:12406-12412`）→ `forwardWebRequest`（`:8269-8305`）：origin 必须是 `dsh-app://app`，删 `host/origin/cookie/sec-fetch-site`，注入 Host cookie，`/plugins/` 响应强制 `no-store` | ✅ |
| C15 | `dsh.client.inject` 6 个包可解析 | rc.3 安装集中 `dsh-client-{locale,connection,ui-renderer,ui-workspace,ui-conversation,ui-settings}` 全部存在 | ✅（见 A1） |

---

## 6. rc.2 → rc.3 到底改了什么

**Host 侧（制品级 cmp）**：22 个相关包（`dsh-app-boot`、`dsh-host-webserver`、`dsh-client-connection`、`dsh-workspace`、`dsh-session*`、`dsh-storage-*`、`dsh-plugin-manager`、`dsh-base`、`dsh-web-app` 等）的**全部 `.js`/`.mjs` 逐字节相同**，`dsh-base/cordis.patch.yml` 亦相同。真实差异只有两类：`package.json` 的 version 与内部包 pin；asar 打包剥离了 `.d.ts`。底座 `cordis ~4.0.5`、`cordis-plugin-loader ~1.0.6` 两版 pin 一致。

**Client 侧**：`dsh-client-{modules,ui-slots,ui-settings,locale,ui-session,ui-renderer,ui-theme,hmr,connection,resources}` 的 `lib/client.js` **逐字节相同**；有差异的两个包都不涉及本插件：

- `ui-workspace`（13 行）——全在会话创建路径（`connectBlank` 不再强制新建、`createInWorkspace` 增 `agentPreset` 比对、`startSession` 的 `whenDraftExists:"replace"|"keep"`）；`sidebar.workspaces.session.menu.item` 的声明/渲染点/owner props/hookContext 逐字未动。
- `ui-conversation`（257 行）——**只是新增** `conversation.session.header.views.actions` 槽（view 级动作，本插件不用）；`conversation.session.header.actions` 及其 owner 类型未变。
- `dsh-web-frontend` 外壳哈希变化（`index-CN7NIWNw.js` → `index-BXV-oxvX.js`），但 platform seed 列表键名与顺序一致。

**结论：rc.2→rc.3 对本插件依赖的全部扩展点零破坏性变化**；上一轮针对 rc.2 的结论可原样沿用，本轮新增的是"在真实 rc.3 实例上的运行时实证"。

---

## 7. 需注意项（均非阻断；**没有一条是 rc.2→rc.3 的回归**）

| ID | 项 | 影响 | 建议动作 |
|---|---|---|---|
| **A1** | `dsh.client.inject` 声明 6 个客户端包，但 `client.js` 只直接消费 `locale`（`slots` 由 `exports.inject` 负责）；其余 5 个是**存在性硬依赖** | 任一方改名/被裁剪 ⇒ 整包不加载（bundle 404 → 整个 UI 消失），而不是局部降级 | 保守做法：保持现状（这些包确实提供 4 个槽位的宿主）。若要降耦合，需先确认 client graph 的 `inject` 语义再收敛，**不要盲目删** |
| **A2** | rc.3 的 `sessionPersistence.stat()` **不返回 `eventCount`**，插件 `gateway.js:254` 取 `snapshot?.eventCount` | UI「事件数」列恒为 `null`（显示空/—），不报错 | 若要补：改从 `dsh-session` / projection cache 取，或删掉该列。**非回归**（rc.2 该包逐字节相同） |
| **A3** | `lib/host/lifecycle.js:58` `const controller = ctx.get?.('sessionController') ?? ctx.sessionController` **无 try/catch** | 在裁剪组合（无该服务）里，`ctx.get` 返回 `undefined` 后回退到 `ctx.sessionController`，会命中 cordis 的 Proxy trap 抛 `cannot get property "sessionController" without inject`（`cordis/lib/index.js:676`），错误类型不是插件自有 `DeleteError`，会冒成 500 | 改为 `?? undefined` 前的 try/catch，或包一层 `service()` 探针（`gateway.js:30-36` 已有现成写法） |
| **A4** | 未导出 `Config` | rc.3 视为 `unknownConfig` ⇒ 用户**不能**在「插件设置」页表单化编辑配置，只能改 profile patch YAML | 既有设计。若要设置页可编辑，需导出 schemastery `Config` |
| **A5** | `package.json` **未声明 `engines.dsh`** | rc.3 只在声明时做版本闸门（拒绝会给出 `incompatible-version` + `allow-version` 命令）。不声明 ⇒ 未来版本不兼容时只会表现为加载失败/行为异常，没有明确提示 | 建议加 `"engines": {"node": ">=20", "dsh": ">=0.2.1-rc.2 <0.3.0"}` 之类的区间 |
| **A6** | `probeRunning` 读 `session.running/active/busy`，rc.3 的 `Session` 实例这三个字段都没有 | 恒返回 `undefined` ⇒ 每次都回退到完整 `inspect()`（多一次读盘）；**不会误判** | 低优先。若在意 drain 轮询开销，改读 `ctx.agents.get(id).status` |
| **A7** | 归档/置顶是**双读**：`workspaceRegistry` 内存态 + 插件自己解析 `workspace.json`（1.5 s 缓存） | 另一个 Host 进程写盘后，插件视图最多陈旧 1.5 s | 已有 `foreignWriterGraceMs` 缓解；多 Host 共享 `DSH_HOME` 时注意 |
| **A8** | `sessionPaths` 成员判定含 `missingSessionPaths` | header 丢失的会话仍算"属于某 workspace"，而 `cwd` 漂移的会被过滤成孤儿；与 `allowOrphanSessions:false` 默认组合时，误判方向偏向"拒绝" | 保守（宁可不删），可接受；文档里说明 |
| **A9** | 15 个主题 token 都写成 `var(--dsw-alias-x, <浅色兜底>)` | token 一旦改名，**静默降级**为硬编码浅色（暗色主题下会是亮色块），不报错 | 可接受；若要强约束，加一个"token 存在性"自检脚本 |
| **A10** | 日志走 `console.*`，不用 `ctx.logger` | Host 日志采集不会加进程/插件前缀，排障只能按文本 grep | 可接受；建议统一前缀（现在已有 `[conversation-recycle-bin]` 前缀，够用） |
| **A11** | 同源/回环围栏完全在插件内实现（`lib/host/api.js:153` `requestOriginVerdict`，只看 `Host`/`Origin`） | 反向代理部署（`--public-url` 到子路径、上行 Host 被改写）时，必须把代理 authority 显式写进 `allowedHosts`，否则一律 403 | 部署文档里写清；`client.js` 的 `apiUrl()` 前缀归一化已支持子路径 |
| **A12** | 数据目录沿用历史 id `~/.dsh/delete-conversation/`（`lib/host/paths.js:37-43`，注释说明是"without a migration"的兼容选择） | 功能无害；运维/文档按插件名找数据会找不到 | 可接受；README 已注明，保持 |

---

## 8. 与上一轮（rc.2）结论的关系

上一轮 `AUDIT-2026-10-22-desktop-web-compat.md` 的 8 条建议已在 0.3.5 全部落地（C-01 `apiUrl()` 前缀部署、C-02 回收站超时 195 s/锁 180 s、C-08 测试门禁、C-03 `allowedHosts`、P-01 回收站单次扫描、P-02 索引快照复用、P-05 设置页懒加载、P-04 宽限提示）。本轮在 rc.3 上复核这 8 条全部仍然成立（对应 §5.C12、§7、§3.2 量级）。

---

## 9. 未验证项（**不要当作已验证**）

1. **桌面渲染进程内没有 DOM/Network 抓包**：桌面端"点菜单项 → 弹窗 → 列表刷新"的 UI 链路是代码走读 + HTTP 推断，未接 DevTools/`webContents`。
2. **cookie 是自签而非从桌面端提取**：用 `~/.dsh/.credentials.yaml` 同一 secret、按 Host 同款算法生成（未打印 secret），并已用 `GET /` 200 反证 Host 接受。方法不同但等效性强，**不要写成"从桌面端抠出的 cookie"**。
3. **隔离 E2E 的 Host 面是夹具**：`workspaceRegistry`/`sessionPersistence`/`sessionController` 用 `test/helpers.mjs` 的内存实现，真实的是路由、存储、回收站、审计、记忆适配器与级联。真实内核下的端到端未做（需要人工在 UI 上点，或起 `dsh web`）。
4. **`dsh web` 独立进程本轮不存在**：网页端结论来自"浏览器访问同一 Host"，不是独立 `dsh web` 实例；`--public-url` 子路径与反代场景未实机验证。
5. **`dsh-desktop-host` 的 rc.2 差异未验证**：该包未发布 npm，rc.2 的桌面 asar 不可得；只能确认 rc.3 已装版的 `connection/request` 监听契约。
6. **反馈邮件链路未触发**（`transport:"smtp"`，未真发）。
7. **`dsh.client.platform` / `immediately` 的宿主消费点未定位到代码行**（本轮只确认它们在 `__DSH_BOOT__` 图里被原样携带）。
8. **`npm test` 未在收尾时整套复跑**（Lead 首轮已得退出码 0，全套约 47 s）；`npm run check` 退出码 0（manifest 9/9）。

---

## 10. 采信口径修正（团队内部曾出现的错误判断）

| 曾有判断 | 事实 |
|---|---|
| "网页端 `/plugins/<id>/client.js` 404 ⇒ bundle 前缀不可达" | **错**。rc.3 只认 combo `plugins/??<id>/client.js&rev=` 与带 rev 的 chunk；用 `__DSH_BOOT__` 里的真 URL 请求即 200（106,137 B）。两端同一个 `/plugins/` 路由 |
| "`/conversation-recycle-bin/api/*` 返回 401 说明路由没挂上" | **错**。未挂载是 404（控制组已验证）；401 是 `connection.requestRejection` 之后插件自造的 `E_UNAUTHORIZED` |
| "没有加载成功日志 ⇒ 可能没装载" | **错**。成功不落盘，只有 `StartupError` 写 `~/.dsh/logs/startup-*.log` |
| "今日 crash 日志可能与插件有关" | **错**。两份都是 rc.2 旧壳，`grep` 本插件 0 命中 |

---

---

## 11. 修复记录（0.3.6，本报告 §7 的四条建议动作已落地）

审计交付后，用户要求「全部进行」，即按 §7 的建议把 A2 / A3 / A5 / A6 实现掉。本节记录实际改动、验证方式与仍然**不改**的项，避免与本报告 §4–§7 的「现状」描述混淆（§4–§7 记录的是 0.3.5 的审计快照）。

| 项 | 改动 | 文件 | 验证 |
|---|---|---|---|
| A3 | 新增 `peek()`：`ctx.get?.(name) ?? ctx[name]` 整条留在 `try` 内；`service()` 复用它；`quiesce()` 把 `sessionController` 当可选服务，缺失时跳过 `cancel`、归档与 drain 照常 | `lib/host/lifecycle.js` | 新用例：`Object.defineProperty` 抛 `cannot get property … without inject` 的 getter + 假 `workspaceRegistry`，断言 `archiveSession(id,{stopActivity:true})` 仍发生、返回 undo |
| A6 | `probeRunning()` 主探 `agents.get(id)?.status === 'running'`（与 `dsh-api-session-controller/lib/index.js` 列表行同判据），旧的 `Session.running/active/busy` 降为兜底 | `lib/host/gateway.js` | 新用例：`{status:'running'}` → true、`{status:'idle'}` → false、无 agent → false；`inspect()` 仍能取到 `seq` |
| A2 | 新增 `eventCountFor()`：活跃会话取 `Session.seq`（会话存储定义为日志长度，精确、纯数值读，不用已废弃的 `snapshotEvents()`）；非活跃会话无便宜的精确来源，保持 `null`（UI 显示 `—`） | `lib/host/gateway.js` | 夹具 `stat()` 改成 0.2.1 真实形状（去掉 `eventCount`）；新用例覆盖活跃=12、非活跃=`null`。**改前该用例是假绿**（夹具返回了真实 Host 不返回的字段） |
| A5 | `engines.dsh: ">=0.2.1-rc.2"`（实测下限；不设上界，未验证更晚版本不硬拒） | `package.json` | `manifest` 用例 + 手动核对 `dsh-plugin-manager` 的 `requirements` 读取键为 `engines.dsh` |
| 版本 | 0.3.5 → 0.3.6；`lib/version.js` 的 `PLUGIN_VERSION` 同步（`test/manifest.test.mjs:110` 守门） | `package.json`、`lib/version.js`、`CHANGELOG.md` | `env -u NODE_OPTIONS npm run check` 9/9；`npm test` 8 个文件全绿，**141** 条（api 41→44） |

**明确不改的四条**（复核后属产品取舍，不是遗漏）：

- **A1**（`dsh.client.inject` 申报了 6 个包、只有 `dsh-client-locale` 被 `ctx.inject` 直接消费）：多申报是廉价的加载顺序保护；删掉反而可能在 locale 尚未注册时取到 `undefined`。保留现状。
- **A4**（无 `Config` 导出 ⇒ 设置页不能自动表单化）：插件 60+ 个配置项是嵌套结构，官方表单渲染器覆盖不到；设置页已自绘并做 `allowedHosts` 等校验，导出 `Config` 只会得到一个渲染不完整的表单。
- **A7**（归档/置顶双源读 + 1.5 s 缓存）：这是「uiapi 优先、registry 兜底」的兼容层，双读成本已由缓存吸收；单源化会依赖某一个服务在同一组合里必然存在——恰恰是本轮 A3 暴露的那类假设。
- **A8**（`missingSessionPaths` 用成员判定而非 `existsSync` 计数）：成员判定是廉价的「日志缺失」上界，语义正确（多报会被后续 `stat()` 证伪），无需遍历。

**仍未做（与本轮适配无关）**：npm publish（上一轮 §9 起就挂着）、`engines.dsh` 上界、`stat()` 缺 `eventCount` 时的 Host 侧补齐（属 DSH 产品改进建议，已记在 §7 A2）。

---

*本报告由 Lead 汇总三路证据（Host 契约 / Client 契约 / 运行时实证）并做交叉校正。审计期间的临时脚本、抽取的 asar 副本与隔离环境均已清理。产品代码在报告交付时零改动；§11 记录的是用户随后要求「全部进行」而实施的 0.3.6 修复（`git status` 可见 `lib/host/{lifecycle,gateway}.js`、`lib/version.js`、`package.json`、`CHANGELOG.md`、`test/api.test.mjs` 与本报告）。*
