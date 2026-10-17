# 安装与回滚（dsh-conversation-recycle-bin）

本插件只使用 DSH 的公开扩展点：一个 bundle patch 行（Host）+ 一个 `dsh.client` Web 半（Client）。不需要 pnpm 安装依赖、不需要构建步骤。

- 包目录：`D:\Users\34332\AI\dsh-conversation-recycle-bin`
- 宿主 profile：当前 GUI 实际使用的 profile。本机实测为 `C:\Users\34332\.dsh\profiles\desktop`；若你在其他 profile（例如 `profiles\web`）里使用，`install_bundle` 也必须在该 profile 对应的会话中执行。
- 数据目录：`<DSH_HOME>/delete-conversation/`（默认 `C:\Users\34332\.dsh\delete-conversation`）。目录名沿用旧插件名，改名不会迁移已有回收站/审计数据，这是有意为之；不要因为插件改名去重命名该目录。

## 1. 安装（推荐：Plugin Manager）

在 DSH 会话中执行（需要 danger-full-access 或批准）：

```text
plugin_manager action=install_bundle target="D:\\Users\\34332\\AI\\dsh-conversation-recycle-bin"
```

`install_bundle` 会完成：登记 profile 的 `dsh.profile.bundles`、解析本地包、按 `dsh.bundle.patch` 插入 Host 行、由 `dsh.client` 提供 Web 半。不要手写 profile 的 `package.json` 或 `cordis.patch.yml` 来代替它。

安装结果以返回的 `application` 与 `warnings` 为准：

- `applied`：已生效（新的 bundle 通常经 HMR 激活）；
- `restart-required`：重启 DSH 后生效；
- `failed` / `overridden`：先诊断，不要重复安装。

## 2. 安装后验证

### 2.1 Host 行与服务

```text
cordis_inspect_query platform=host provider=Config method=listConfigs name=dsh-conversation-recycle-bin
```

应能看到 `conversation-recycle-bin` 行。该行的 `status` 为 `absent` 属于预期：本插件不导出 `Config` schema（不想依赖 schema 运行时），配置在 `apply()` 内由 `normalizeConfig` 校验，`cordis.patch.yml` 给出默认层。

### 2.2 HTTP API

浏览器或同源请求访问：

```text
GET http://127.0.0.1:<Web 端口>/conversation-recycle-bin/api/state
```

端口以当前 GUI 地址栏为准（本机最近为 `8080`）。

预期 `{"ok":true,"state":{...}}`，其中 `state.memory.adapters` 应显示 `lingshu available: true`（若本机存在 `.dsh-memory/data/mdcg`）。命令行走 `Invoke-WebRequest` 时若被同源策略拒绝属于预期；用浏览器 DevTools 或页面内请求验证。

### 2.3 UI 槽位

```text
cordis_inspect_query platform=client provider=Slots method=listSubTree input={"root":"sidebar.workspaces.session.menu.item"}
cordis_inspect_query platform=client provider=Slots method=listSubTree input={"root":"conversation.session.header.actions"}
cordis_inspect_query platform=client provider=Slots method=listSubTree input={"root":"settings.section"}
```

应出现 `registrant` 为 `conversation-recycle-bin`、id 为 `conversation-recycle-bin`、order 分别为 500 / 100 / 1300 的占用。

### 2.4 手工验收清单（需要浏览器）

1. 会话列表「…」菜单出现「删除对话…」，点击弹出确认框；
2. 确认框默认「移入回收站」+ 记忆复选框未勾选；勾选后条数文案变化；
3. 单个会话软删除：条目消失、设置页「回收站」出现条目；
4. 回收站恢复：会话与记忆回到原位；
5. 彻底删除：无需输入，点击删除按钮直接执行；回收站「永久清除」才需输入 `DELETE`；
6. 批量删除：勾选 2 个以上会话，批量**软删除**必须输入数量；批量彻底删除无需输入；超过当前有效上限（`min(maxBatchSessions, 本分钟剩余额度)`）时按钮禁用并提示上限，超过限流返回可读的 429 文案；
7. 无权限：对未登记工作区的会话，确认框显示不可删除原因；
8. 设置页「审计留痕」能看到成功/失败/回滚记录；
9. 若回收站下方出现「未完成条目」，点「清理」并输入 `DELETE` 应移除该条目；仍持有会话日志的条目会被拒绝并提示改用恢复/彻底删除。

> 无法控制浏览器时，安装与槽位注册只能证明「入口已挂载」，不能证明视觉效果；请如实记录这一限制。

## 3. 回滚

### 3.1 移除插件（推荐）

```text
plugin_manager action=remove_bundle target=dsh-conversation-recycle-bin
```

返回 `restart-required` 时重启 DSH。移除后：

- 会话数据不受影响（插件从不删除未被用户确认的会话）；
- 插件自己的数据目录**保留**：`<DSH_HOME>/delete-conversation/`。确认不再需要回收站后，可手动删除该目录释放空间；
- 如果移除前有未恢复的 hard 删除条目，先执行恢复：`POST /conversation-recycle-bin/api/trash/restore`（或先在 UI 恢复），否则该目录删除后无法再通过插件恢复。

### 3.2 手工回退（仅在 Plugin Manager 不可用时）

1. 从 `<DSH_HOME>/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 中移除 `dsh-conversation-recycle-bin`；
2. 删除/移除 profile `node_modules` 下对应的链接（若存在）；
3. 若曾手工编辑 `cordis.patch.yml`，删除 `conversation-recycle-bin` 行；
4. 重启 DSH。

不要在 Host 仍持有文件句柄时手工移动 `<DSH_HOME>/delete-conversation/trash/<id>/session/`；用恢复 API 或先停 DSH。

## 4. 升级

1. 修改 `D:\Users\34332\AI\dsh-conversation-recycle-bin`（覆盖安装目录后需重启以加载新的 Host 模块代际）；
2. 运行 `npm test` 与 `npm run check`；
3. 重新 `install_bundle`（或 `set_bundle`）并重启；
4. 升级后用一个**测试会话**跑一次单条软删除 + 回收站恢复，再投入日常使用。

## 5. 故障排查

| 症状 | 原因 / 处理 |
|---|---|
| 菜单/头部/设置页没有入口 | Client 半未激活。检查 `dsh.client` 是否存在、`client.js` 是否可被宿主打包路由加载、`cordis_inspect_query Slots` 是否有 `conversation-recycle-bin` 占用；重启后重试 |
| 入口在但弹出 403 | 请求被同源/loopback 校验拒绝。确认页面地址与 `Host` 头一致；反向代理/远程访问需在配置里显式 `allowNonLoopback: true`（会放宽本机限制，谨慎） |
| `E_POLICY_ORPHAN` | 会话未登记到任何工作区。确属要删时在配置中 `allowOrphanSessions: true`，或先在工作区里登记 |
| `E_POLICY_LIVE` | 配置了 `stopLiveSessions: false` 且会话仍活跃；或插件在 `liveDrainMs` 内无法停住该会话（仍在运行）。改为默认配置，或等该会话空闲后重试 |
| `E_POLICY_FOREIGN_WRITER` | 另一个 DSH Host（桌面端或 `dsh web`）仍在写这个会话日志。先关闭那一端的会话再重试；`foreignWriterGraceMs` 只能降低窗口，不能替代关闭写入方 |
| `memory.adapters` 全部 unavailable | 本机没有可识别的记忆存储；检查 `<DSH_HOME>/.dsh-memory/data/mdcg/_index.json` 是否存在且 `schema === 2` |
| 删除返回 `E_TRANSACTION_FAILED` 且 `rolledBack: true` | 事务已回滚，数据未丢。看审计 `rollback.errors` 定位失败阶段（memory/messages/session） |
| 升级 DSH 后删除失败 | 先跑测试；确认会话目录仍为 `<DSH_HOME>/sessions/<slug>/<id>/`、`_index.json` 仍为 schema 2；必要时在测试会话上验证后再用 |

## 6. 数据与隐私

- 审计日志包含操作时间、会话 id、标题、模式、是否勾选记忆、计数与结果，不包含对话正文；
- 回收站包含被移除的会话日志与记忆正文，位于用户自己的 `<DSH_HOME>` 下；
- 插件不向任何外部服务发送数据。
