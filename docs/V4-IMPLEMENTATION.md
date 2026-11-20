# V4 实现记录：成员通知、频控与唤醒失败可见

版本：1.3.0

本文记录 v4 相对 v3.2 的实际实现、与设计稿的差异、测试证据，以及只能在真实宿主上完成的验收项。它不替代 [V4-WAKE.md](V4-WAKE.md) 的设计说明，也不把单测结果说成真机通过。

## 1. 改了什么

| 文件 | 改动 |
| --- | --- |
| `src/core/wake.mjs` | 重写为双出口：`wake()` 保留上报唤醒；新增 `wakeNotify()`。增加共用限流器、notify 去重、5 秒有界 ack、失败回调 `onFailure`。 |
| `src/core/ledger.mjs` | `KINDS` 增加 `wake-failed`；新增 `recentKind(kind, limit)`，只读账本、不建立第二份内存索引。 |
| `src/plugin2.mjs` | 新增 `ms2_notify` 工具；guard 白名单改为集合 `{ms2_report, ms2_notify}`；`ms2_status` 增加 `wakeEvents` 与 `wakeWriteErrors`；`/ms2 panel` 返回 `wakeEvents`；waker 的 `onFailure` 同时写内存 ring 与账本。 |
| `src/core/coordinator.mjs` | 未改。上报后调用注入的 `onReported`，唤醒结果只体现在 `wake` 字段，不影响上报。 |
| `client/client.js` | 整体卡片增加「唤醒失败 N」徽标；右栏「已有整体」下方增加「通知与唤醒失败」区块。 |
| `tests/notify.test.mjs` | 新增 12 条测试，覆盖设计 §10。 |
| `tests/plugin2.test.mjs` | guard 断言扩展为 `ms2_report` / `ms2_notify` 精确放行，前缀相似名仍拒。 |
| `package.json` | 版本 1.3.0。 |
| `README.md` | 增加「无工单通知」能力、`ms2_notify` 工具行、面板失败区块说明、1.2.x→1.3.0 升级说明。 |
| `docs/status_summary.md` | 能力表、测试数、已知边界同步。 |
| `docs/usage_manual.md` | 增加成员主动上报后的唤醒说明、`ms2_notify` 用法与权限行。 |

## 2. 行为约定

### 2.1 `ms2_notify`

- 参数只有单字符串 `request`，JSON 内只允许 `summary` 与 `detail`；出现任何身份字段（`requestId`、`memberId`、`leadId`、`sessionId` 等）直接 `NOTIFY_BAD_ARGUMENT`。
- 调用者身份只取 `exec.agent.id`。
- 归属由 `GroupsStore.groupsWithMember(caller)` 决定：
  - 0 个整体：`NOTIFY_NO_GROUP`；
  - 1 个整体：投给该整体 lead；
  - 2 个及以上：`NOTIFY_AMBIGUOUS`，返回 `candidates`，**零投递**。
- 文本固定为 `[成员通知] <成员label> · <整体名>：<summary>（详情：调用 ms2_status）`。

### 2.2 频控与去重

- 每成员 60 秒滑动窗口 6 条；`ms2_report` 唤醒与 `ms2_notify` 共用同一计数器。
- 通过去重后、真正开始投递时计数；`duplicate`、`skipped-self`、参数/归属失败不计数。
- notify 去重键为 `sha256(caller + "\n" + groupId + "\n" + cleanSummary).slice(0, 16)`，窗口 60 秒。
- requestId：`ms-wake-notify-<group 8 位>-<dedupeKey 8 位>-<minuteBucket>`。重启后同一分钟、同一摘要由宿主 `hasPromptRequest` 吸收，不会重复开回合。
- 所有唤醒 `mode: "followup"`，不使用 `steer`；频控是进程内状态，重启清零。

### 2.3 失败与可见性

- 失败、限流、超时都写 `wake-failed` 账本行；成功唤醒不写账本。
- 账本写失败时，失败对象进入 `state.wakeWriteErrors`，并在 `ms2_status.data.wakeWriteErrors` 暴露。
- `ms2_status.data.wakeEvents` 与 `/ms2 panel` 的 `wakeEvents` 取最近 20 条、按可见整体过滤、`at` 倒序，来源是账本 `recentKind("wake-failed", 200)` 与内存 ring 的并集。
- 5 秒看门狗只中断准入并返回 `WAKE_TIMEOUT`；宿主可能仍在排队，因此失败行带 `maybeQueued: true`。

## 3. 与设计稿的差异

1. **lead 为空无法在 `groups.json` 层构造**：`registry.normalizeConfig` 强制 lead 非空字符串。设计 §10 的「lead 为空 → skipped-no-lead」在 waker 层用空 `leadSessionId` 覆盖，测试 10 因此直接调 waker，而不是构造坏注册表。
2. **notify 摘要超长选择截断而不是拒绝**：设计 §2 写「summary 必填 ≤200 码点」，§10 又要求「超长摘要按码点截断」。实现选择先清洗、再按码点截断到 200，不拒绝；这样与上报唤醒的文本模板一致，也避免成员因为多写几个字被整条拒绝。
3. **`wakeWriteErrors` 额外暴露**：设计要求「append 失败走 writeErrors + 内存 ring」；除内存 ring 外，`ms2_status` 也返回最近 20 条，便于真机排查。
4. **面板只显示整体级计数**：当前面板没有逐工单行，因此卡片只能显示「唤醒失败 N」，逐条详情放在下方失败区块。

## 4. 测试证据

```bash
node --check src/plugin2.mjs
node --check client/client.js
node --test tests/*.test.mjs
```

结果：**182 tests / 182 pass / 0 fail**。其中 `tests/notify.test.mjs` 12 条：

1. 正常通知：模板、lead、requestId；
2. 无整体 → `NOTIFY_NO_GROUP`；
3. 两个整体 → `NOTIFY_AMBIGUOUS` + 候选，零投递；
4. 第 7 条限流，且账本恰好一行 `wake-failed`；
5. 同摘要 10 次只投 1 次，其余 9 次 `duplicate`；
6. 不同摘要都投；
7. prompt 抛 `session/agent-busy` → `wake:error`，账本记录 code；
8. prompt 永不 settle → 注入 timer 触发 `WAKE_TIMEOUT`，`maybeQueued:true`；
9. lead 忙但 prompt 接受 → `sent`；
10. lead 为空 → `skipped-no-lead` + `WAKE_NO_LEAD`；
11. 账本重开后 `recentKind` 仍可读；
12. 260 个 emoji 摘要截到 200 且 `isWellFormed()`。

单测不能证明的：真实宿主的 `followup` 排队顺序、忙碌 lead 的实际回合边界、面板视觉、重启后旧失败行的实际渲染。

## 5. 真机验收（A1–A6）

| 编号 | 操作 | 判定依据 |
| --- | --- | --- |
| A1 | lead 空闲；成员执行 `ms2_notify {summary:"A1 ping"}` | 返回 `wake:"sent"`；≤60 秒内 lead 出现新回合；判定依据改为 lead 会话日志里的 `user/message` 带 `ms-wake-notify-` 前缀，或轮转后的 `session-events.log` / `session-events.log.1`；回合内可见「[成员通知] … A1 ping」 |
| A2 | lead 正在跑长回合；成员连发 2 条不同摘要 | 两条都 `wake:"sent"`；`spliced` 的 `target` 为 `next-turn`；当前回合不被打断；下一回合依次看到两条 |
| A3 | 同一成员 60 秒内连发 10 条相同摘要 | 第一次 `sent`，其余 9 次 `duplicate`；lead 只被叫起 1 次；账本 0 条 `wake-failed` |
| A4 | 同一成员 60 秒内发 8 条不同摘要 | 前 6 条 `sent`，后 2 条 `rate-limited`（`retryAfterMs>0`）；账本 2 行 `wake-failed`，`code=WAKE_RATE_LIMITED`；面板显示这 2 条 |
| A5 | 停掉 lead 会话，或构造 controller 抛 `session/not-found` 后成员 notify | 成员侧 `wake:"error"`；账本 1 行 `wake-failed`，`code=session/not-found`；面板可见时间/整体/成员/摘要/错误码 |
| A6 | 重启宿主后打开面板 | 失败区块仍显示 A4/A5 的历史行（来自账本，不依赖内存）；每组成员关系与工单数不变 |

重启后需要重点看的三处：

1. `%DSH_HOME%\supergroup\tasks.jsonl` 是否出现 `"kind":"wake-failed"`，字段是否含 `code`、`outcome`、`maybeQueued`；
2. `ms2_status.data.wakeEvents` 是否与面板「通知与唤醒失败」一致；
3. `ms2_notify` 在单整体成员下返回的 `requestId` 是否以 `ms-wake-notify-` 开头，且 lead 回合内文本格式正确。

## 6. 观测日志轮转（W14）

`session-events.log` 仍以 256 KiB 为上限，但不再“到上限永久停写”：

- 达到上限时把当前文件改名为同目录 `session-events.log.1`（覆盖旧 `.1`，只保留一代），当前文件从 0 继续写；
- 启动时若发现文件已超上限，也先按同样规则轮转；
- 轮转失败（例如 `.1` 被目录占用）只置 `logTruncated: true` 并记录错误，绝不抛出、不影响归集；
- 不新增定时器，也不改变 `ms2_status.logTruncated` 的语义。

新增 3 条测试：启动超限轮转、写入达上限轮转并继续写、轮转失败置位不抛错。因此 A1 的 `spliced` 判定改为看 lead 会话日志，或看轮转后的 `session-events.log` / `.1`，旧日志停写不再作为唯一依据。
