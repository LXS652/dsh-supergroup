# 使用手册

本手册面向已经装好插件的使用者。安装与配置见根目录 [README](../README.md)。

## 1. 整体、主会话、成员

- **整体（group）**：一组会话的协作单位，有名字、主会话（lead）和最多 8 个成员。
- **主会话**：创建整体时指定的会话。只有它能派工、裁决、改名、改成员、解散。
- **成员**：接收工单的执行会话。成员不能调用 `ms2_*` 协调工具（唯一例外是 `ms2_report`，只能上报自己名下的在途工单），也不能使用跨会话工具；普通业务工具不受影响。
- 同一个会话可以同时属于多个整体，在不同整体里扮演不同角色。工单按整体隔离，A 整体的结果不会被算进 B 整体。

## 2. 创建整体

### 面板

1. 点击侧栏「超级代理部署」图标。
2. 点「创建一个整体」。
3. 选择主会话 → 勾选执行会话 → 填名称 → 提交。

空白会话（`blank === true`）也可以被选进整体；它们会显示为「空白会话 · 短 ID」，并带小字「新会话，尚未开始对话」。

### 命令

```text
/ms2 create {"name":"团队 A","lead":"session-...","members":["session-...","session-..."]}
```

### 工具

```json
{"action":"create","name":"团队 A","lead":"session-...","members":["session-..."]}
```

限制：

- 名称不能为空，不能与已有整体重名；
- 主会话不能同时出现在成员列表；
- 成员最多 8 个；
- 只有调用者本人可以作为新整体的主会话（工具通道必须能识别调用会话）。

## 3. 派工

主会话调用：

```json
{"group":"团队 A","memberId":"session-...","text":"请完成……"}
```

也可以只传 `memberId`（工单里会记录派发者所在整体）。派工成功后：

- 账本写入一条 `dispatch`；
- 工单状态为 `delivered`；
- 真正的结果不会立刻出现，必须等成员回合结束或历史对账。

同一个 `requestId` 重复派工只会返回同一条工单，不会重复投递。

## 4. 查看状态

```json
{}
```

或：

```text
/ms2 panel
```

`ms2_status` 返回调用者可见的整体、成员、工单、恢复项与对账统计。它同时会触发一次历史对账，因此“打开状态”本身就可能把 `delivered` / `uncertain` 收敛成 `settled`。

面板刷新走 `/ms2 panel`，同样会触发对账。

## 5. 结果与恢复

### 成员主动上报

成员完成（或确认阻塞/失败）后，可以调用 `ms2_report`，不用等主会话轮询：

```json
{"status":"completed","summary":"做了什么、证据是什么","detail":{},"requestId":"可选"}
```

- `completed`：先记 `completed` + `provisional: true`（未核实），账本写 `kind:"report"`；后续 `turn/end` 或历史对账拿到完成证据，才升级为 `verified`。
- `blocked`：转 `needs_human`，等主会话裁决。
- `failed`：直接失败。
- `requestId` 只用于同一会话多单消歧；不填时若有两条以上在途，会返回 `REPORT_AMBIGUOUS` 和候选 id。只能报自己名下的单，报别人的单会得到 `REPORT_NO_TASK`。

### 正常结算

成员收到消息、跑完回合后，插件按 `requestId` 找到对应回合的 `turn/end`：

- `completed` → 工单 `completed`，结果取该回合最后一条可见 assistant 文本；
- 失败/中止 → 工单 `failed`，保留原因。

### 重启后的 uncertain

宿主重启时，`delivered` 工单会先变成 `uncertain`，因为无法确定结果是否已经在重启前产生。启动对账会继续读历史：

- 找到完整 `turn/end` 且 `completed` → 自动结算，保留 `reason: "restart"` 和 `source: "history-reconcile-after-restart"`；
- 找不到证据 → 保持 `uncertain`，原因写入 `observeStats`。

不会为了“催结果”自动重发任何消息。

### 人工裁决

确实无法自动证明的工单，由主会话裁决：

```json
{"requestId":"ms-...","action":"accept"}
```

或 `"action":"fail"`。只有 `needs_human` / `uncertain` 状态可以裁决。

## 6. 编辑整体

### 改名

```text
/ms2 group rename {"group":"g-...","name":"新名字"}
```

### 全量替换成员

```text
/ms2 group members {"group":"g-...","members":["session-a","session-b"]}
```

成员是完整名单，不是增量。lead 不能入列，最多 8 个。被移除的成员如果还有 `delivered` / `uncertain` 工单，整次修改会被拒绝并返回 `requestId`。

面板卡片上的「编辑」提供同样的能力：名称输入框 + 成员复选框 + 保存/取消，错误原文显示在卡片内。

## 7. 解散整体

```text
/ms2 dissolve g-xxxxxxxx
```

面板卡片上的「解散」需要二次确认：第一次点击后按钮变红，显示整体名与人数；再点一次才执行。

解散只做一件事：从 `groups.json` 移除该整体登记并落盘。它**不会**：

- 删除任何会话；
- 删除会话历史或日志；
- 修改 `tasks.jsonl`；
- 停止会话进程；
- 影响其它整体。

有在途工单（`delivered` / `uncertain`）时拒绝解散，并返回具体 `requestId`。先 `ms2_resolve` 或等对账收敛，再解散。

## 8. 权限与隔离

| 操作 | 主会话 | 成员 | 名单外会话 |
| --- | --- | --- | --- |
| `ms2_status` / `ms2_group` / `ms2_members` / `ms2_dispatch` / `ms2_resolve` | 可用（限自己整体） | 拒绝 | 拒绝 |
| `ms2_report` | 可用（限自己整体） | 可用（只能报自己名下的单） | 拒绝 |
| `send_message` / `subagent` 等跨会话工具 | 可用 | 拒绝 | 不受影响 |
| 普通业务工具 | 可用 | 可用 | 可用 |
| 解散 / 改名 / 改成员 | 可用（限自己整体） | 拒绝 | 拒绝 |

成员被移除后，guard 在下一次工具调用时就按新名单生效，不需要重启。

## 9. 排障

| 现象 | 先看 |
| --- | --- |
| 派工后一直 `delivered` | 调用一次 `ms2_status` 或刷新面板，触发历史对账；再看 `observeStats.lastReconcileReason` |
| 重启后工单变 `uncertain` | 启动对账可能还在等待 `sessionController`；看 `observeStats.startupReconcile`，再手动调一次 `ms2_status` |
| 面板看不到整体 | 确认调用者确实是该整体的 lead 或成员；面板数据只返回可见整体 |
| 解散被拒 | 返回里会列 `requestId`；先裁决或等对账 |
| 成员工具突然被拒 | 确认它是否被移出整体，或是否在多整体中承担了不同角色 |
