# V4 唤醒设计：成员能及时叫醒主会话

> 状态：设计稿（未实现）。基线 `5daaefc chore: release 1.2.1`。
> 范围：在现有「上报即唤醒」之上补三个缺口——无工单也能通知、唤醒频控、失败可见。
> 已拍板、不再讨论：不做 steer；新增 `ms2_notify`；双向对话放到下一版且不预留接口；每成员每分钟 6 条（report 唤醒与 notify 统一计数）；身份只取 `exec.agent.id`；唤醒失败必须落账并可见。

## 0. 结论先行

1. **新增 `ms2_notify`**：入参只有一个字符串 `request`（`summary` 必填、`detail` 可选），**不接受**任何 requestId / 成员 id / 主会话 id，杜绝伪造对象；成功返回 `wake` 结果，失败只返回校验类错误。
2. **成员到主会话的归属用 `groups.json` 反查，答案唯一**：属于 0 个整体 → 报 `NOTIFY_NO_GROUP`；属于 1 个整体 → 通知该整体的 lead；属于多个整体 → **拒绝并报 `NOTIFY_AMBIGUOUS`，不广播**（广播会重复唤醒、频控归属不清、模板里整体名歧义）。
3. **频控**：每成员 60 秒滑动窗口 6 条，内存计数，report 唤醒与 notify 共用；超限不抛工具错误，返回 `wake:'rate-limited'` 并写 `wake-failed/WAKE_RATE_LIMITED`。
4. **幂等**：report 沿用 `ms-wake-<task>-<status>`；notify 用 `sha256(成员+整体+摘要)` 前 16 位做 `dedupeKey`，同 key 60 秒内只唤醒一次；唤醒 requestId 带「分钟桶」，重启后同一分钟内的重复也会被宿主 `hasPromptRequest` 挡掉。
5. **失败可见**：`prompt` 抛错 / 拒绝 / 5 秒超时 / 无 controller / 无 lead 一律写 `kind:"wake-failed"` 账本行；面板新增「通知与唤醒失败」区块，读账本最近 20 条，不改轮询。
6. **不改的东西**：不动 `ms2_report` 的语义与状态机；不动 `history-reconcile` 兜底；不引新定时器；不改客户端轮询频率；不碰 steer。

## 1. 机制与数据流

### 1.1 保留的现有链路（v1.2.1）

```
成员 ms2_report
  → plugin2.mjs:836 ms2_report handler（caller = exec.agent.id）
  → Coordinator.report()（coordinator.mjs:251 串行队列）→ #reportNow (:256)
  → 校验身份/工单状态 → 写 kind:"report" 账本 (:332) → 更新内存
  → onReported({groupId, leadSessionId, reporterSessionId, taskRequestId, status, state, label, summary})
  → waker.wake() → sessionController.prompt({mode:'followup'}, signal)   ← 不 await
  → report 返回 data.wake = sent | duplicate | skipped-self | skipped-no-lead | error
```

### 1.2 新增链路

```
成员 ms2_notify({"summary":"…","detail":"…"})
  → plugin2.mjs 新增 handler（caller = exec.agent.id，先 readyError()）
  → 归属反查 groups.mjs:groupsWithMember(caller) → 唯一 group + group.lead()
  → waker.wakeNotify({groupId, leadSessionId, reporterSessionId, label, groupName, summary, detail})
      → 频控 reserve(sessionId) → 去重 dedupeKey（60s）→ 生成 requestId → prompt(followup)
      → 失败：写 wake-failed 账本 + 内存 ring
  → 返回 {status:'ok', data:{wake, wakeCode?, groupId, leadSessionId, requestId, dedupeKey}}
```

两条链路在 `waker` 汇合：**同一个出口、同一个计数器、同一套失败落账**，区别只在模板与 requestId 前缀。

### 1.3 宿主语义（据 `<DSH 安装目录>/resources/app.asar` 源码核实）

- `async prompt(request, source)` 在准入完成后**立即返回 `{accepted:true}`**，不等回合结束；`followup` 在回合边界插入，忙时排队。
- `if (this.hasPromptRequest(agent.session, request.requestId)) return { accepted: true };` 位于准入最前——**同一 requestId 重复投递天然幂等**（跨插件重启同样有效，因为按会话持久化判定）。
- 失败抛 `RemoteError`：`session/agent-busy`（`prompt rejected`）、`session/not-found`、`session/attachment-invalid`。
- 结论：正常路径毫秒级 ack，因此「5 秒看门狗」不会误伤慢回合；超时只可能是准入卡住或 controller 异常。

## 2. 工具面：`ms2_notify`

### 2.1 schema

沿用本插件既有风格（`request` 为单字符串，`:209 toolDefinition`）：

```json
{"name":"ms2_notify",
 "description":"通知你所在整体的主会话（不需要工单）。summary 必填 ≤200 字；同一摘要 60 秒内只唤醒一次；每分钟最多 6 条。",
 "params":{"request":"JSON 字符串：{\"summary\":\"…\",\"detail\":\"…\"}"}}
```

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `summary` | 是 | 先 `cleanWakeSummary`（去控制字符、折叠空白、trim），空 → `NOTIFY_BAD_ARGUMENT`；按码点截 200 |
| `detail` | 否 | 同样清洗，截 2000；**只进账本失败行与返回，不进唤醒文本** |
| 其它字段 | — | 出现 `requestId` / `memberId` / `leadId` / `sessionId` 等 → `NOTIFY_BAD_ARGUMENT`（不静默忽略，避免调用方误以为能指定对象） |

### 2.2 返回

成功一律 `reply('ok', …, data)`：

```json
{"wake":"sent|duplicate|rate-limited|skipped-no-lead|error",
 "wakeCode":"WAKE_RATE_LIMITED|WAKE_NO_LEAD|WAKE_TIMEOUT|WAKE_FAILED|null",
 "groupId":"g-…","leadSessionId":"session-…",
 "requestId":"ms-wake-notify-…","dedupeKey":"a1b2c3d4e5f60718"}
```

`wake:'duplicate'` 时 `requestId` 是上次那条（同 key 同分钟桶必然相同），便于排查。

### 2.3 与 `ms2_report` 的关系

- **独立工具、独立模板、共用出口**：report 的 requestId 由工单决定（`ms-wake-<task>-<status>`），notify 的由「整体+摘要+分钟桶」决定；二者互不去重（语义不同）。
- report 的返回结构与状态机**零改动**；`data.wake` 只是多出 `rate-limited` 这个取值。
- guard 白名单从「只豁免 `MEMBER_REPORT_TOOL`」扩成集合 `MEMBER_WAKE_TOOLS = {ms2_report, ms2_notify}`（`plugin2.mjs:1274` 那个判断改成集合判断），其余 `ms2_*` 仍拒绝。

## 3. 归属解析：成员 → 它的 lead

**唯一判定，按顺序短路**（数据源 `groups.mjs:groupsWithMember(sessionId)`）：

| 成员所属整体数 | 结果 |
| --- | --- |
| 0 | 工具错误 `NOTIFY_NO_GROUP`（"你不在任何整体里，无法通知"） |
| 1 | 取 `group.lead`（等于 `group.registry.lead()`）；为空 → `skipped-no-lead` + `wake-failed/WAKE_NO_LEAD` |
| ≥2 | 工具错误 `NOTIFY_AMBIGUOUS`，`data.candidates=[{groupId,name}]`，**拒绝，不广播** |

为什么多整体必须拒绝，而不是全部通知：

1. 广播会把同一段摘要抄送给多个 lead，其中多数与该成员当前工作无关；
2. 频控是「每成员」计数，广播一条实际产生 N 条投递，计数与投递量失真；
3. 唤醒文本必须带整体名，否则 lead 无法判断上下文；广播时摘要相同、整体不同，会产生 N 条近似重复消息；
4. 需要确定性答案，拒绝 + 给出候选整体，让用户/lead 自行用 `ms2_members remove` 收敛，或改用 `ms2_report`（工单自带 groupId，天然无歧义）。

身份与防伪：

- 发送者身份**只**取 `exec.agent.id`；工具参数里没有、也不接受任何身份字段（见 §2.1）。
- 唤醒文本里的 `<成员 label>` 取自 `group.registry.get(caller)?.label`，空则「未命名成员」；不取消息体自称。
- `leadSessionId === caller` 时返回 `skipped-self`，不投递（主会话通常不是成员，防御性判断保留）。

## 4. 频控：每成员每分钟 6 条

### 4.1 数据结构

`wake.mjs` 的 `createWaker` 增加一个内部限流器（不引新文件、不引定时器）：

```js
// 伪代码，保持现有 createWaker({getController, maxErrors}) 签名不变，
// 只多一个可注入选项 { limit: { perMinute: 6, windowMs: 60000, now: () => Date.now() } }
const hits = new Map(); // sessionId -> number[]（毫秒时间戳，升序）

function reserve(sessionId) {
  const now = clock();
  const list = (hits.get(sessionId) ?? []).filter(t => now - t < windowMs);
  if (list.length >= perMinute) {
    const retryAfterMs = windowMs - (now - list[0]);
    hits.set(sessionId, list);
    return { ok: false, retryAfterMs };
  }
  list.push(now);
  hits.set(sessionId, list);
  return { ok: true, remaining: perMinute - list.length };
}
```

### 4.2 计数口径

- 计入：notify **通过去重后**、report **通过校验后**，真正要投递的每一次（不论最终 sent / error / timeout）。理由：失败也消耗了主会话的注意力与宿主调用。
- 不计入：`duplicate`（没有产生消息）、`skipped-self`、参数/归属校验失败。
- 剪枝：每次 reserve 时按窗口过滤，Map 大小随活跃成员数有界（≤ `MAX_GROUPS × MAX_GROUP_MEMBERS` = 400），无需定时清理。

### 4.3 重启语义

内存计数重启清零，**不做持久化**：

- 持久化要么写盘（新文件/新账本行）要么启动扫描，前者增加写放大，后者要定义窗口跨重启的语义，收益低于成本；
- 兜底在宿主：同一 `wake requestId` 重启后重复投递仍被 `hasPromptRequest` 吸收；notify 的分钟桶保证「同一分钟」的重复不会越狱。
- 文档与测试里明确写「重启后额度重置」，避免被当成 bug。

### 4.4 超限行为

| 调用方 | 返回 | 账本 |
| --- | --- | --- |
| `ms2_notify` | `ok` + `wake:'rate-limited'` + `wakeCode:'WAKE_RATE_LIMITED'` + `retryAfterMs` | `wake-failed` 一行 |
| `ms2_report` | 上报照常成功，`data.wake:'rate-limited'` | `wake-failed` 一行 |

**取舍**：report 的唤醒被限流后不会自动补发（report 幂等，重复调用返回 duplicate 不再唤醒）。这是有意的「压风暴优先」；代价被 `wake-failed` 记录与面板暴露，lead 仍可在 `ms2_status` 看到工单状态。

## 5. 幂等与去重

| 来源 | 去重键 | 窗口 | requestId | 重复时 |
| --- | --- | --- | --- | --- |
| report | 任务本身（`reportKey`）+ `sent` 集合 | 进程生命周期（现状） | `ms-wake-<taskRequestId>-<status>` | `wake:'duplicate'`，不投递 |
| notify | `sha256(caller + "\n" + groupId + "\n" + summary)` 前 16 位 hex | 60 秒 | `ms-wake-notify-<groupId 去前缀 8 位>-<dedupeKey 8 位>-<minuteBucket>` | `wake:'duplicate'`，不投递、不计数 |

`minuteBucket = Math.floor(now / 60000)`。这样 requestId 与 60 秒窗口同粒度：重启后同一分钟内的同摘要重复，宿主按 requestId 直接吸收；跨分钟则视为新的通知（合理）。

`dedupeKey` 用摘要原文（clean 后）而不是截断后文本吗？**用 clean 后、截断前**：避免两条长摘要前 200 字相同却被当成同一条，也避免把尾部的无关差异放进来。存储只保存 key 与时间，不保存摘要。

## 6. 唤醒失败：判定、落账、可见

### 6.1 判定

| 情况 | code | outcome |
| --- | --- | --- |
| `getController()` 为空 | `NO_SESSION_CONTROLLER` | failed |
| 没有 lead sessionId | `WAKE_NO_LEAD` | no-lead |
| `prompt` 同步抛 / 返回 rejected Promise | 取 `error.code`，缺省 `WAKE_FAILED`（如 `session/agent-busy`、`session/not-found`） | failed |
| 5 秒未 settle | `WAKE_TIMEOUT` | timeout，并记 `maybeQueued:true` |
| 频控拒绝 | `WAKE_RATE_LIMITED` | rate-limited |

超时实现：`Promise.race([prompt(...), sleep(5000).then(() => { controller.abort(); throw timeout })])`，其中 `sleep` 用 `setTimeout(...).unref?.()`。**这是每次投递的一次性定时器，不是常驻定时器**，符合「不引新定时器/不改轮询」的约束。`abort` 只中断准入，不 steer、不打断 lead 回合。

注意：宿主 prompt 正常是毫秒级 ack（§1.3），若实测发现它在某些版本上会等到回合结束，5 秒就会误报；因此该值做成 `wakeTimeoutMs` 配置项（默认 5000），并在验收里单列一条「确认 prompt 的 ack 时机」。

### 6.2 账本行

新增 `kind:"wake-failed"`（`ledger.mjs:9` 的 `KINDS` 增加一项）：

```json
{"at":"2026-11-20T04:50:00.000Z","kind":"wake-failed","groupId":"g-7894b178",
 "requestId":"ms-wake-notify-g7894b17-a1b2c3d4-29543","taskRequestId":null,
 "memberSessionId":"session-…","outcome":"failed","code":"session/agent-busy",
 "message":"prompt rejected","summary":"…（clean 后截 200）","detail":"…（截 2000，可选）",
 "maybeQueued":false}
```

- `requestId` 用**唤醒请求**的 id（不是工单 id），失败行与成功投递一一对应；`taskRequestId` 仅 report 触发时有值。
- `rebuildTasks()` 对未知 kind 无分支（`ledger.mjs` 重放只在 dispatch 后认 settled/human/resolve/uncertain/adopt），所以新增 kind **不会污染任务状态**；即使 requestId 与某工单同名也无副作用。
- `append` 失败：写 `writeErrors`（既有机制）+ 保留在内存 ring，`ms2_status` 仍能看到，不阻断调用方。

### 6.3 成功也留痕吗

**不写账本**。成功的证据有三处：`ms2_report`/`ms2_notify` 的返回、lead 会话里的 `agent/inbox/spliced`（rpcId 可查）、内存计数。给每次成功都写账本会让 6 条/分钟的上限变成每成员每分钟 6 行写放大，收益不匹配。

## 7. 面板

### 7.1 数据

- `ms2_status` 的 `data` 增加 `wakeEvents: [...]`（最近 20 条失败，按可见整体过滤；字段同 §6.2 的精简版：`at/groupId/groupName/memberLabel/outcome/code/message/summary`）。
- `/ms2 panel` 命令的 payload（`plugin2.mjs:1093` 现在返回 `{groups: groupsSnapshot()}`）增加 `wakeEvents`：`{groups, wakeEvents}`，客户端一次取全。
- 来源：**账本读取**。账本文件是全局的（`ledger.mjs:17` 只按 `file` 构造、`rebuildTasks` 不按整体分区），每个整体在 `recover()` 时已 `ledger.load()` 一次，因此给 `TaskLedger` 加一个 `recentKind('wake-failed', limit)`，面板时按**可见 groupId 过滤**、按 `at` 倒序取前 20 即可，不新增启动 IO。这样**重启后仍然可见**；内存 ring 只兜底「账本写失败」的行。

### 7.2 客户端

`client/client.js` 右列（`:513`「已有整体」）在这之后加一个 `section`：

```
通知与唤醒失败                      [全部 / 仅本组? 不做筛选，保持极简]
────────────────────────────────────────────
04:50:00  猎手 · 打工人  失败(session/agent-busy)  「我在跑测试，稍后…」
04:47:12  猎手 · 打工人  限流(WAKE_RATE_LIMITED)   「第一轮结果…」
（空态：最近没有唤醒失败）
```

- 行字段：`HH:mm:ss` · 整体名 · 成员 label · outcome 徽标（失败/超时/限流/无主会话）· 摘要 60 字 · hover 显示完整 `code/message`。
- `GroupCard`（`:244`）在「未核实 N」旁加 `唤醒失败 N` 徽标（该整体在 `wakeEvents` 里的条数），>0 才显示。
- 刷新沿用现有按钮；**不改任何轮询间隔**，面板打开时拉一次、点刷新再拉一次。

## 8. 改动清单（给实现的边界）

| 文件 | 改动 |
| --- | --- |
| `src/core/wake.mjs` | 新增 `wakeNotify(payload)`、限流器、去重表、超时、失败回调 `onFailure`；保留 `wake()` 与 `errors()` 兼容 |
| `src/core/ledger.mjs` | `KINDS` 加 `wake-failed`；`recentKind(kind, limit)` |
| `src/core/coordinator.mjs` | 无改动（`onReported` 已在）；若要让 report 的 `wake` 透出 `wakeCode`，只加返回字段 |
| `src/plugin2.mjs` | 新增 `ms2_notify` 工具与 handler；guard 白名单改成集合；`ms2_status`/`panel` payload 加 `wakeEvents`；`createWaker` 传入 `onFailure`（写账本 + ring） |
| `client/client.js` | 新增失败区块与徽标 |
| `tests/` | 新增 `tests/notify.test.mjs`，扩展 `tests/wake.test.mjs` |

版本：`1.3.0`（新增工具面与账本 kind）；`docs/status_summary.md`、`docs/usage_manual.md` 同步。

## 9. 错误码表

工具级（抛给调用方，`reply('error', …)`）：

| 码 | 触发 | 是否落账 |
| --- | --- | --- |
| `NOTIFY_NOT_READY` | `readyError()` 非空（启动未完成） | 否 |
| `NOTIFY_BAD_ARGUMENT` | request 非 JSON / summary 空 / 含禁用字段 / detail 超长 | 否 |
| `NOTIFY_NO_GROUP` | 成员不属于任何整体 | 否 |
| `NOTIFY_AMBIGUOUS` | 成员属于 ≥2 个整体 | 否 |

唤醒级（放 `data.wake` / `data.wakeCode`，不抛错）：

| 码 | `wake` | 落账 |
| --- | --- | --- |
| — | `sent` | 否 |
| — | `duplicate` | 否 |
| `WAKE_RATE_LIMITED` | `rate-limited` | 是 |
| `WAKE_NO_LEAD` | `skipped-no-lead` | 是 |
| `NO_SESSION_CONTROLLER` | `error` | 是 |
| `session/agent-busy` / `session/not-found` | `error` | 是 |
| `WAKE_TIMEOUT` | `error` | 是 |

## 10. 测试清单（单测，mock 宿主）

1. `ms2_notify` 正常：mock controller 收到 `prompt`，`mode:'followup'`，文本匹配模板，`wake:'sent'`。
2. 成员不在任何整体 → `NOTIFY_NO_GROUP`，controller 未被调用。
3. 成员属于两个整体 → `NOTIFY_AMBIGUOUS`，`data.candidates` 含两个 groupId，**零投递**。
4. 第 7 条/分钟（notify 与 report 混发）→ `wake:'rate-limited'`，`retryAfterMs>0`，账本恰一行 `wake-failed`。
5. 同摘要 60 秒内重复 → 第二次 `wake:'duplicate'`，controller 只被调用一次，不计数。
6. 不同摘要、同分钟 → 两次都投递（受频控）。
7. `prompt` 抛 `session/agent-busy` → 返回 `wake:'error'`，账本 `wake-failed` 的 `code` 为该值，`message` 截断。
8. `prompt` 永不 settle → 5 秒后 `wake:'error'`、`wakeCode:'WAKE_TIMEOUT'`、`maybeQueued:true`（用可注入 clock/timer，避免真等 5 秒）。
9. lead 忙（prompt 返回 accepted，消息排队）→ `wake:'sent'`，不重试、不等待。
10. `groups.json` 里该整体 lead 为空 → `wake:'skipped-no-lead'`，账本 `WAKE_NO_LEAD`。
11. 重启后 `wake-failed` 仍能从账本读出（`recentKind`），面板 payload 含最近 20 条且按可见整体过滤。
12. 上限 200 字/2000 字：超长摘要按码点截断，不切坏代理对。

## 11. 验收标准（真机，逐条给判定依据）

前置：`git log` 含 v1.3.0；`node --test` 全绿；重启一次宿主（让新工具注册）。

| # | 步骤 | 判定依据 |
| --- | --- | --- |
| A1 | lead 空闲；成员调 `ms2_notify {summary:"A1 ping"}` | 返回 `wake:'sent'`；≤60 秒内 lead 会话出现新回合；`session-events.log` 有 `agent/inbox/spliced`，`rpcId` 以 `ms-wake-notify-` 开头；回合内可见「[成员通知] … A1 ping」 |
| A2 | lead 正在跑一个长回合；成员连发 2 条不同摘要 | 两条都返回 `wake:'sent'`；`spliced` 的 `target` 为 `next-turn`；当前回合不被打断；下一回合依次看到两条 |
| A3 | 同一成员 60 秒内连发 10 条**相同**摘要 | 第一次 `sent`，其余 9 次 `duplicate`；lead 只被叫起 1 次；账本 0 条 `wake-failed` |
| A4 | 同一成员 60 秒内发 8 条**不同**摘要 | 前 6 条 `sent`，后 2 条 `rate-limited`（`retryAfterMs>0`）；账本 2 行 `wake-failed`，`code=WAKE_RATE_LIMITED`；面板「通知与唤醒失败」显示这 2 条 |
| A5 | 停掉 lead 会话（或构造 controller 抛 `session/not-found`）后成员 notify | 成员侧 `wake:'error'`；账本 1 行 `wake-failed`，`code=session/not-found`；面板可见（时间/整体/成员/摘要/错误码） |
| A6 | 重启宿主后打开面板 | 失败区块仍显示 A4/A5 的历史行（来自账本，不依赖内存）；每组成员关系与工单数不变 |

判定用的账本行示例（A4）：

```
{"kind":"wake-failed","groupId":"g-7894b178","requestId":"ms-wake-notify-…",
 "memberSessionId":"session-…","outcome":"rate-limited","code":"WAKE_RATE_LIMITED",
 "summary":"…","at":"2026-11-20T…"}
```

## 12. 风险与不做的部分

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 频控内存态，重启清零 | 重启后短时间可多发 6 条 | 宿主 requestId 去重 + 文档写明；监控 `wake-failed` 计数 |
| report 唤醒被限流后不补发 | 该单的即时提醒丢失 | 账本 `wake-failed` + 面板可见；lead 仍可 `ms2_status` |
| 5 秒看门狗误判（若宿主 prompt 语义变化） | 误记 `WAKE_TIMEOUT` 但消息其实已入队 | `maybeQueued:true` 标注；`wakeTimeoutMs` 可配；验收先确认 ack 时机 |
| 摘要即信道，可能被用来塞长文本/指令 | lead 上下文被污染 | 200 字上限、固定模板、`cleanWakeSummary` 去控制字符；notify 不承载任务语义，不改变任何账本状态 |
| 多整体成员被拒 | 用户觉得麻烦 | 错误里返回候选整体；删除多余成员关系后即可用；或用 ms2_report |
| 账本膨胀 | `wake-failed` 每次失败一行 | 上限 6 条/分钟/成员；面板只读最近 20 条 |

不做：steer 打断；双向对话与任何预留接口；多整体广播；失败自动重试；频控持久化；客户端轮询改造；把 notify 写成新账本「成功」事件。

## 13. 需要主会话拍板的点

1. **多整体成员的策略**：本设计选「拒绝 + 报歧义」。若你更希望「通知所有 lead」，需要同时定义频控如何折算（一条算 N 条？）——我建议维持拒绝。
2. **`wake-failed` 是否只记失败**：本设计不记成功（避免每成员每分钟最多 6 行写放大）。若你需要完整唤醒审计，可加 `wake-sent`，但账本体积会明显增长。
3. **面板位置**：失败区块放右列「已有整体」下方（本设计）；若你觉得应该置顶，改动只在 `client.js` 一处，不影响数据面。
