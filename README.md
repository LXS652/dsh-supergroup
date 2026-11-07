# dsh-supergroup · DSH 超级代理部署

dsh-supergroup 是 DeepSeek Harness 的一组会话编排插件。它把一个主会话和若干执行会话组成一个「整体」：主会话负责拆解与派工，执行会话各干各的，结果按投递时生成的 `rpcId` 精确回到主会话，不会把别人的输出误当成自己的结果。

侧栏面板可以创建、改名、增删成员、解散整体；名单与工单账本都落盘，宿主重启后会在启动时自动对账，把「投递了但没等到结算」的工单按历史证据收敛，从不自动重发——因为外部副作用可能已经发生了。

安装方式见下方；v1.1 起推荐作为 profile 的 bundle 安装，无外部依赖。

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

v1.1 起推荐把本包作为 profile 的 bundle 安装。只有不装包、临时试用时，才走手写 `insert`。

### 路 A：作为包安装（推荐）

1. 在 DSH 宿主完全退出后，用绝对路径安装：

   ```powershell
   dsh plugin --profile <你的 profile> add "file:<绝对路径>/dsh-supergroup"
   ```

   等价做法：在 profile 目录执行 `pnpm add "file:<绝对路径>/dsh-supergroup"`。

2. 从 1.1 起，必须同时满足以下两条，否则设置 → 插件列表不会显示，或标题退化成一整条 `file://` 路径：

   - profile 的 `package.json` 的 `dependencies` 里有 `dsh-supergroup`；
   - 同一个 `package.json` 的 `dsh.profile.bundles` 数组里有 `dsh-supergroup`。

   `dsh plugin add` 在 1.1.0 实测会自动写入 bundles；若你的 DSH 版本没有写入，手工追加一项。

3. 确认 `node_modules/dsh-supergroup` 存在；必要时在 profile 目录执行 `pnpm install`。

4. 重启 DSH。设置 → 插件列表应出现「超级代理部署」，侧栏面板应能打开；`ms2_status` 应可用。

5. 数据默认落在 `$DSH_HOME/supergroup`。从 1.0.x 升级时，首次启动会按文件冷迁移旧数据，旧目录保留不动。

### 路 B：手写 insert（不装包，仅临时试用）

1. 把本目录放到固定位置，确认入口文件存在：`<你的工作区>/dsh-supergroup/src/plugin2.mjs`。
2. 打开 `~/.dsh/profiles/<profile>/cordis.patch.yml`，在**文件末尾追加**：

```yaml
- insert:
    - id: dsh-supergroup
      name: file:///<你的工作区>/dsh-supergroup/src/plugin2.mjs
      config:
        registryFile: '<你的 DSH_HOME>\supergroup\registry.json'
        groupsFile: '<你的 DSH_HOME>\supergroup\groups.json'
        ledgerFile: '<你的 DSH_HOME>\supergroup\tasks.jsonl'
```

3. 重启 DSH。侧栏应出现「超级代理部署」图标，`ms2_status` 应可用。
4. `name` 必须是**绝对路径**的 `file:///` 形式，并指向**入口文件**；Windows 路径把反斜杠写成 `/`。

> 这条路不会出现在设置 → 插件列表的“已安装插件”里，而且标题会显示整条 `file://` 路径。要可升级、可卸载、有可读标题，请走上面的包安装。

### 不要这样写

- **不要用 `plugin:` 字段**。rc.5 的 patch 结构是 `{ id, insert?, name?, ...overrides }`，`plugin:` 不是入口字段。
- **不要裸写 `- id: dsh-supergroup` 而不包在 `insert:` 里**。没有对应的已有条目时，它会被当成覆盖，宿主只记一条 `patch: entry ... not found` 然后静默跳过。
- **路 B 的 `name` 不要指向目录**，必须指向入口文件 `src/plugin2.mjs`（`file:///` 形式）。

### 从 1.0.x 升级到 1.1.0

1. 数据目录迁到 `$DSH_HOME/supergroup`；首次启动按文件冷迁移 `groups.json`、`tasks.jsonl`、`registry.json`，旧目录保留不动。
2. `$DSH_HOME/supergroup/plugin.log` 会记录启动、单实例锁回收等事件。
3. 删除 profile 里旧的手写 insert 整块（从 `- insert:` 到该块结束），再按路 A 安装。

### 装完没反应怎么查

1. 包安装时，先确认 `dependencies` 与 `dsh.profile.bundles` 同时含 `dsh-supergroup`，且 `node_modules/dsh-supergroup` 存在。
2. 用 `dsh --dump-config` 看最终配置。Desktop 的 profile 可能被 Electron 独占，先复制一份再对副本 dump：

   ```bash
   cp -al ~/.dsh/profiles/<profile> ~/.dsh/profiles/<profile>-probe
   ```

   然后按你的 DSH 版本支持的方式让 CLI 使用 `<profile>-probe`，执行 `dsh --dump-config 2> dump.err`。
3. `grep dsh-supergroup` 检查 dump 输出；若 stderr 出现 `patch: entry ... not found`，说明路 B 的条目没有进入 `insert:`，或 id 写错。
4. 仍无图标时，确认入口文件存在；路 B 的 `name` 是 `file:///` 文件 URL；并且 DSH 已完全重启（客户端 bundle 不热更）。

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
