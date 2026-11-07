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
