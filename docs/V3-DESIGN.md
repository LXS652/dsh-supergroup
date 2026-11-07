# V3 设计：成员自报完成（`ms2_report`）

> 状态：设计稿，未写实现。只读调研产物，未改 `src/`、未跑测试、未改 profile、未重启。
> 依据：`src/plugin2.mjs`、`src/core/{coordinator,delivery,ledger,groups,roles,turn-admission}.mjs`、
> 真机账本 `<你的 DSH_HOME>\supergroup\tasks.jsonl` 与 `session-events.log`（2026-11-07 17:15 取样）。

---

## 0. 先核对前提：事实②要改写

派单里写的是「插件 `session/event` 监听只落在主会话作用域，成员 `turn/end` 进不来」。这条**与账本和事件日志矛盾**，必须更正，否则 V3 会照着错误前提设计。

现场证据（同一份账本，201 行，0 坏行）：

| 事实 | 数值 | 含义 |
|---|---|---|
| `settled` 且无 `source`（事件快路径） | 59 | 事件监听**确实在工作**，且能结算 |
| `settled` 且 `source=history-reconcile` | 12 | 快路径漏了，靠对账补 |
| `settled` 且 `source=history-reconcile-after-restart` | 11 | 重启后降级单 |
| 按会话：`session-150eb4fd…` | 事件 47 / 对账 0 | 主会话派工，快路径稳定 |
| 按会话：`bili-whale` | 事件 12 / 对账 0 | 成员会话，快路径也生效 |
| 按会话：`session-fdac37ee…`（打工人） | **事件 0 / 对账 23** | 同样的成员会话，快路径**一条都没成** |

而 `session-events.log` 里打工人会话有 204 条事件，含 1 条 `turn/end`（08:54:45，turn=28）。也就是说：**事件进来了，监听也跑了，但结算没发生**。

`missReason()` 已经把这个原因写进了日志（`plugin2.mjs:1067-1085`）：

```
2026-11-07T08:50:53.955Z turn/start turn=28 reason=anchor-miss
2026-11-07T08:50:59.270Z user/message turn=null reason=anchor-miss
2026-11-07T08:50:59.272Z user/message turn=null reason=anchor-miss
2026-11-07T08:50:59.274Z user/message turn=null reason=anchor-miss
```

结论：**问题不是「成员事件收不到」，而是「成员会话的 rpcId 锚定会失败」**——`ResultTracker` 要求 `user/message.data.source.rpcId === requestId`（`delivery.mjs:186` 起），打工人会话里这条锚点事件对不上，tracker 永不锚定，后面的 `turn/end` 自然不结算。历史投影里锚点在（所以 09:12:18 对账能拿 turn 28 结算），说明**投影与实时事件对同一个消息的 `source.rpcId` 呈现不一致**——这条根因值得单独立项查，但 V3 不能依赖它修好。

对 V3 的影响：**上报工具必须自带证据（会话身份 + 当前在执行的工单 + turn），不能复用「rpcId 锚点」这条已经证伪的链路。**

派单事实①③④经核对成立：
- ① 成员调任何 `ms2_` 前缀工具被 `plugin2.mjs:1146` 直接拒绝；业务工具不受影响。
- ③ 对账只在 `ready`（`:357`）、`ms2_status`（`:757`）、`/ms2 panel`（`:962`）三处触发；`ms-mw65ylbu` 08:50:53 派、08:54:45 干完、09:12:18 才 settle，中间 17 分钟无人碰状态。
- ④ 事件类型与 `source` 取值与 `ledger.mjs:9`、`coordinator.mjs:266-310` 一致。

---

## 1. 工具面

### 1.1 名字与定位

- 名字：**`ms2_report`**（保留 `ms2_` 家族前缀，便于 guard 与文档统一）。
- 定位：**执行会话**上报「自己名下、当前正在执行」的那一单的结果。不是通用事件通道，不传自由文本给别人。
- 可见性：和现有 `ms2_*` 一样全局注册；成员能不能调由 guard + 工具体双层判定（见 §3）。

### 1.2 参数（沿用家族的单字符串 `request` 约定）

```jsonc
{
  "request": "{\"status\":\"completed\",\"summary\":\"……\",\"detail\":{…}}"
}
```

| 字段 | 必填 | 约束 | 说明 |
|---|---|---|---|
| `status` | 是 | `completed` / `blocked` / `failed` | `blocked` = 需要人裁决（等价现状 `needs_human`）；`failed` = 执行失败 |
| `summary` | 是 | 1–2000 字符 | 给人看的结果摘要；进账本，所以去控制字符 |
| `detail` | 否 | JSON 值，序列化 ≤8KB | 结构化证据（文件、测试输出、哈希）；只落账本，不回传他人 |
| `requestId` | 否 | 字符串 | **仅用于同会话多个在途工单时消歧**；只能命中自己名下的单，不是任意选择器（见 §2） |

不传 `sessionId`：身份只认宿主给的 `exec.agent.id`，模型传什么都不采信。

### 1.3 返回

成功：

```json
{"status":"ok","summary":"已上报 completed（猎手）","data":{
  "requestId":"ms-mw65ylbu-jck67jfd","taskState":"completed","source":"member-report",
  "provisional":true,"turn":28,"duplicate":false
}}
```

重复上报（幂等命中）：`status:"ok"`、`duplicate:true`，**不写第二条账**。

失败：

```json
{"status":"error","summary":"REPORT_AMBIGUOUS: 你有 2 条在途工单","data":{
  "code":"REPORT_AMBIGUOUS","requestIds":["ms-…a","ms-…b"]}}
```

错误码清单与 HTTP 风格语义见 §5.3；**所有错误都在写账本之前返回**，账本里只有成功上报。

### 1.4 与 `ms2_status` 的分工

| | `ms2_status` | `ms2_report` |
|---|---|---|
| 调用者 | 主会话（成员被禁） | 成员（仅此一个 `ms2_` 白名单） |
| 方向 | 拉取 | 推送 |
| 副作用 | 触发对账 | 写一条 `report` 事件 |
| 能否看别人 | 能看自己领导的整体 | 只能命中自己名下的单 |

---

## 2. 身份绑定

### 2.1 目标

- 成员**只能**报自己名下、当前在途的单；
- 不能指定任意 `requestId`，不能给任意会话发文本，不能看到别整体/别人的工单；
- 伪造面要可论证：模型能骗到的上限，不能超过它自己这一轮能产生的文本。

### 2.2 方案 A（推荐）：宿主会话身份 + 单在途反查

```
caller = exec.agent.id                      // 宿主注入，模型不可控
memberships = groups.filter(g => g.registry.get(caller) !== undefined)
candidates = memberships.flatMap(g =>
  coordinator(g).tasks().filter(t =>
    t.sessionId === caller && (t.state === 'delivered' || t.state === 'uncertain')))
```

- `candidates.length === 0` → `REPORT_NO_TASK`
- `=== 1` → 绑定
- `> 1` 且未给 `requestId` → `REPORT_AMBIGUOUS`，只回**自己**的 requestId 列表
- 给了 `requestId` → 先按自己的 candidates 过滤；命中 0 条 → `REPORT_NO_TASK`（**不回**「它属于别人」这种可探测信息）

`requestId` 不是「指定任意工单」，它只是把歧义收敛到自己的单——过滤条件里恒有 `t.sessionId === caller`。若 Lead 要求更严，可去掉该字段，把歧义直接判错、由主会话串行重派。

**伪造风险**：
| 攻击 | 结果 |
|---|---|
| 成员在工具参数里写别人的 requestId | 被 `sessionId === caller` 过滤，报 `REPORT_NO_TASK` |
| 成员谎报 completed 但没干活 | 可以（它就是这个会话的模型），但标记 `provisional:true`，等对账/`turn/end` 复核（§4.3） |
| 别整体/别人的成员调这个工具 | 不是任何整体的成员 → `REPORT_NOT_MEMBER`；是别人整体的成员只能命中自己的单 |
| 非成员会话（普通会话）调用 | `REPORT_NOT_MEMBER`，账本不动 |

这一方案的信任边界与现状一致：**「这个会话说了什么」本来就是它这一轮的产出**，上报只是把它结构化，不新增权限。

### 2.3 方案 B（可选加固）：派工时发一次性 nonce

在 `DeliveryChannel.buildPromptRequest` 的正文尾部追加固定模板（不是自由文本通道）：

```
（完成后调用 ms2_report 上报；本单 nonce: <8 位>）
```

上报时带 `nonce`，插件按 `requestId→nonce` 校验。

- 优点：重启后仍可判定「这条上报对应哪次派发」；能挡住「上一轮遗留的模型复读旧单」。
- 缺点：nonce 进对话正文，模型可能抄错/不抄；不是安全边界（同会话都能看到）；要改投递文案，属于可见行为变化。
- 结论：**V3.0 不做**，等方案 A 在真机跑稳、且出现「跨轮误报」再上。

### 2.4 方案 C（不推荐）：复用 `TurnAdmission`

仓库里已有 `src/core/turn-admission.mjs`（v2 接力协议，`matchesReport()` 用 `{id, attempt, token}` 三元组绑定原生回合），但：

- `plugin2.mjs` **没有 import 它**，属于「保留能力，未在 UI 暴露」（HANDOVER §模块表）；
- 它要求精确回合绑定，而成员会话的锚定正在失败，接进来会先被同一类问题打死；
- 它的前提是「Lead 先 expect，再投递，再等 turn/end」，与现在 `dispatch` 的异步投递模型不同构。

结论：作为 v2 遗留参考，**V3 不接**；但它的「幂等回执 + OBSOLETE_RESULT」错误码语义值得抄（见 §4.2/§5.3）。

### 2.5 同一个会话属于多个整体

- 候选集跨整体合并；歧义时返回自己的 requestId，模型或 Lead 用 `requestId` 收敛。
- 不允许「按整体名」选择——整体名不是身份。

---

## 3. 与 guard 的关系

现有 guard（`plugin2.mjs:1137-1156`）的顺序是：主会话直接放行 → 非成员直接放行（交给工具体）→ `ms2_` 前缀一律拒 → 其余按角色策略。

`ms2_report` 会被第 3 步打死。**最小改动**是在前缀判断之前加一个显式白名单：

```js
// 只允许成员用这一个 ms2_ 工具；其余 ms2_ 仍然一律拒绝。
const MEMBER_REPORT_TOOL = 'ms2_report';
...
if (exec.name === MEMBER_REPORT_TOOL) return;           // 允许，具体校验在工具体内
if (typeof exec.name === 'string' && exec.name.startsWith('ms2_')) {
    return 'MS2_MEMBER_DENIED: 成员不能直接使用协调体工具，请经主会话';
}
```

要点：

1. **白名单放在成员分支里**，不是全局：主会话早在 `:1142` 就 return 了，不受影响；非成员在第 `:1145` 也 return 了，仍然由工具体拒绝。
2. **guard 只做粗放行**：它拿得到 `exec.agent.id`，拿不到「当前在途工单」「当前 turn」，所以细校验必须在工具体。两层职责写进注释：guard = 策略面，工具体 = 授权面。
3. **不要改 `roles.mjs` 的 `CROSS_SESSION_TOOLS`**：`ms2_report` 不是跨会话通道（不指定目标会话），放进去反而会让 `policyFor` 把它 deny 掉。
4. **回归测试要钉住**：成员调 `ms2_report` 放行、调 `ms2_status` 仍拒、主会话调 `ms2_report` 时走工具体而不是 guard。

---

## 4. 账本写入

### 4.1 选型：新增 `kind:"report"`，不伪装成 `settled`

| 方案 | 优点 | 缺点 |
|---|---|---|
| 复用 `settled` + `source:"member-report"` | 改 `rebuildTasks` 最少；面板无需改 | 无法表达「已上报但未核实」；与对账写下的 `settled` 同形，事后分不清「谁说的」；将来想加重试/撤销语义没位置 |
| **新增 `kind:"report"`**（推荐） | 来源、turn、摘要、provisional 都能落；对账可后置复核并覆盖；`rebuildTasks` 只需多一个分支 | 要改 `KINDS`（`ledger.mjs:9`）与 `rebuildTasks`（`:71`）；面板要多认一个 kind |

推荐新增。风险可控：`KINDS` 是白名单集合，加一个字符串；`rebuildTasks` 是显式 switch，漏写会直接体现在单测里。

### 4.2 事件形状

```jsonc
{"at":"2026-11-07T09:20:00.000Z","kind":"report",
 "requestId":"ms-<requestId>",
 "sessionId":"session-<uuid>",
 "status":"completed","summary":"完成全部测试全绿",
 "turn":28,                       // 可为 null（锚定失败时）
 "source":"member-report",        // 重启前遗留单写 member-report-after-restart
 "reportKey":"<sha256(sessionId|requestId|turn|status|summary|detail)>",
 "detail":{…}}
```

`reportKey` 落盘是为了幂等：同一 key 再来 → `duplicate:true`，不追加；不同 key 且任务已终态 → `REPORT_CONFLICT`。

### 4.3 `rebuildTasks` 的新分支与「谁赢」

重放顺序（后写覆盖前写）：

```
dispatch → (report | settled | human | resolve | uncertain)
report(completed)      → state='completed', provisional=true,  source='member-report'
report(blocked)        → state='needs_human', provisional=false
report(failed)         → state='failed',      provisional=false
settled                → state=…, provisional=false, verified=true（对账/事件赢）
human                  → state='needs_human'（人类插话赢）
```

**去重与优先级规则（写死）：**

1. `report` 只从 `delivered` / `uncertain` 出发；`needs_human` 必须先由主会话 `ms2_resolve`，否则 `REPORT_TASK_STATE`。
2. 同一 `reportKey` 重复 → 幂等成功，账本不追加。
3. `completed(provisional)` 之后又来 `settled`（对账/事件）→ **对账赢**，`verified=true`；若对账证据是 `failed`，覆盖为 `failed` 并记 `supersededBy:"history-reconcile"`。
4. `settled`（verified）之后再来的 `report` → `REPORT_CONFLICT`（不覆盖已核实结论）。
5. `report` 与 `human` 竞争：`human` 已经把任务改成 `needs_human` 时，report 返回 `REPORT_TASK_STATE`，不抢人类的裁决权。

### 4.4 对账侧要开一个小口子

`reconcileTasks`（`plugin2.mjs:666`）现在只捞 `delivered` / `uncertain`。加上：

```js
task.state === 'delivered' || task.state === 'uncertain' ||
(task.state === 'completed' && task.provisional === true)
```

否则一条「模型说完成了但没干」的上报会永远 `provisional`，没人复核。候选集通常 0–1 条，不增加可观测开销；对账仍然只接受 completed 证据（`coordinator.mjs:274` 的既有约束不变）。

**这不替代对账**：成员崩溃/模型失败/忘记上报时，`delivered` 仍然靠 `ms2_status`/面板/重启对账自愈，V3 只是把「正常完成」这一条主路径的延迟从 17 分钟压到一次工具调用。

---

## 5. 状态机与异常路径

### 5.1 状态转移

```
                 ┌──────────── report(completed) ──────────► completed(provisional)
                 │                                                   │
dispatch ──► delivered ── report(blocked) ──► needs_human      settled(verified)
                 │  │                              ▲                 ▲
                 │  └── report(failed) ──► failed   │                 │
                 │                                  │                 │
                 └────────── reconcile ────────────┴─────────────────┘
restart ──► uncertain ── report(completed) ──► completed(provisional, after-restart)
                    └──── reconcile ──► settled
```

### 5.2 异常路径逐条

| 场景 | 行为 | 账本 |
|---|---|---|
| 没有在途单 | `REPORT_NO_TASK` | 不写 |
| 多条在途、未消歧 | `REPORT_AMBIGUOUS` + 自己的 requestId 列表 | 不写 |
| 给了别人的 requestId | `REPORT_NO_TASK`（不泄露存在性） | 不写 |
| 调用者不是任何整体成员 | `REPORT_NOT_MEMBER` | 不写 |
| `ready` 未完成 / `state.error` | `REPORT_NOT_READY`（复用 `readyError()`） | 不写 |
| 任务已在 `needs_human` | `REPORT_TASK_STATE`（提示先 `ms2_resolve`） | 不写 |
| 任务已 verified | `REPORT_CONFLICT` | 不写 |
| 同 key 重复 | `ok, duplicate:true` | 不写第二条 |
| 账本 append 失败 | `REPORT_LEDGER_FAILED`；内存状态回滚 | 不写（或半行？`TaskLedger` 串行原子追加，按现状不会半行） |
| 重启后 `uncertain` | 允许上报，`source=member-report-after-restart` | 写 `report` |
| 上报后模型继续干活/失败 | provisional 保留，等 `turn/end` 或对账覆盖 | 由对账升级 |
| 同一会话被两个整体派了单 | 歧义 → 用 `requestId` 收敛 | 写一条 |

### 5.3 错误码（与现有风格对齐）

| code | 语义 | 模型可自助修复 |
|---|---|---|
| `REPORT_BAD_ARGUMENT` | JSON 坏 / status 非法 / summary 空 | 是（改参数重试） |
| `REPORT_NO_TASK` | 自己名下没有在途单 | 否（等派单） |
| `REPORT_AMBIGUOUS` | 多条在途，需 `requestId` | 是（带 requestId） |
| `REPORT_NOT_MEMBER` | 不是任何整体成员 | 否 |
| `REPORT_NOT_READY` | 插件未就绪 | 否（重试一次） |
| `REPORT_TASK_STATE` | 状态不允许（needs_human/已终态） | 否（找主会话） |
| `REPORT_CONFLICT` | 与已核实结论或已有上报冲突 | 否 |
| `REPORT_LEDGER_FAILED` | 写盘失败 | 可重试 |

命名沿用 `OBSOLETE_RESULT`（`scheduler.mjs:337`）一类的「大写_下划线」，便于 grep 与测试断言。

---

## 6. 验收

### 6.1 单测可证（`tests/coordinator-report.test.mjs`）

1. **单在途上报**：`dispatch` → `report({status:'completed'})` → 任务 `completed`、`provisional:true`、`source:'member-report'`；账本恰好多一行 `kind:'report'`。
2. **幂等**：同 `reportKey` 连报两次 → 第二次 `duplicate:true`，`tasks.jsonl` 行数不变。
3. **冲突**：不同 `summary` 再报 → `REPORT_CONFLICT`，账本不变。
4. **无在途**：直接报 → `REPORT_NO_TASK`，账本不变。
5. **歧义与隔离**：同会话两单 → 不带 requestId 报 `REPORT_AMBIGUOUS`；带别人的 requestId → `REPORT_NO_TASK`；带自己的 → 命中且只写一条。
6. **非成员**：普通会话调用 → `REPORT_NOT_MEMBER`。
7. **重启单**：`recover` 把单降为 `uncertain` → report(completed) → `completed` + `source:'member-report-after-restart'`。
8. **对账覆盖**：report(completed) 后，`reconcileFromHistory` 拿到 `turn/end reason=failed` → 任务变 `failed`、`verified:true`、`supersededBy:'history-reconcile'`；`rebuildTasks` 重放后状态一致。
9. **guard 白名单**：成员 `ms2_report` 放行、`ms2_status` 仍 `MS2_MEMBER_DENIED`；主会话调 `ms2_report` 不被 guard 拦（进入工具体后报 `REPORT_NO_TASK`）。
10. **账本重放**：直接把 §4.2 的样例行喂给 `rebuildTasks`，状态/`provisional`/`source` 全对。

### 6.2 真机（重启一次，只派无害单）

**A. 主路径时延**
1. 重启宿主，确认 `plugin.log` 的 `dataDir` 是 `<你的 DSH_HOME>\supergroup`。
2. 主会话派单给打工人，正文末尾带「完成后调用 `ms2_report`」。
3. 成员回报后，**立刻**（不点面板、不调 `ms2_status`）看账本：
   `Select-String tasks.jsonl -Pattern '"kind":"report"'` 应出现一行，`at` 与成员 `turn/end` 相差秒级。
4. 断言：那行 `sessionId` 是打工人、`source:'member-report'`、`status:'completed'`；`ms2_status` 里该单 `verified` 仍为 false（对账前）。

**B. 自愈不变**
1. 派单后立刻杀掉成员会话的回合（或让它 `sleep` 到超时）。
2. 不重启，直接 `ms2_status` → 该单仍应被 `history-reconcile` 结算；账本出现 `settled` + `source:"history-reconcile"`。

**C. 幂等**
让成员在回报里调两次 `ms2_report`（同参数）→ 账本仍只有一行 `report`。

**D. 隔离**
让成员尝试报一个它看到的、不属于自己的 `requestId` → 返回 `REPORT_NO_TASK`，账本无新增。

**E. 成员权限回归**
成员调 `ms2_status` → 仍是 `MS2_MEMBER_DENIED`；业务工具（读文件/跑测试）不受影响。

---

## 7. 风险清单与缓解

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | 模型「抢跑」：活没干完就报 completed | 状态虚高，主会话误判 | `provisional:true`；对账复核（§4.4）；面板显示「未核实」；`summary` 要求写可核验证据（测试命令/文件） |
| 2 | 模型忘记上报 | 退回现状（等对账），不会更差 | 派工文案加一行固定提示（§2.3 的模板，先只加提示不加 nonce） |
| 3 | 上报刷屏 / 循环调用 | 账本膨胀 | `reportKey` 幂等；同单第二次起 `duplicate` |
| 4 | 同会话多单歧义 | 误结算 | 强制 `requestId` 收敛；仍歧义就报错 |
| 5 | 跨整体成员误报别家单 | 越权 | `sessionId === caller` 恒过滤；查询结果只回自己的单 |
| 6 | guard 白名单写错，顺带放开了别的 `ms2_` | 成员越权 | 白名单用精确等于，不用 `startsWith`；单测钉住 `ms2_status` 仍拒 |
| 7 | 账本新 kind 漏进 `rebuildTasks` | 重启后状态丢失 | 单测 10；`KINDS` 与 switch 同文件审查 |
| 8 | `report` 与 `human` 抢状态 | 人类插话被覆盖 | 顺序规则 §4.3 第 5 条；`needs_human` 下直接拒报 |
| 9 | 对账把 provisional 误升级 | 假完成变真完成 | 对账仍只接受 `turn/end completed` 证据；失败/未结束不升级 |
| 10 | 成员会话 rpcId 锚定 bug 未修 | 事件快路径继续漏 | V3 不依赖锚点；另开后端 issue（§0 证据已备） |
| 11 | 上报正文过长 | 账本行过大 | `summary` ≤2000、`detail` ≤8KB，超限 `REPORT_BAD_ARGUMENT` |

---

## 8. 需 Lead 拍板的取舍

1. **上报即终态（provisional）还是必须等对账确认？**
   建议 provisional：延迟从 17 分钟降到秒级，同时保留对账复核。代价是面板要能显示「未核实」。
2. **账本用新 `kind:"report"` 还是复用 `settled` + `source`？**
   建议新 kind：来源、turn、provisional 都可追溯，代价是 `rebuildTasks`/面板各加一个分支。
3. **要不要允许 `requestId` 消歧？**
   建议允许（只能命中自己的单）；若坚持「完全不接受任何 ID」，歧义时直接报错，由主会话串行重派，代价是多一轮往返。
4. **派工正文要不要加「完成后调 ms2_report」的固定模板？**
   建议加（一行常量，不是自由文本通道）；不加的话成员大概率不知道有这个工具，V3 等于白做。
