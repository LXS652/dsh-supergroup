# rpcId 锚定失败定位：跨整体结算被“先到先得”吃掉

> 只读调查，未改动 `src/`、`tests/`、profile 与宿主。基线 = HEAD `8d84460`（v1.1，即 2026-11-07 08:47 起运行的那份代码）。

## 结论

1. **rpcId 没丢，锚定其实成功了。** 持久化 `seq=7093`、实时事件、`agent/inbox/spliced` 三处都带 `data.source={kind:"user",rpcId:"ms-mw65ylbu-jck67jfd"}`，与 requestId 逐字符相等；实时日志 08:50:59.268 那条 `user/message` **没有 reason**，正是锚定命中的证据。
2. **真因：所有整体共用一个 `ResultTracker`。** `plugin2.mjs:354` 是模块级单例，每个整体拿到同一个 tracker；`handleSessionEvent` 又把同一条事件按 `state.coordinators` 插入顺序喂给**每一个** Coordinator（`plugin2.mjs:1110-1112`，顺序 = `groups.json` 顺序）。
3. **排在前面的整体先把结算项吃掉了。** 它调 `tracker.observe`（`coordinator.mjs:246`）时 tracker 里确实有这张单，结算成功、条目被删；但它的 `#tasks` 里没有这张单 → 落进自己的 `#earlySettled`（`coordinator.mjs:250-252`），**不写账本、不改任务**。
4. **属主整体再来时已经晚了。** tracker 条目在 `delivery.mjs:219` 被删，第二个 Coordinator 的 `observe` 返回空；而 `missReason` 看到 `settled.length>0` 就直接返回 undefined（`plugin2.mjs:1069`），所以日志看起来“一切正常”。
5. **`#earlySettled` 只进不出。** 唯一冲刷点在 `dispatch()` 内（`coordinator.mjs:196-199`），要求**同一个 requestId 再次 dispatch**；工单只派一次，所以这些条目永远不会被补写。
6. **统计指纹完全吻合：** `groups.json` 顺序是 `g-dc0fa950 大肥鱼` 第一、`g-7894b178 猎手` 第二；账本 54 条事件快路径结算**全部**属第一整体，第二整体 23 条**全部**靠 `history-reconcile`（事件快路径 0 条）。差异不在会话类型，在整体顺序。
7. **可复现：** 用 HEAD 源码在临时目录跑两 Coordinator 共享 tracker，派单给第二个 → **0 条 settled、任务停在 delivered、turn=null**；改成每个整体一个 tracker → 1 条 settled、`completed/turn=5`。
8. **责任层：插件自身。** 与 `sessionController.prompt` 写入的 source、`agent/inbox/spliced` 转发、事件序列化都无关，三处的 rpcId 都完好；宿主机不需要改。当前 v3 工作树（`plugin2.mjs:356`）仍是单例 tracker，**bug 仍在**。
9. **影响：** 非首个整体每次完成都得等对账触发（`ms2_status`、启动、`/ms2 panel`），延迟可从 4 分钟拖到 20+ 分钟；重启时未结算单会被 `recover()` 误降 `uncertain` 并多写一行，再被启动对账捞回；`#earlySettled` 有轻微内存泄漏。
10. **修复方向：** 给 tracker 条目加“归属判定”，让非属主整体**跳过**而不是删除；或每个整体一个 `ResultTracker`。两者都只在插件内，v3.x 可做。

## 五问证据表

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | 持久化里那条用户消息的 source / rpcId / seq | `source={"kind":"user","rpcId":"ms-mw65ylbu-jck67jfd"}`，与派单 id 相等 | `sessions\--E-~4E0B~8F7D--\session-fdac37ee-…\session.v4.jsonl.zstd`，**seq=7093**，`at=1794041459267`（08:50:59.267Z）；同轮另 3 条 user/message 的 kind 是 `runtime-context`/`plugin`/`time-context` |
| 2 | 实时事件里的 source 形状 | 同为 `{kind:"user",rpcId}`，锚定成功 | `session-events.log` 08:50:59.268 `user/message` 无 reason；`missReason`（`plugin2.mjs:1076-1079`）只有 rpcId 命中才不打 `anchor-miss`。08:50:53.955 的 `turn/start anchor-miss` 是锚点消息**之前**的正常前置事件（`delivery.mjs:199` 未锚定不绑 turn） |
| 3 | bili-whale 成功组的差异 | `source` 形状**完全相同**，没有差异；差异在整体顺序 | bili-whale 持久化 seq=6241（`ms-mw65vkpc-volb9yu6`）、seq=6263（`ms-mw66dts8-95c75k1y`），形状 `{kind:"user",rpcId}`；它们属第一整体 `g-dc0fa950`，settled 无 source（事件快路径） |
| 4 | 差异出现在哪一层 | **插件的事件分发层**：共享 tracker + 按 map 顺序遍历 | `plugin2.mjs:354` 单例；`:1110-1112` 遍历全部 Coordinator；`coordinator.mjs:246-252` 非属主也消费并塞 earlySettled；`delivery.mjs:219` 删除条目；`coordinator.mjs:196-199` 冲刷条件不满足 |
| 5 | 最小修复 | 插件内可修，**不必改宿主** | 见下节 |

补一个可判读的旁证：该单 08:54:45.425 的 `turn/end` 无 reason，而 `missReason` 对 turn/end 只有在 `settled` 非空或 pending 为空时才会返回 undefined；账本里没有 08:54:45 的 settled 行 → 只能是“别处消费了 settled”，与 earlySettled 路径一致。

## 可能的最短修复（2 个候选 + 1 个否决）

1. **归属判定（推荐，约 10 行）**：`ResultTracker.observe(sessionId, event, { owns })` 里加一句 `if (owns && !owns(requestId)) continue;`（跳过、不删）。`Coordinator.observe` 传入 `id => this.#tasks.has(id) || this.#dispatching.has(id)`。非属主整体不再抢单，属主照旧走 `delivery.mjs:208-219`。
2. **每整体一个 ResultTracker（约 30 行）**：`plugin2.mjs` 三处创建点（ready 循环、`createGroup`、命令 create）各 new 一个；`missReason` 的 `tracker.outstanding()` 改为汇总各 coordinator 的 outstanding。结构更干净，但要动 3 处与相关测试。
3. **否决：在 observe 里“事后冲刷 earlySettled”**。它只是把先到先得改成后到先得，语义更乱，且丢失的时刻仍然存在。

建议在 v3.x 做 1，并补一条单测：两组共享 tracker、派单给第二组、喂 anchor+turn/end，断言账本出现 `settled`（现在恒为 0）。另外顺手把 `#record` 的 `.catch(()=>{})`（`coordinator.mjs:42`）改成累加 `writeErrors` 并在 `ms2_status` 暴露，否则账本写失败永远不可见。

## 未确认项

1. 现有日志不记录“哪个 Coordinator 消费了结算”，因此“是第一个整体吃掉”是由代码顺序、组序统计与复现共同推出，不是直接观测。加一行 debug 日志即可证实。
2. 实时事件的完整事件体没有落盘，`data.turn` 形状是按 `missReason` 的输出反推的。
3. 账本里 5 条迁移前（无 `groupId`）的 settled 行未纳入分组统计。
4. 08:54:45 至 09:12:18 之间是否有人手动触发过 `ms2_status` 无日志可查；但若触发过，结算应更早出现——实际没有，反证快路径确实丢了。

## 更正一条旧结论

V3 设计 §0 里写的“打工人会话 rpcId 锚定失败、事件快路径 0 条”**结论对、归因错**：锚定一直成功，丢的是**跨整体结算**。那条 `anchor-miss` 是 turn/start 早于锚点消息的正常记录。
