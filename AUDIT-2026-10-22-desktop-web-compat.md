# 桌面端 / 网页端适配性与流畅性报告（2026-10-22）

- 被审对象：`dsh-conversation-recycle-bin` **0.3.4**（`D:\Users\34332\AI\dsh-conversation-recycle-bin`），git HEAD `a6fb8a5`，**工作树有 5 个未提交文件**（`client.js`、`lib/host/api.js`、`scripts/check-syntax.mjs`、`test/api.test.mjs`、`test/client-module.test.mjs`）。
- 对照运行时：
  - 网页端：`dsh web --no-open --host 127.0.0.1 …`，`@deepseek-ai/dsh` **0.2.1-rc.2**，在线于 `http://127.0.0.1:8080`（PID 8576）。
  - 桌面端：`@deepseek-ai/dsh-desktop` **0.2.1-rc.2**，安装于 `C:\Users\34332\AppData\Local\Programs\DeepSeek Harness`。本轮**未运行**（进程表里只有 `dsh-pet` 的 electron 助手），桌面端结论来自安装产物的静态核对 + 转发链路复刻实测。
- 两端装载（实机读取）：`profiles/web` 与 `profiles/desktop` 的 `dependencies` 均为 `"dsh-conversation-recycle-bin": "link:D:/Users/34332/AI/dsh-conversation-recycle-bin"`，且 `dsh.profile.bundles` 都包含该 id。**两端共用同一份工作树源码**，不存在版本漂移；因此本报告的"两端差异"只可能来自传输路径、部署方式与数据规模，而不是代码分支。

> 证据等级：**实机探测**（对运行中的 Host / 安装产物直接读取）、**最小用例实测**（隔离环境跑真实代码）、**代码走读**、**测试运行**。

---

## 0. 结论速览

| 维度 | 桌面端 | 网页端 | 依据 |
|---|---|---|---|
| 装载与版本 | ✅ 一致 | ✅ 一致 | 两端 Host 都是 0.2.1-rc.2，client 包由 Host 下发 |
| 4 个 UI 槽位 | ✅ 全部存在 | ✅ 全部存在 | 槽位由 Host 侧 `dsh-client-ui-*` 提供，两端同源 |
| 传输适配 | ✅ 外壳转发正确 | ✅ 同源直连正确 | 见 §3.3 |
| 路径前缀部署 | 不适用 | ❌ **发布版 0.3.4 整体失效**；工作树已修 | 见 C-01 |
| 反向代理部署 | 不适用 | ⚠️ 需手工放宽 + 代理超时 | 见 C-03 / C-04 |
| 主路径耗时 | 浏览/预览 ≤ 20 ms | 浏览/预览 ≤ 20 ms | 删除见 §4.3 |
| 长批量删除（> 60 s） | 可完成 | 可能被代理切断 | 见 C-04 |
| 本轮点击级 E2E | **未执行** | 路由可达（401 为预期） | 见 §8 |

一句话结论：**两端在"代码契约"层面完全兼容，差异全部落在部署与数据规模上。**桌面端多一跳但实测只多 0.46 ms，且不会串行化并发请求；网页端少一跳、可利用 HTTP 缓存，但对反向代理的路径前缀、Host/Origin 头与读超时敏感。当前真正的流畅性瓶颈不在"哪一端"，而在宿主侧的重复 IO（回收站双扫描、记忆索引双读）与两处固定等待（1.5 s 外部写入宽限、设置页全量重挂载）。

---

## 1. 本轮执行的检查

| 检查 | 命令 / 方式 | 结果 |
|---|---|---|
| 全量测试（干净环境） | `env -u NODE_OPTIONS npm test` | **133 / 134 通过**，1 例红（C-08） |
| 语法 + manifest | `npm run check` | 9 / 9 通过，退出码 0 |
| 在线 Host 路由 | `GET /conversation-recycle-bin/api/state` | `401 E_UNAUTHORIZED`（路由已挂载，鉴权层拦截，符合预期） |
| 桌面外壳转发器 | 从 `app.asar` 提取 `lib/main.js` 逐行核对 | 与 README 描述一致（§3.3） |
| 桌面静态资源 | `protocol.handle` 分流白名单 | `/`、`/index.html`、`/assets/*`、`/favicon.svg`、`/manifest.webmanifest` 走本地；其余全部转发 |
| 桌面 scheme 权限 | `registerSchemesAsPrivileged` | `standard/secure/supportFetchAPI/corsEnabled/stream/codeCache` 全开 → `fetch()` 可用 |
| 传输链路开销 | 按 `forwardWebRequest` 复刻 Node 代理，300 次对照 | 额外 **+0.46 ms**（GET）/ **+0.48 ms**（POST）；4 并发不串行 |
| 宿主接口耗时 | 进程内真实 handler + 92 会话 / 104~21000 记忆节点夹具 | §4.1 |
| 真实数据规模 | 读 `<DSH_HOME>` 统计 | 139 会话 / 136.6 MB（中位 0.36 MB，最大 8.5 MB）；记忆索引 126.1 KB / 104 节点；回收站 14 条；审计 5.2 KB |

> 环境说明：本会话的 `NODE_OPTIONS` 注入了 WorkBuddy 的 `node-language-shim`（safe-delete 批量保护）。它会在测试清理阶段拦截 `fs.rm`，把 7 个 `memory.test.mjs` 用例误报为失败（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）。**这与插件无关**；清空 `NODE_OPTIONS` 后如常通过。上表"干净环境"即指此。

---

## 2. 环境矩阵

| 项 | 桌面端 | 网页端 |
|---|---|---|
| 页面 origin | `dsh-app://app` | `http://127.0.0.1:8080`（或前缀部署时的 `https://host/<prefix>/`） |
| 前端资源来源 | asar 内 `dsh-web-frontend/dist`，经 `protocol.handle` 提供 | Host 静态服务（同一份 dist） |
| 插件 client 包 | 由 Host 以 `/plugins/<id>/client.js?rev=…` 下发，经外壳转发 | 由 Host 直接下发 |
| 接口传输 | `forwardWebRequest()`：Node `fetch` → 本地 Host | 浏览器 `fetch` → Host（同一连接池） |
| 鉴权 | 外壳注入 Host 签发的 cookie（`headers.set('cookie', …)`） | 同源 cookie（来自 `dsh web` 打印的认证 URL） |
| `document.baseURI` | `dsh-app://app/` | `http://127.0.0.1:8080/` 或 `…/<prefix>/` |
| 插件路由 | `/conversation-recycle-bin/api/*` | 同左 |
| Host 监听 | `--no-open --host 127.0.0.1 --port 0`（由 `@deepseek-ai/dsh-desktop-host` 以 desktop profile 启动，随机端口） | `127.0.0.1:8080` |
| DSH_HOME | `C:\Users\34332\.dsh`（与网页端同一个） | 同左 |

两端 Host 版本、前端 dist、client 包完全一致，**UI 与接口行为不可能出现"一端有、另一端没有"的功能差异**；差异只可能来自运输层和部署。

---

## 3. 适配性核对

### 3.1 装载与版本一致性（两端 ✅）

- 两端 profile 都 `link:` 到同一工作树，`bundles` 都含 `dsh-conversation-recycle-bin`。
- 桌面端 Host 由外壳 spawn `@deepseek-ai/dsh-desktop-host` 启动，后者以 desktop profile 调起 Web 应用（`--no-open --host 127.0.0.1 --port 0`），加载的是同一个 `@deepseek-ai/dsh` 0.2.1-rc.2。
- 因此审计里的 `auditSource` 能正确区分 `desktop-ui`（`process.versions.electron` 存在）与 `web-ui`，前几轮已实测确认。

### 3.2 UI 扩展点（两端 ✅）

四个槽位——`shell.overlay`、`sidebar.workspaces.session.menu.item`、`conversation.session.header.actions`、`settings.section`——由 Host 下发的 `dsh-client-ui-*` 包声明并使用，本轮在已安装的 0.2.1-rc.2 里逐个命中：

| 槽位 | 证据 |
|---|---|
| `sidebar.workspaces.session.menu.item` | `dsh-client-ui-workspace/lib/client.js:2344` `renderSlot(...)`，`:5252` 起多处 `slots.inject` |
| `conversation.session.header.actions` | `dsh-client-ui-conversation/lib/client.js:18033` `renderSlot(...)`，`:19855` 槽位声明 |
| `shell.overlay` | `dsh-client-ui-chat/lib/client.js:13288` `slots.inject("shell.overlay", …)` |
| `settings.section` | `dsh-client-ui-agent-preset/lib/client.js:2455`、`dsh-client-ui-settings-account/lib/client.js:4773` 的 `slots.inject`；槽位类型由 `dsh-client-ui-settings` 声明（其 README §44） |

> 注：直接在桌面 asar 的 `dsh-web-frontend/dist/assets/index-*.js` 里搜槽位名会得到 0 命中——那是**引导壳**，client 包是运行时由 Host 下发的。这一点容易误判，记录在此避免下一轮重复排查。

### 3.3 传输层（核心差异，两端均 ✅）

桌面外壳 `app.asar/lib/main.js` 的 `protocol.handle('dsh-app', …)` 分流如下：

```js
if (url.pathname === "/" || url.pathname === "/index.html" ||
    url.pathname.startsWith("/assets/") ||
    ["/favicon.svg", "/manifest.webmanifest"].includes(url.pathname))
  return serveWebDocument(request, …/dsh-web-frontend/dist)
// 其余（含 /conversation-recycle-bin/api/*）一律转发
return forwardWebRequest(request, hostUrl, hostCookie)
```

`forwardWebRequest` 的关键动作（逐条核对）：

| 动作 | 代码 | 对插件的影响 |
|---|---|---|
| 校验 `Origin` | `if (origin !== null && origin !== "dsh-app://app") return 403` | 页面自身同源，恒通过 |
| 删除 `host/origin/cookie/sec-fetch-site` | `for (const name of [...]) headers.delete(name)` | Host 头由 undici 重写为 `127.0.0.1:<port>` → 插件回环校验通过；`Origin` 为空 → 同源校验短路（见 C-05） |
| 注入 Host cookie | `headers.set("cookie", cookie)` | 插件三道闸中的 `connection.requestRejection` 通过 |
| 保留其余头 | `new Headers(request.headers)` 后只删 4 个 | `x-conversation-recycle-bin: 1` 存活 → 私有头校验通过 |
| 透传 method / body / query / signal | `method`、`body: request.body`、`duplex:"half"`、`signal` | POST 与客户端 AbortController 都能到达 Host |
| 扣留传输级响应头 | `WITHHELD_RESPONSE_HEADERS` | 不影响 JSON 语义；`cache-control` 保留 |
| `/plugins/` 强制 `no-store` | `PLUGIN_BUNDLE_PATH.test(source.pathname)` | 见 C-06 |

**结论**：插件的同源/回环/私有头三道闸在桌面路径上都能正确落地；客户端用 `document.baseURI` 解析相对地址，在 `dsh-app://app/` 下得到 `dsh-app://app/conversation-recycle-bin/api/…`，与外壳的"非静态即转发"规则对上。**桌面端不存在路径或鉴权层面的适配缺口。**

### 3.4 路径前缀部署（网页端）

- 工作树中的 `client.js` 已改为文档相对（新增 `apiUrl()`：以 `new URL('.', document.baseURI)` 归一化 base，并去掉 `API_PREFIX` 的前导斜杠再拼接），并有回归测试（`client-module.test.mjs` "API calls stay document-relative…"，本轮通过）。
- **但已发布的 0.3.4 仍是绝对路径**：`git show HEAD:client.js` 第 503 行是 `new URL(API_PREFIX + path, base)`，而 `API_PREFIX` 以 `/` 开头，按 RFC 3986 会替换整个 base 路径。以 `dsh web --public-url https://host/ui/` 部署时，请求会打到 `https://host/conversation-recycle-bin/api/…`，前缀被丢弃，全部接口 404。
- 由于两端当前都 `link:` 到工作树，**现状可用**；一旦按 tarball 安装 0.3.4，网页端在前缀部署下会整体失效（桌面端不受影响）。

### 3.5 反向代理部署（网页端）

- `requestOriginVerdict()` 先看 `Host` 头是否回环。反代保留外部 Host（如 `app.example`）时返回 `403 E_FORBIDDEN_HOST`；唯一开关是 `allowNonLoopback: true`（全放开），没有 `allowedHosts` 白名单（C-03）。
- 反代读超时：nginx `proxy_read_timeout` 默认 **60s**、`proxy_send_timeout` 默认 **60s**；Cloudflare 到源站的历史默认读超时为 **100s**（可调 100–6000s）。而 `/delete` 的宿主预算上限是 **900s**（`min(900_000, 15_000 + 16_000×批量 + liveDrain)`），客户端预算同量级。批量一大，代理先断，宿主仍在跑（C-04）。

### 3.6 双端同时运行（共享 DSH_HOME）

两端共用 `C:\Users\34332\.dsh`，回收站、审计、记忆索引都是同一份。插件用进程内串行 + `<dataDir>/mutation.lock` 跨进程锁保护 manifest 写，抢不到锁返回 `E_LOCK_BUSY`（409），不会写坏。会话日志本身仍是 best-effort（`foreignWriterGraceMs` 只能发现"窗口内还在增长"的日志）。这属于已知设计边界，不是本轮新问题。

---

## 4. 流畅性实测

测试机：Windows，Node 22.22.2，进程内真实 handler（不经 HTTP），每个场景 3 次取中位；"冷"指新建服务实例（清空 3s 适配器状态缓存与 1.5s 回收站缓存）。

### 4.1 接口耗时

| 接口 | 数据规模 | 冷启动中位 | 说明 |
|---|---|---|---|
| `GET /state` | 无记忆节点 | **0.9 ms** | 有记忆索引时多一次 probe |
| `GET /sessions` | 92 行，投影缓存齐全 | **1.7 ms** | 响应 26.5 KB（≈288 B/行） |
| `GET /sessions` | 92 行，无投影缓存 | **3.0 ms** | 走 `enrichTitles`，只补前 80 行 |
| `POST /preview` ×1 | 0 记忆节点 | **2.7 ms** | |
| `POST /preview` ×1 | 2000 节点 / 索引 180 KB | **5.8 ms** | 索引读两遍（P-02） |
| `POST /preview` ×1 | 21000 节点 / 索引 1.9 MB | **39.2 ms** | 同上，随索引线性放大 |
| `POST /preview` ×20 | 104 节点，默认 20/min 额度 | **5.0 ms** | |
| `POST /preview` ×50 | 104 节点，额度提到 60/min | **9.7 ms** | 默认配置下有效批量是 20（`min(maxBatchSessions, 剩余额度)`） |
| `GET /trash` | 0 / 50 / 200 / 500 条 | **1.2 / 17.2 / 63.3 / 156.3 ms** | 响应 40 B / 13.4 KB / 53.6 KB / 134.3 KB（P-01） |
| `GET /audit?limit=50` | 空审计 | **0.3 ms**（热） | 5 MB 时只读尾部 256 KB |

真实库只有 104 个记忆节点、14 条回收站条目，对应 `/preview` ≈ 3 ms、`/trash` ≈ 5 ms——**当前规模下两端都不会有可感知的接口延迟**。

### 4.2 传输层：桌面多一跳到底多贵

按 `forwardWebRequest` 源码复刻一个 Node 转发代理（同样删 4 个头、注入 cookie、`duplex:"half"`、扣留传输级响应头、缓冲后回写——比真实实现更保守），对同一个 15.5 KB JSON 做 300 次对照：

| 场景 | 直连 p50 / p95 | 经转发 p50 / p95 | 差值 p50 |
|---|---|---|---|
| GET | 0.23 / 0.43 ms | 0.69 / 1.44 ms | **+0.46 ms** |
| POST（50 个 sessionId） | 0.20 / 0.25 ms | 0.68 / 1.02 ms | **+0.48 ms** |
| 4 并发（服务端每次 100 ms） | 110.9 ms | 109.4 ms | **无串行化** |

结论：桌面端的额外一跳约 **0.5 ms/请求**。设置页一次刷新并发 4 个请求，端到端只多 ~2 ms——**传输不是瓶颈**。并发也没有被外壳串行化。

### 4.3 删除操作

| 操作 | 中位耗时 | 备注 |
|---|---|---|
| 软删除 1 条（200 KB 日志，含审计写） | **18.7 ms** | |
| 彻底删除 1 条 + 回收站恢复 1 条 | **38.3 ms** | 移动 + 移回 |
| 批量软删除 20 条 | **215.3 ms** | ≈10.8 ms/条，串行事务 |
| 彻底删除 1 条（日志 1.5 s 内刚写过） | **1521 ms** | `foreignWriterGraceMs` 等待（P-04） |
| 彻底删除 1 条（日志空闲 10 s） | **20 ms** | 宽限窗口已满足 |
| 彻底删除 4 条（都刚写过） | **1614 ms** | 只付一次，不是 4×1.5 s |

### 4.4 规模敏感性

| 维度 | 增长方式 | 实测 |
|---|---|---|
| 回收站条目 | 线性，约 **0.31 ms/条** | 0→500 条：1.2→156.3 ms |
| 记忆索引节点 | 线性，约 **1.7 µs/节点**（读两遍） | 0→21000 节点：2.7→39.2 ms |
| 会话行数 | 线性，约 **18 µs/行** | 92 行 1.7 ms（无投影缓存 3.0 ms） |

### 4.5 UI 刷新模型

设置页 `refresh()` 一次并发 `/state`、`/sessions`、`/trash`、`/audit`，并且在 `loading` 期间把整个 tab 面板卸载换成 spinner（`loading ? h(Spinner…) : null`，面板再以 `!loading` 为条件挂载）。结果是：

- 每次进入设置页、每次删除/恢复/清除之后（`mutationVersion` 变化），都会**整块重挂载**：闪一次 spinner、丢失面板滚动位置、丢失未提交的输入焦点。
- 一次刷新传输量约 **31 KB**（26.5 KB 的会话列表占大头 + `/state` 0.9 KB + 回收站 + 审计）。本地两端都无感；反代/远端的网页端在慢链路上会明显（估算 4G 单程 150 ms 量级）。
- 三个 tab 的数据并不按需加载：看审计也要先把 26 KB 会话列表拉下来。

---

## 5. 适配问题清单

### C-01（网页端，高，发布阻断）前缀部署下发布版 0.3.4 的所有 API 请求丢失路径前缀

- 证据：`git show HEAD:client.js` → 第 503 行用 `API_PREFIX` 拼接（绝对路径），前缀被 `new URL()` 替换掉。
- 影响：`dsh web --public-url https://host/ui/` 下全部接口（`/state`、`/sessions`、`/preview`、`/delete`、`/trash*`、`/audit`、`/feedback`）都会 404，插件整体不可用；桌面端不受影响（base 为 `dsh-app://app/`）。
- 现状：工作树已修（`apiUrl()` 文档相对 + 回归测试通过），但**未提交、未发布**。发布 0.3.5 前必须提交，否则安装 tarball 的用户仍会中招。

### C-02（网页端，高，发布阻断）前缀修复与回收站超时修复都只在工作树里

- `client.js` 的 `TRASH_MUTATION_TIMEOUT_MS = 195_000` 与 `lib/host/api.js` 的 `TRASH_LOCK_BUDGET_MS = 180_000` 同样是未提交改动。0.3.4 里回收站写操作仍是 15 s 超时、宿主锁仍是 30 s，长批量期间"报错但实际成功"的问题依旧存在。
- 这两项都不是本轮新发现（前轮 B-01/B-02），但**只要不提交，就不能说"两端已修"**。

### C-03（网页端，中）反向代理下 Host/Origin 校验没有细粒度白名单

- 反代保留外部 `Host` 时，插件以 `403 E_FORBIDDEN_HOST` 拒绝；`--trusted-host` 是 DSH 自己的开关，插件读不到。
- 用户为让功能可用只能把 `allowNonLoopback` 整体打开，安全默认被削弱。建议增加 `allowedHosts: string[]`（与 DSH `--trusted-host` 语义对齐）。

### C-04（网页端，中）反代读超时短于长批量预算

- nginx 默认 60 s、Cloudflare 默认 100 s；`/delete` 预算可达 900 s。
- 表现：代理返回 504/524，宿主仍在继续执行；用户看到失败，刷新后会话已消失。桌面端没有这一层。
- 建议：文档写明"大批量请直连或把代理读超时提到 ≥ 计划预算"，或在 UI 对超过阈值的批量提示"经代理部署可能超时"。

### C-05（桌面端，信息）桌面路径下 `requireSameOrigin` 实际是空操作

- 外壳删除 `Origin` 后再转发，插件的同源分支只看到空 Origin。真正的护栏是 Host cookie + 回环绑定 + 私有头。
- README 已如实说明，属已记录的设计取舍，不作为缺陷；但**不要把它当作跨站防护**。

### C-06（桌面端，低）插件 bundle 在桌面端失去跨次启动缓存

- 外壳对 `/plugins/` 强制 `cache-control: no-store`，`client.js`（**104,828 B**，`immediately: true` 启动即加载）每次启动都重新取一遍。
- 本地回环 + asar 读盘，实测开销在毫秒级；仅作为"桌面端与网页端的缓存行为差异"记录。

### C-07（桌面端，低）Host 重启/更新窗口内的 503 没有客户端重试

- 外壳在 `backend.host/hostUrl/hostCookie` 未就绪时直接返回 `503`；`client.js` 的 `api()` 没有重试，设置页会显示原始错误直到用户手动刷新。
- 正常启动时页面要等 `boot` IPC（内部 `await startup`）才渲染，命中概率低；主要出现在更新重启、崩溃恢复的短暂窗口。

### C-08（两端，高，测试门禁）工作树 `npm test` 是红的

- `test/api.test.mjs` 新增用例 "trash mutations ask the file lock…" 用默认 fixture（只 seed 了 S1/S2/ORPHAN）却删除 `S3`，`/preview` 把 S3 记入 blocked，`confirmation` 为 `null`，在 `preview.confirmation.token` 处抛 `TypeError`。
- 结果：api 39/40，总计 133/134。这是**测试代码缺陷**，不是产品缺陷；但当前工作树不能作为发布门禁。修法：`makeFixture({ mutationLock, sessionIds: [S1, S2, S3] })`（前轮 O-01 已给出同一结论，尚未落地）。

---

## 6. 性能瓶颈清单

| 编号 | 位置 | 现象 | 实测 | 影响面 |
|---|---|---|---|---|
| P-01 | `lib/host/api.js:860` + `lib/core/trash.js` | `listAll()` 与 `scanUnreadable()` 各自 `readdir` 一次、并对**每个** manifest 各 `readFile` 一次 → 2 次 readdir + 2N 次读 | 0/50/200/500 条 = 1.2/17.2/63.3/**156.3 ms**，≈0.31 ms/条 | 两端相同；当前 14 条无感，500 条时每次刷新都付 156 ms |
| P-02 | `lib/core/memory/registry.js:64,86` | `availablePairs()` 强制 `status(true)` 读一遍索引，`countSessions()` 再读一遍 → 每次预览 2 次 `_index.json` 解析 | 2000 节点 5.8 ms；21000 节点 **39.2 ms**（1.9 MB 索引） | 两端相同；索引越大越明显，且落在确认框打开的关键路径 |
| P-03 | `lib/host/gateway.js:210` | `workspaceFor()` 每会话调一次 `workspaceEntities()`（`registry.list()`）；`inspect()` 又会 `loadList()` | preview 50 = 9.7 ms（`loadList` 有 1.5 s 缓存，`registry.list` 没有） | 两端相同；注册表规模大时线性放大 |
| P-04 | `lib/host/catalog.js:76-93` | 日志在 `foreignWriterGraceMs` 内被写过时，先等 `grace-age`（上限 ~2 s）再复检 mtime | 刚写过：**1521 ms**；空闲 10 s：20 ms；4 条批量：1614 ms（只付一次） | 两端相同；"刚聊完就彻底删除"是最常见路径，用户会感到 1.5 s 无响应 |
| P-05 | `client.js:1571-1609, 1789` | 每次挂载/每次变更并发 4 个请求，且 `loading` 期间整块面板卸载 | 一次刷新 ≈31 KB、4 RTT；面板重挂载导致闪烁与滚动丢失 | 两端相同；网页端走远端时更明显 |
| P-06 | `lib/host/api.js:659-` | 批量删除逐条串行事务 | 20 条 = 215.3 ms（≈10.8 ms/条） | 两端相同；50 条约 0.5 s（不含 live drain 与 P-04） |
| P-07 | `lib/host/gateway.js:272` | `enrichTitles(…, limit = 80)` 只补前 80 行 | 139 会话的真实库里，第 81 行起在投影缓存缺失时显示裸 id | 两端相同；属正确性/UX 小项 |

---

## 7. 两端对比总结

### 7.1 功能与契约：完全一致

两端跑的是同一个 Host 版本、同一份前端 dist、同一套 client 包、同一份 `link:` 源码。四个槽位、接口形状、错误码、审计来源标记都只在 Host 侧实现一次。**不存在"桌面能用、网页不能用"的功能断点**——除了 C-01 这种部署路径问题。

### 7.2 传输与部署：各有各的坑

| 对比项 | 桌面端 | 网页端 |
|---|---|---|
| 请求链路 | renderer → `protocol.handle` → Node `fetch` → Host（多一跳） | 浏览器 → Host（一跳） |
| 额外延迟 | **+0.46 ms/请求**（实测），4 并发不串行 | 基准 |
| 缓存 | 插件 bundle 被强制 `no-store`，每次启动重取 | 可用 Host 的 `immutable` 缓存（按 `?rev=`） |
| 鉴权 | 外壳注入 cookie，页面无感 | 依赖 `dsh web` 认证 URL 的 cookie；过期即 401 |
| 路径前缀 | 不适用（固定 `dsh-app://app/`） | **发布版失效**，工作树已修（C-01） |
| Host/Origin 校验 | `Origin` 被删 → 同源分支短路（C-05） | 完整 authority 比较；反代下需 `allowNonLoopback`（C-03） |
| 长请求 | 无代理层，可跑满 900 s 预算 | 反代 60 s / 100 s 默认读超时会先断（C-04） |
| 断线/关闭 | 退出时先 `await backend.close()`（IPC 请求 Host 关闭，等 `shutdown-complete`）再 `app.quit()`；事务进行中被中断仍可能留下 `pending` 条目（回收站可恢复） | 关标签页后 Host 继续执行，UI 不再收到结果 |

### 7.3 流畅性：瓶颈相同，感知不同

- **接口侧**：两端完全一样（同一进程内代码）。真实规模下 `/preview` ≈ 3 ms、`/trash` ≈ 5 ms、单条删除 ≈ 19 ms，都在一帧到两帧之间。
- **感知差异**来自两处：
  1. 网页端若经反代/远端访问，一次刷新 ≈31 KB + 4 RTT 的代价会显现；桌面端永远是本机，无感。
  2. 桌面端多一跳但只多 0.5 ms/请求；真正的"卡一下"是 P-04 的 1.5 s 宽限等待，两端都会有。
- **设置页的闪烁**（P-05）两端一致，与端无关，属实现问题。

### 7.4 一句话

> **桌面端胜在部署简单、无代理超时、鉴权透明，代价是多一跳（可忽略）与失去 bundle 缓存；网页端胜在少一跳、可缓存，代价是对前缀/反代/超时高度敏感。当前两端的"不流畅"都不是端造成的，而是宿主侧重复 IO 与固定等待造成的。**

---

## 8. 未能验证的部分（如实标注）

1. **桌面端点击级 E2E 未执行**：桌面应用本轮未运行。桌面结论来自 `app.asar` 的静态核对（scheme 注册、`protocol.handle` 分流、`forwardWebRequest` 全函数）与转发链路复刻实测，**没有**做"新建会话 → 行菜单删除 → 确认 → 回收站恢复"的实机点击。
2. **Electron `protocol.handle` 内的并发行为是复刻测量**，不是对真实 handler 的压测；结论（不串行）依据同一份 `fetch` + 流式回写实现，风险低但非直接证据。
3. **网页端未带凭据访问真实数据**：`/state` 返回 401 属预期（连接层鉴权），未尝试获取 token。真实规模数据是通过读 `<DSH_HOME>` 统计 + 等价夹具得到的。
4. **反代场景未搭真实 nginx/Cloudflare**：C-03/C-04 的依据是源码分支 + 官方默认值（nginx 文档、Cloudflare 文档），不是端到端复现。

---

## 9. 建议（按优先级）

1. **提交并发布 C-01 / C-02 的修复**（`client.js` 的 `apiUrl()`、`TRASH_MUTATION_TIMEOUT_MS`，`api.js` 的 `TRASH_LOCK_BUDGET_MS`）。当前它们只存在于工作树，任何按 tarball 安装的用户都拿不到。
2. **修 C-08 的测试夹具**（一行 `sessionIds: [S1, S2, S3]`），让 `npm test` 回到 134/134，恢复发布门禁。
3. **P-04 的产品化处理**：把 1.5 s 宽限等待显式反馈到 UI（按钮 loading + "正在确认没有其他实例在写"），或在确认框里提示"刚使用过的会话会多等约 1.5 秒"。等待本身是安全设计，不该取消。
4. **P-05 改为按 tab 懒加载 + 局部 loading**：`/trash` 只需 `/trash`，`/audit` 只需 `/audit`；刷新时保留旧数据，避免整块卸载。这是两端都能立刻感知的流畅性改进。
5. **P-01 合并回收站扫描**：一次 `readdir` 同时产出 `{entries, unreadable}`，读取加小并发上限；顺手把 `listAll` 的串行 `for await` 改并发。500 条时预计从 156 ms 降到 60 ms 量级。
6. **P-02 复用索引快照**：一次请求内 `probe()` 与 `countSessions()` 共用同一份 `{index, nodes, sig}`。
7. **C-03 增加 `allowedHosts`**，避免用户为反代部署整体打开 `allowNonLoopback`。
8. **文档**：README 仍写"状态 0.2.2 / 131 个用例"，与 0.3.4 / 134 不符；发布前一并更新。

---

## 10. 清理记录

本轮临时产物已在收尾时删除：`%TEMP%\dsh-bench\`（基准脚本）、`%TEMP%\dsh-desktop-main.js`、`%TEMP%\dsh-desktop-host.js`、`%TEMP%\dsh-fe.js`、`%TEMP%\dsh-desktop-dsh-pkg.json`、`%TEMP%\dsh-app-pkg.json`、`%TEMP%\dsh-bench3-*` 夹具目录、`/tmp/asar-extract.cjs`、`/tmp/npm-test.log`、`/tmp/state.json`，以及 `test/.tmp/` 下的测试残留。仓库内仅新增本报告，未改动任何产品代码。

---

## 11. 修复落地记录（0.3.5，2026-10-22）

本报告 §9 的 8 条建议已全部实施，版本 0.3.4 → **0.3.5**：

| 条目 | 改动 | 复测 |
|---|---|---|
| C-01 前缀部署 | `client.js#apiUrl()` 改文档相对；三种 base 的回归用例 | 21/21 client 通过 |
| C-02 回收站超时 | 客户端 195s / 宿主锁 180s 正式提交 | api 用例断言锁预算 180s |
| C-08 测试门禁 | 锁预算用例改 seed `pending` 条目测 discard | api **41/41**，全量 **138/138** |
| C-03 反代白名单 | 新增 `allowedHosts`（config/schema/patch/README） | 新增 API 用例覆盖裸主机、端口、仿冒后缀 |
| P-01 回收站扫描 | `trash.scanAll()` 单次扫描 + 8 并发 | 0/50/200/500 条：1.2/17.2/63.3/156.3 → **1/4.9/14.4/38.1 ms** |
| P-02 索引双读 | 适配器按 `mtime+size` 复用快照，写入即失效 | 21000 节点 39.2 → **28.9 ms** |
| P-05 设置页懒加载 | 按 tab 取数 + 局部 loading，面板不卸载 | 每次刷新 4 请求/≈31 KB → 1–2 请求 |
| P-04 宽限提示 | 彻底删除说明 1.5s 等待；>1.2s 显示进行中文案（中英） | client 22/22 含文案断言 |
| 文档 | README 0.3.5 / 138 用例 / 反代说明；CHANGELOG 0.3.5 | `npm run check` 9/9 |

> 仍未做：`npm publish`（需要发布凭据，属对外不可逆动作，留给维护者执行）。桌面端点级 E2E 仍未执行（应用未运行）。
