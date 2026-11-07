# dsh-supergroup 交接说明（给代理人）

> 这是 v1.1 的设计与交接记录，供后续维护者参考，非安装文档。
>
> 生成时间：2026-11-07 03:40（本地）。交接人：Lead。
> 你的角色：接管**设计思路与方案产出**。Lead 保留「向执行会话派单、接收你的请求、监督执行」。代码修改一律由执行会话完成，你与 Lead 都不直接改代码（除非用户另行授权）。

---

## 1. 这是什么

`dsh-supergroup`（侧栏名「超级代理部署」）是 DeepSeek Harness 的多会话编排插件：

- 一个**主会话（lead）** + 若干**执行会话（members）** = 一个「整体」；
- 主会话按 `sessionId` 派工，投递时生成 `requestId`，宿主把它作为 `source.rpcId` 写进目标会话的 `user/message`，因此结果能**按 rpcId 精确回收**，不靠「猜下一个回复」；
- 名单与工单账本落盘，**重启后自动对账**（拉取历史证据收敛），永不自动重发；
- 侧栏面板支持：创建整体、改名、增删成员、解散整体、折叠批量/空白会话、打开会话。

## 2. 两个目录，别搞混

| 用途 | 路径 | 说明 |
|---|---|---|
| **开发/运行中** | `<你的工作区>/dsh_multisession_stage23` | 当前 profile 里跑的就是它；数据在 `data/`；旧测试基线 147/147 |
| **发布仓库** | `<你的工作区>/dsh-supergroup` | git 仓库，干净树，`data/`、`beifen/` 刻意不入库；已发布到代码托管平台 |

发布仓库 = 开发目录的裁剪发布版（去掉旧 `plugin.mjs` 与内部数据）。改代码时两边要同步：先在开发目录改并测，再同步到发布仓提交。

发布仓使用 MIT 协议；已有 `v1.0.0`、`v1.0.1` 与对应的 Release。仓库地址与账号信息不写进本文。

## 3. 安装的两条路（v1.1 要修的就是这里）

**现状根因（已核实）**：DSH 的「已安装插件」列表来自 profile 的 `<你的 DSH_HOME>/profiles/<profile>/package.json` —— 每个插件既在 `dependencies` 里，也在 `dsh.profile.bundles` 里。而本插件早期只有 profile `cordis.patch.yml` 里一条**手写 insert**（`id: dsh-big-fat-fish`，`name: file:///.../src/plugin2.mjs`），不是依赖、不在 bundles → 列表里永远不出现。

**路 A（当前推荐）**：作为包安装 —— `dsh plugin --profile <profile> add "file:<绝对路径>/dsh-supergroup"`，确保它进入 `dependencies` 与 `dsh.profile.bundles`，由 `dsh.bundle.patch` 装载。这样才会出现在列表里、可升级可卸载。
**路 B（仅临时试用）**：手写 insert，能用，但不在插件列表里（这是设计使然，不是 bug）。

**身份一致性要求**：管理器用「包名 = 它自己 patch 插入的 id」认身份（`dshmarket/lib/entry-identity.js:26` 的 `bundlePatchInsertedIds`）。所以 patch 的 insert id 必须是 `dsh-supergroup`，不能是 `dsh-big-fat-fish`。当前运行中的旧 id 是历史遗留。

## 4. 代码结构（文件级）

宿主半 `src/plugin2.mjs`（入口，`inject: ['tools','commands']`）：

- 工具：`ms2_status` / `ms2_dispatch` / `ms2_group` / `ms2_members` / `ms2_resolve`，输出 `{status, summary, data}`，`render` 把 data JSON 附在文本里（>4000 字截断）。
- 命令：`/ms2 panel`（面板拉数据）、`/ms2 create {json}`、`/ms2 group rename`、`/ms2 group members`、`/ms2 dissolve`（命令返回文本在 `result.value.result.text`）。
- 权限：`ctx.root.get('tools').guard` 做成员拦截（成员禁用 `ms2_*` 与跨会话工具，业务工具照常）；只有整体 lead 能派工/改名/删改成员/解散。
- 归集：`session/event` 监听（快路径）→ 失败时改为**拉取对账** `reconcileTasks()`（`sessionController.page(...)`，冷安全、只认 rpcId 精确匹配 + 同回合 `turn/end`）；启动时 `waitForHistoryController`（50×200ms 有界等待）后自动对账。
- 幂等：启动对账 / `ms2_status` / `/ms2 panel` 三个时机触发，按「已结算」去重。

`src/core/`：

- `registry.mjs`：`SessionRegistry`（lead/members，`replaceMembers()` 原地替换以保 guard 立即生效）。
- `delivery.mjs`：`DeliveryChannel`（`deliver()` 按 requestId 幂等、`markDispatching/unmarkDispatching` 让在途 id 也算「自己人」）、`ResultTracker`（track/observe/forget/outstanding）。
- `coordinator.mjs`：任务表（`queued/delivered/uncertain/completed/failed/canceled`）、`observe()`（含「人类插话」判定：非本工单 rpcId 的 user 消息 → `needs_human` + 留证）、`reconcileFromHistory()`、`resolveHuman()`、`recover()`（重启把未结算标 uncertain，绝不重发）、`recoveryPlan()`。
- `groups.mjs`：`GroupsStore`（`groups.json` v2，原子落盘；`create/rename/updateMembers/dissolve`；从旧 `registry.json` 迁移）。
- `ledger.mjs`：`TaskLedger`（JSONL 追加，**必须串行排队写**，否则 settled 会排到 dispatch 前面导致重放丢失）。
- `roles.mjs`：`CROSS_SESSION_TOOLS` 与角色策略（成员禁跨会话工具）。
- `status-view.mjs`：面板五态判定（会话空闲/任务完成/消息待投递/执行失败/等待人工），`completed` 必须有匹配 receipt 否则转 `needs_human`。
- `turn-admission.mjs`、`invocation-budget.mjs`：回合准入与调用配额（保留能力，未在 UI 暴露）。

客户端 `client/client.js`：**经典脚本**（`window.__ModuleLoader__.load({id, factory})`，只能 `require` 平台种子模块），成对注册 `sidebar.panellist`（id `dsh-supergroup`）+ `main`（同 id）；面板左右分栏；「创建整体」三步向导；卡片「编辑」「解散」；两个折叠勾选（批量会话、空白会话）；会话显示「标题 + 短灰 ID」。

## 5. 数据文件（v1.1 起默认 `%DSH_HOME%/supergroup`；下表为开发目录旧位置）

| 文件 | 内容 |
|---|---|
| `registry.json` | 旧版名单（已迁移，保留） |
| `groups.json` | **真名单**：`{version:2, groups:[{id,name,lead,migrated,members:[{sessionId,label,roleClass,tools}]}]}` |
| `tasks.jsonl` | 工单账本，事件：`dispatch / settled / human / resolve / uncertain / adopt`；`settled` 带 `source`（`history-reconcile` 或 `history-reconcile-after-restart`） |
| `session-events.log` | 观测日志（每事件一行 `{at,sessionId,type,turn}`，256KB 封顶） |
| `blank-candidates.csv`、`archive-report-*.jsonl` | 空白会话归档清单与报告（归档已被用户取消，脚本保留） |

当前有**两个整体**（以 `ms2_status` 输出为准，文档不写死）：整体 A、整体 B。合计 **4 个执行成员、6 个会话**（2 个 lead + 4 个成员）。

## 6. 怎么用（给用户/主会话的调用方式）

```
ms2_status   {"request":"{\"action\":\"list\"}"}
ms2_dispatch {"request":"{\"group\":\"整体 A\",\"memberId\":\"session-...\",\"text\":\"<工单正文>\"}"}
ms2_group    {"request":"{\"action\":\"create\",\"name\":\"整体名\",\"lead\":\"session-...\",\"members\":[\"session-...\"]}"}
ms2_members  {"request":"{\"group\":\"整体名\",\"request\":\"list|add <id>|remove <id>|lead <id>\"}"}
ms2_resolve  {"request":"{\"requestId\":\"<ms-...>\",\"action\":\"accept|fail\"}"}
```

工单结果不必轮询等待：结算在**启动 / 调 `ms2_status` / 面板刷新（`/ms2 panel`）** 三时机自动发生。

## 7. 测试与验证基线

- `node --test tests/*.test.mjs`（使用 `<你的 DSH_HOME>/dsh-runtimes/.../node` 或任意 Node 22+）→ 发布仓当前 **146/146**；开发目录旧基线 147/147。
- 任何改动必须：`node --check client/client.js`、全套测试全绿、真机验证（重启后看账本出现 `settled`）。

## 8. 已知问题与坑（都踩过）

1. **改宿主代码必须完整退出 DSH（含托盘）再启动**，刷新页面无效、ESM 不热重载。
2. `ctx.tools.register` **只收一个完整定义**，执行体挂在 `definition.execute`；写成 `register(def, handler)` 会报 `tool.execute is not a function`。
3. 命令返回结构是 `{ok, value:{result:{kind,text}}}`，文本在 `value.result.text`（外层没有 text）。
4. 面板早期每 3 秒轮询会往会话日志写 `command/run`，渲染进程曾涨到 4.6GB → 现为手动刷新 + 可选 30s + 仅页面可见时轮询，**不要加更密的定时器**。
5. `session/event` 监听器在真机上**只收到主会话自己的事件**（别的会话的事件进不来），所以才改成拉取对账；不要再指望调 `global` 修好它。
6. 重启时 `recover()` 会先把 delivered 标 `uncertain`，对账必须同时处理 `uncertain`（已实现）。
7. 「后一单消息先到收件箱 → 前一单被判人类插话」的竞态：靠 `markDispatching` 覆盖在途 id 解决。
8. `label` 曾落盘成裸 sessionId（创建路径修过、编辑路径漏过，已补）。
9. profile `cordis.patch.yml` 曾两次被回退/被升级器 `sanitizeProfile()` 改名成 `.bak-<ts>`（插件条目全丢）→ 升级或异常后先看这个文件；保留一份带时间戳的备份并记录哈希。
10. 通道限制：部分第三方 API 端点会 TLS 握手超时；部分 Web API 会被 WAF 返回 429；**超大请求体**（约 12.5MB 会话、256k maxTokens）易触发 `TRANSPORT` 断流。
11. 某些非标准会话 id 不是 `session-<uuid>` 形式，侧栏不显示（用户选择「保持现状」）；插件内部用字符串寻址，不影响派工。

## 9. v1.1 计划（用户已确认方向：修「不在已安装插件列表」）

1. **幂等守卫**：`apply()` 若已存在同名实例则跳过并留痕，防止 insert + bundle 双加载导致工具重复注册。
2. **默认数据目录**：三个路径默认落到 `$DSH_HOME/supergroup/{registry.json,groups.json,tasks.jsonl}`，config 显式给了才覆盖（装成包后可零配置运行）。
3. **身份统一**：patch insert id 改 `dsh-supergroup`；`package.json` 补 `dsh.bundle.patch`、`displayName`；`files` 含 patch。
4. **包安装路径**：`dsh plugin add "file:<绝对路径>/dsh-supergroup"` + 加进 `dsh.profile.bundles`，删手写 insert；迁移旧数据文件。
5. **（可选）npm 发布**：让外部用户 `pnpm add dsh-supergroup` 即可，README 主推包安装，手写 insert 降为开发用。
6. 之后才是 v3 候选：主会话转移、成员工具白名单、整体批量操作。

## 10. 发布流程与凭据

- 凭据通过环境变量或凭据文件提供，不要写进 git；不要索取、记录、转述密码或 token。
- 发布流程：改代码 → 测试全绿 → 同步发布仓 → 提交（Conventional Commits）→ `git push` → `git tag -a vX.Y.Z` → 推 tag → 建 Release（附说明）→ 在相关 issue 回帖。
- 发布、打 tag、建 Release 都是对外可见操作，必须由用户确认后再做。
- 已知 issue：安装后不激活（三处根因已确认，v1.0.1 已修）。

## 11. 协作协议（重要）

- **你（代理人）**：产出设计方案、技术判断、验收标准、风险清单；可以直接读代码/日志/文件做调研；**不直接改代码、不改 profile、不重启宿主、不装依赖、不联网**（需要时向 Lead 提请求）。
- **Lead**：把你的方案转成工单派给执行会话，并监督：测试是否全绿、是否越权改 profile、是否把「单测通过」说成「真机通过」。Lead 也会把你发现的问题回报给用户。
- **执行会话**：唯一执行代码修改的会话。工单要求写清范围、验收标准、禁止事项（不联网/不装依赖/不改 profile/不重启宿主）。
- **用户**：最终决策者（发布、升级、改 profile、对外发消息都要用户点头）。
- 汇报纪律：不采信「已完成」的自述，要用账本 `settled`、`git log`、测试输出、文件哈希复核。

## 12. 值得先读的文件

```
<你的工作区>/dsh_multisession_stage23/src/plugin2.mjs
<你的工作区>/dsh_multisession_stage23/src/core/{groups,coordinator,delivery,ledger,registry,roles}.mjs
<你的工作区>/dsh_multisession_stage23/client/client.js
<你的工作区>/dsh_multisession_stage23/docs/{status_summary,usage_manual,v2_group_edit,w13_archive_script}.md
<你的工作区>/dsh-supergroup/{README.md,package.json,cordis.patch.yml}
<你的 DSH_HOME>/profiles/<profile>/{package.json,cordis.patch.yml}
```
