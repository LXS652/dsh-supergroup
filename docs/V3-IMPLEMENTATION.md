# V3 实现记录：成员自报 `ms2_report`

对应设计：`docs/V3-DESIGN.md`（该文件含真机会话 id、个人路径与账号别名，未纳入本次提交，仅作为本地设计依据）。

## 1. 结论与边界

本次实现让执行会话可以在自己完成、阻塞或失败时主动上报，不必等主会话轮询 `ms2_status` 或刷新面板。上报不替代对账：

- `completed` 先记为 `completed` + `provisional: true`，账本新增 `kind:"report"`；
- 之后事件快路径或历史对账拿到同一回合的 `turn/end completed` 证据，才升级为 `verified: true`；
- `blocked` 转 `needs_human`，`failed` 直接失败；
- 对账仍然只接受历史里的 `turn/end completed` 证据，不会因为“成员说完成”就跳过复核；
- 全部路径只读历史/改状态，不重发任何消息。

## 2. 改动文件

| 文件 | 改动 |
| --- | --- |
| `src/core/ledger.mjs` | `KINDS` 增加 `report`；`rebuildTasks` 支持 `report`，恢复 `provisional` / `verified` / `reportKey` / `reportDetail`；dispatch 初始化这三个字段；settled/human/resolve 清理 provisional；settled 恢复 `supersededBy`。 |
| `src/core/coordinator.mjs` | 新增 `report()` / `#reportNow()`、`REPORT_STATUSES`、`reportFailure()`、`reportKeyOf()`；`#settleTask` 升级为 verified 并支持 `supersededBy`；`reconcileFromHistory` 接受 provisional completed，仅 completed 证据可升级。 |
| `src/core/delivery.mjs` | 新增 `REPORT_HINT`；`buildPromptRequest` 在正文未包含 `ms2_report` 时追加固定提示。 |
| `src/plugin2.mjs` | 新增 `ms2_report` 工具；成员 guard 精确放行 `ms2_report`；`groupsSnapshot` 增加 `provisional` 计数；`reconcileTasks` 候选集加入 provisional completed。 |
| `client/client.js` | 整体卡片增加「未核实 N」提示（`group.provisional`）。 |
| `tests/coordinator-report.test.mjs` | 新增 12 条上报状态机/边界测试。 |
| `tests/plugin2.test.mjs` | guard 精确白名单断言；dispatch 正文包含提示的断言。 |
| `tests/delivery.test.mjs` | 派工正文追加 `REPORT_HINT` 的断言。 |
| `README.md` / `docs/usage_manual.md` | 补充成员上报入口、权限例外与 `provisional` 语义。 |

## 3. 与设计章节的对应

### §2 工具与参数

- 工具名 `ms2_report`，参数仍是家族统一的单字符串 `request` JSON；
- 字段：`status`（completed/blocked/failed）、`summary`（1–2000 字符）、`detail`（序列化 ≤8KB）、`requestId`（可选非空字符串）；
- 身份只取 `exec.agent.id`，模型传入的任何 session 字段都不采信；
- 候选集恒先过滤 `task.sessionId === caller`，再按 `requestId` 在自己的单里消歧；不存在“按 requestId 查全局工单”的路径。

### §3 权限面

- `member` 分支只对 `exec.name === 'ms2_report'` 豁免 `ms2_` 前缀拒绝；`ms2_report_v2`、`ms2_status` 等仍被拒；
- 没有改 `src/core/roles.mjs` 的 `CROSS_SESSION_TOOLS`；
- guard 豁免后仍走整体策略检查，因此显式 allowlist 仍可进一步限制成员工具面。设计稿写的是 guard 直接 return；这里保留策略层是刻意偏离，理由见 §5。

### §4 账本

新增事件：

```json
{"kind":"report","requestId":"...","sessionId":"...","status":"completed","summary":"...","detail":{},"turn":7,"source":"member-report","reportKey":"..."}
```

- `reportKey = sha256(sessionId | requestId | turn | status | summary | detailJson)`；
- 同 key 重复 → `duplicate:true`，不追加；
- 不同 key 且已是终态 → `REPORT_CONFLICT`；
- 已 `verified` 再报 → `REPORT_CONFLICT`；
- `needs_human` 下再报 → `REPORT_TASK_STATE`；
- 账本写入失败 → `REPORT_LEDGER_FAILED`，内存状态不变，可重试。

### §5 错误码

`REPORT_BAD_ARGUMENT`、`REPORT_NO_TASK`、`REPORT_AMBIGUOUS`、`REPORT_NOT_MEMBER`、`REPORT_NOT_READY`、`REPORT_TASK_STATE`、`REPORT_CONFLICT`、`REPORT_LEDGER_FAILED`。

参数与身份错误在写账本之前返回；账本只记录成功的上报。

### §6 测试与验收

单测见 `tests/coordinator-report.test.mjs`，覆盖：completed/blocked/failed、幂等、冲突、无在途、自己的 requestId 消歧、别人的 requestId 拒绝、无 requestId 歧义、账本失败、重启后 uncertain 上报、provisional 被 turn/end 升级。guard 精确白名单在 `tests/plugin2.test.mjs`。

本次全套结果：**158 tests / 158 pass / 0 fail**（V3 前 146）。

## 4. 客户端显示

当前面板没有逐工单行，只有整体卡片计数，因此没有“任务行徽标”可挂。实现为整体卡片上的「未核实 N」，数据来自 `groupsSnapshot().provisional`。这是设计 §6 与现有 UI 结构之间的偏离；没有改轮询频率，也没有新增定时器。

## 5. 与设计的偏离

1. **候选集包含 provisional completed**：设计 §2 只列 `delivered`/`uncertain`。为了让“同 key 重复上报”能返回 `duplicate`、让不同 key 的二次上报能明确 `REPORT_CONFLICT`，候选集也接受 `completed && provisional`；终态判断仍在写账前执行。
2. **guard 豁免后仍走策略检查**：设计写的是 guard 命中 `MEMBER_REPORT_TOOL` 直接 return。实现改为“从 `ms2_` 前缀拒绝中豁免，但继续走整体策略的 allow/deny”，避免绕过已有 allowlist。默认角色 deny 为空，因此常规成员可用。
3. **客户端显示为整体计数而非任务行**：见 §4。
4. **兜底提示是固定常量**：`REPORT_HINT` 只在正文不含 `ms2_report` 时追加，不包含 nonce、不构成自由文本通道。

## 6. 重启后真机验收（对应设计 §6.2 A–E）

本进程内不能重启宿主，以下必须重启后人工验：

- **A 主路径时延**：派一张无害单给成员；成员回复后立刻看 `%DSH_HOME%\supergroup\tasks.jsonl`，应出现 `"kind":"report"`，`at` 与成员 `turn/end` 相差秒级；该行 `sessionId` 是成员、`source:"member-report"`、`status:"completed"`；`ms2_status` 里该单 `verified` 在下次对账前仍为 false。
- **B 自愈不变**：派单后让成员回合中断/超时，不重启，直接 `ms2_status`，该单应仍被 `history-reconcile` 结算。
- **C 幂等**：让成员用相同参数连报两次，`tasks.jsonl` 仍只有一行 `report`。
- **D 隔离**：让成员报一个不属于自己的 `requestId`，应返回 `REPORT_NO_TASK`，账本无新增。
- **E 成员权限回归**：成员调 `ms2_status` 仍返回 `MS2_MEMBER_DENIED`；业务工具不受影响。

重启后先看 `plugin.log` 的 `startup` 行确认 `dataDir` 是 `%DSH_HOME%\supergroup`，再看 `tasks.jsonl` 的 `report` 行与 `ms2_status` 的 `provisional` / `verified` 字段。

## 7. v3.1 修复：只让属主 Coordinator 结算

### 根因

`docs/RPCID-ANCHOR-BUG.md` 的结论成立：所有整体共享一个 `ResultTracker`，`handleSessionEvent` 又按 `groups` 顺序把同一条事件喂给每个 Coordinator。非属主整体先调用 `tracker.observe()` 时把 pending 条目消费并删除，但自己的 `#tasks` 没有这张单，只能塞进 `#earlySettled`；而 `#earlySettled` 只在同一 `requestId` 再次 dispatch 时冲刷，工单只派一次，于是永不补写。真正的属主再来时，tracker 条目已经没了。

### 改动

- `src/core/delivery.mjs`：`ResultTracker.observe(sessionId, event, { owns })` 增加归属判定。`owns(requestId) === false` 时直接 `continue`，不锚定、不删除、不返回结算。不传 `owns` 时保持旧行为。
- `src/core/coordinator.mjs`：`observe()` 传入 `owns: id => this.#tasks.has(id) || this.#dispatching.has(id)`；`#dispatching` 覆盖“prompt 已发出、任务行尚未落账”的窗口。保留 `#earlySettled`，但注释明确它是兜底，不是主路径。
- `src/core/coordinator.mjs`：`#record()` 的 `.catch(() => {})` 改为写入 `#writeErrors`（最近 20 条，含 at/kind/requestId/code/message）；新增 `writeErrors()` 快照方法。
- `src/plugin2.mjs`：`ms2_status` 的 data 增加 `writeErrors`，按可见整体聚合后取最近 20 条，并带 `groupId`。
- 测试：`tests/coordinator.test.mjs` 新增 3 条；`tests/plugin2.test.mjs` 新增 1 条（`makeHost({ breakLedger: true })`）。

### 回归证据

- `共享 tracker：第一个整体只跳过，第二整体作为属主才结算`：A、B 共享 tracker 与账本，派单给 B；A 先消费同一组 `user/message + turn/start + assistant/message + turn/end`，断言 `coordinatorA.tasks().length === 0`、B 仍为 `delivered`；B 再消费后断言 `state === 'completed'`、`turn === 5`、`result === 'B 做完了'`，账本只有一条 `settled` 且 `groupId === 'g-b'`。
- `共享 tracker：属主还在 prompt 往返、任务尚未落账时也能结算`：B 的 prompt 回调内同步推完整轮事件，A 先跳过、B 靠 `#dispatching` 认领；`dispatch()` 返回的任务直接是 `completed`、`turn === 6`。
- `账本写失败：writeErrors 留下最近错误而不是静默吞掉`：注入必失败的 ledger，`dispatch` 后 `writeErrors()` 有 `kind:'dispatch'`、`requestId` 与 `disk full` 原文。
- `ms2_status exposes ledger write failures`：用“父路径是普通文件”制造真实落盘失败，轮询 `ms2_status` 直到 data 里出现该错误，并断言带 `groupId`。

### 测试结果

全套 **162 tests / 162 pass / 0 fail**（v3.1 前 158；新增 4 条）。

### 复核说明

`RPCID-ANCHOR-BUG.md` 的结论与推荐方向（归属判定）成立；文中 `plugin2.mjs:354/1110` 等行号随 v3 代码增长已有偏移，不影响语义。本次未修改该文档结论。真实“第二整体走事件快路径”仍需重启后观察：向第二整体派一张已完成单，`tasks.jsonl` 应在 `turn/end` 后出现无 `source` 的 `settled`，而不是等 `history-reconcile`。
