# AUDIT 索引（历史快照 ≠ 当前状态）

`AUDIT-*.md` 是**某一时点**的审查快照，写于对应日期所装的 dsh 版本与插件版本之上。
它们记录的是"当时发现了什么、当时修了什么"，**不能用来判断当前代码是否还有该问题**。
把历史 AUDIT 当检查清单逐条核对，最典型的后果是把已经修好的项当成未修项（例如
`r2.log` 里那条 `state: adapter diagnostics are redacted before they cross HTTP` 当时为失败，
现在已通过）。

## 当前状态的唯一判定顺序

```bash
npm run check            # 语法 + manifest
npm test                 # 全部套件（失败不中断，见 scripts/run-tests.mjs）
npm run check:host-api   # 静态契约：本机所装 dsh 是否仍与插件的用法一致
npm run check:host-runtime  # 运行态：插件是否真的挂载并应答（需要会话，见下）
```

前三条都不需要运行中的 Host。第四条需要一个真实 Host：

```bash
node scripts/verify-host-contract.mjs --launch=<桌面端 Host 启动 URL>
node scripts/verify-host-contract.mjs --cookie="dsh-auth-…=…"
node scripts/verify-host-contract.mjs --cookie-file=<导出的 cookie 行文件>
node scripts/verify-host-contract.mjs --token=<`dsh web` URL 里的 token>
```

桌面端不发 token：它用启动 URL 换一个 authority 绑定的 cookie（`authenticateWebHost`
在 Electron 主进程内完成），所以 `--launch` 是桌面载体上唯一可用的自检入口。

## 快照清单（全部为归档）

| 文件 | 日期 | 覆盖 | 状态 |
| --- | --- | --- | --- |
| `AUDIT-2026-10-17-desktop-web.md` | 2026-10-17 | 桌面端 / 网页端首轮 | 归档 |
| `AUDIT-2026-10-19-desktop-web-recheck.md` | 2026-10-19 | 上轮复检 | 归档 |
| `AUDIT-2026-10-19-review.md` | 2026-10-19 | 代码评审 | 归档 |
| `AUDIT-2026-10-20-last3-versions.md` | 2026-10-20 | 近三个 dsh 版本 | 归档 |
| `AUDIT-2026-10-21-desktop-web.md` | 2026-10-21 | 桌面端 / 网页端 | 归档 |
| `AUDIT-2026-10-21-optimization.md` | 2026-10-21 | 性能与结构 | 归档 |
| `AUDIT-2026-10-22-desktop-web-compat.md` | 2026-10-22 | 兼容性 | 归档 |
| `AUDIT-2026-10-24-desktop-web-rc3.md` | 2026-10-24 | 桌面端 / 网页端 | 归档 |
| `AUDIT-2026-10-29-desktop-web.md` | 2026-10-29 | 桌面端 / 网页端 | 归档 |

## 2026-11-14 这一轮的口径

那一轮审查跑在 `@deepseek-ai/dsh-desktop 0.2.2-rc.3`（桌面端，内含
`@deepseek-ai/dsh-desktop-runtime 0.2.2-rc.3`）与插件 `v0.3.22` 上，结论内联在当次会话里，
没有另开 AUDIT 文件。它的可复跑部分已经固化进上面四条命令：

- `npm run check:host-api` 承担原来靠人肉比对的契约核对（路由 kind、handler 签名、
  `__ModuleLoader__`、`<id>/client.js`、四个 Slot、engines 范围）。
- `test/api.test.mjs` 的 `desktop shell:` 用例承担桌面转发器的请求头集合
  （`host`/`origin`/`cookie`/`sec-fetch-site` 被删后重新注入 cookie）这一层。
- `test/client-module.test.mjs` 的 `require` 守卫承担"客户端半体不依赖全局 require"，
  针对的是 `dsh-desktop 0.2.2-rc.1` 期间 renderer 报过的那条
  `Uncaught ReferenceError: require is not defined`（当时未能归因到本插件）。

以后再有新一轮审查，**新增一份 AUDIT 文件并在上表追加一行**，同时把其中可复跑的断言
移进上述脚本——文件是记录，脚本才是防线。
