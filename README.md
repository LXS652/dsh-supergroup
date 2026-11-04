# dsh-supergroup · DSH 超级代理部署

一个 DeepSeek Harness（DSH）插件：把多个持久会话组织成「整体」，按 `sessionId` 寻址派工，用持久账本记录工单，并在重启后用会话历史对账把结果收回来。

它不是一次性子代理调用。整体、成员、工单、恢复状态都落在文件里，宿主重启后仍然存在。

## 能力

- **多整体**：一个 DSH profile 里可以同时存在多个整体，每个整体有独立的主会话、成员名单和工单账本视图。
- **按会话寻址派工**：工单投给确定的 `sessionId`，不依赖标题、昵称或当前选中会话。
- **按 rpcId 回收**：投递时生成的 `requestId` 会随消息进入会话历史；结果按这个 id 精确匹配，不靠“猜下一条回复”。
- **快速结算 + 拉取对账**：`session/event` 能收到的结果走快路径；收不到时，在启动、`ms2_status`、`/ms2 panel` 三个时机读取会话历史补结算。
- **重启自愈**：启动时先恢复账本，再对 `delivered` / `uncertain` 工单做历史对账；有完整 `turn/end` 证据就收敛，没有就留给人裁决。
- **侧栏面板**：会话按工作区分组；创建整体三步向导；整体卡片支持改名、成员增删、解散；空白会话可以选进整体。
- **成员权限隔离**：成员不能调用 `ms2_*` 协调工具，也不能用跨会话工具；业务工具照常可用。主会话（lead）才拥有派工、裁决、改名、改成员、解散权限。
- **绝不自动重发**：对账只读历史、只改状态，不会为了“催结果”再发一条消息。

## 安装

1. 把本目录放到你希望长期保留的位置。
2. 在 DSH profile 的插件 `insert` 配置里加入一个条目，指向本目录的入口 `src/plugin2.mjs`，并配置下面三个文件路径。
3. 重启宿主（或重新加载 profile），侧栏会出现「超级代理部署」图标。
4. 客户端 bundle 不会热更；改完 `client/client.js` 后需要重启宿主才能看到界面变化。

配置示例（把 `<...>` 换成你自己的路径，不要照抄真实用户名）：

```yaml
- id: dsh-supergroup
  plugin: <你的路径>/dsh-supergroup
  config:
    registryFile: <你的 DSH_HOME>/data/registry.json
    groupsFile: <你的 DSH_HOME>/data/groups.json
    ledgerFile: <你的 DSH_HOME>/data/tasks.jsonl
```

`groupsFile` 省略时会跟着 `registryFile` 走，落在同一目录的 `groups.json`；`eventsLogFile` 省略时落在账本同目录的 `session-events.log`。

可选配置：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `startupReconcileAttempts` | 50 | 启动时等待 `sessionController` 注册的最大轮数，夹在 1..50 |
| `startupReconcileIntervalMs` | 200 | 每轮等待毫秒数，夹在 1..200 |
| `bootstrapGroups` | 无 | 首次启动时预置整体，数组项为 `{name, lead, members}` |
| `startupReport` | `false` | 启动时把恢复摘要写到日志 |
| `selfTest` | 无 | 传入对象时运行内置自检 |

## 面板

- 左栏按工作区分组列出会话；「折叠批量会话」「折叠空白会话」两个勾选互相独立。
- 点「创建一个整体」进入三步向导：选主会话 → 选执行会话（可多选，空白会话也可选）→ 填整体名。
- 每张整体卡片显示主会话、成员、工单数与在途数；卡片内可以：
  - 「编辑」：改名、全量替换成员；
  - 「解散」：二次确认后只删除 `groups.json` 里的整体登记，不删除任何会话、历史或账本。
- 有在途工单（`delivered` / `uncertain`）时，解散或移除对应成员会被拒绝，并返回具体 `requestId`。

## 工具

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `ms2_status` | 留空或 `list` | 查看当前调用者可见的整体、成员、工单、恢复项与对账统计 |
| `ms2_group` | `{"action":"create","name":"...","lead":"session-...","members":["session-..."]}` | 创建整体；`list` 列出可见整体 |
| `ms2_members` | `{"group":"整体名或 id","request":"list\|add <id>\|remove <id>\|lead <id>"}` | 查看或增删成员 |
| `ms2_dispatch` | `{"group":"整体名或 id","memberId":"session-...","text":"..."}` | 把一张工单投给成员 |
| `ms2_resolve` | `{"requestId":"...","action":"accept\|fail"}` | 主会话裁决一条等待人工的工单 |

## 命令

命令由客户端面板通过 `ctx.remote.commands.execute` 投到目标会话；命令后的内容是 `rawInput`（不含 `/ms2 ` 前缀）。

```text
/ms2 panel
/ms2 create {"name":"...","lead":"session-...","members":["session-..."]}
/ms2 dissolve <groupId>
/ms2 group rename {"group":"g-...","name":"..."}
/ms2 group members {"group":"g-...","members":["session-..."]}
```

限制：

- 只有整体 lead 能解散、改名、改成员；
- 成员名单是全量覆盖，最多 8 个，lead 不能出现在成员里；
- 被移除成员若有 `delivered` / `uncertain` 工单，整次修改拒绝。

## 结算与恢复

1. `ms2_dispatch` 生成 `requestId`，消息进入成员会话，账本写 `dispatch`，工单进入 `delivered`。
2. 结果回收有两条路：
   - `session/event` 快路径：收到带同一 `rpcId` 的 `user/message` 后，跟随该回合到 `turn/end`；
   - 历史对账：在启动、`ms2_status`、`/ms2 panel` 时读取会话历史，按 `rpcId` 精确锚定。
3. 宿主重启时，`delivered` 会先变成 `uncertain`（不知道结果是否已经产生）。启动对账会继续查历史：
   - 找到 `turn/end` 且 `completed`：结算为 `completed`，保留 `reason: "restart"` 作为证据，`source` 标为 `history-reconcile-after-restart`；
   - 找不到证据：保持 `uncertain`，原因写进 `observeStats`。
4. `uncertain` 也可以由主会话用 `ms2_resolve` 人工 `accept` / `fail`；能自动证明完成的才自动收敛。

## 已知边界

- **对账触发时机**：启动、`ms2_status`、`/ms2 panel`。没有后台轮询；不调用这三个入口就不会主动结算。
- **成员共享文件系统、网络和 `cwd`**：插件只做会话编排，不提供进程、目录或网络隔离。
- **没有外部效果的 exactly-once**：账本保证工单状态可恢复，但成员在完成前执行的副作用（发消息、改文件、调外部 API）无法由本插件回滚；重试前请自行确认幂等性。
- **不自动重发**：对账与恢复只读历史、改状态，不会重投工单。
- **会话必须存在**：派工只按 `sessionId` 投递，不探测该会话是否仍有效；失效会话会在历史对账时表现为找不到锚点。
- **主会话转移**：当前版本不支持，lead 是整体创建时确定的会话。

## 开发与测试

```bash
node --check src/plugin2.mjs
node --check client/client.js
node --test tests/*.test.mjs
```

测试使用临时目录，不会读写你的真实 `groups.json` / `tasks.jsonl`。

## License

MIT。见 [LICENSE](LICENSE)。

---

本项目早期内部名 `dsh-big-fat-fish`，配置条目 `id` 可自行命名，不影响功能。
