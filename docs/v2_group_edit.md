# 面板 V2：整体改名与成员增删

本次只做两件事：给整体改名、全量替换执行会话。主会话转移不做，留到 v3。

## 1. 宿主命令

沿用 `/ms2` 命令族，命令后的内容是 `rawInput`（不含 `/ms2 ` 前缀）。

### 1.1 改名

```text
/ms2 group rename {"group":"g-xxxxxxxx","name":"新名字"}
```

- `group`：整体 id；找不到返回 `GROUP_NOT_FOUND`。
- `name`：复用 `src/core/groups.mjs` 的 `normalizeGroupName`，与创建同一套长度/字符集规则；空名或非法字符返回 `GROUP_INVALID_NAME`。
- 与其他整体重名返回 `GROUP_NAME_TAKEN`；与本整体当前名字相同则视为成功。
- 只有该整体 lead 能改名；其他会话返回「只有该整体主会话能改名」。
- 成功后立即修改内存中的 `Group.name` 并原子写 `groups.json`；写盘失败会把内存名字回滚。

### 1.2 全量替换成员

```text
/ms2 group members {"group":"g-xxxxxxxx","members":["session-a","session-b"]}
```

- `members` 是完整的新名单，不是增量；传 `[]` 返回 `GROUP_MISSING_MEMBERS`，超过 8 个返回 `GROUP_TOO_MANY_MEMBERS`（创建路径也统一为最多 8 个）。
- lead 不能出现在 `members` 里，返回 `GROUP_LEAD_CANNOT_BE_MEMBER`。
- 重复 sessionId 返回 `REGISTRY_DUPLICATE_SESSION_ID`；非法 id 返回 `REGISTRY_INVALID_SESSION_ID`。新成员沿用现有 `SessionRegistry`/`add` 的校验口径（id 形状、角色、工具白名单），不额外探测该会话是否真的存在于 DSH。
- 旧成员的 label/roleClass/tools 原样保留；新成员按 registry 默认值补齐，客户端下次保存时会把标题作为 label 带回。
- 被移除的成员如果还有 `delivered` 或 `uncertain` 工单，整次修改拒绝，返回 `GROUP_MEMBER_IN_FLIGHT` 和具体 requestId，提示先用 `ms2_resolve` 或等对账收敛。
- 移除成员不重建 `SessionRegistry` 对象，而是原地替换名单；guard 每次按当前名单现算，所以下一次工具调用就立即按新名单放行/拒绝，不会残留旧策略。
- 只有该整体 lead 能改成员；非 lead 返回「只有该整体主会话能改成员」。
- 成功后原子写 `groups.json`；写盘失败回滚旧名单。

### 1.3 明确不做

- 不删除任何会话、不碰会话历史/日志、不改 `tasks.jsonl`。
- 不停止会话进程，不动其他整体。
- 不支持主会话转移。

## 2. 客户端交互

每张整体卡片标题行新增「编辑」按钮，展开内联编辑区：

1. 文本输入框显示当前整体名，点「保存名称」执行 `group rename`。
2. 成员复选框列表来自 `props.useSessions` 派生出的会话行（与左栏/向导同一份数据），排除该整体 lead；空白会话不排除，仍可选。
3. 当前成员默认勾选，最多可选 8 个；点「保存成员」执行 `group members`。
4. 保存成功重新调用 `/ms2 panel` 拉取快照；失败把宿主返回的错误原文显示在卡片内，不弹 alert，不清空用户输入。
5. 「取消」收起编辑区，不发命令。

没有新增轮询、定时器或宿主接口；折叠逻辑、图标与侧栏标签均未改动。

## 3. 验证

- `node --check client/client.js` 通过；`node --check src/plugin2.mjs`、`src/core/groups.mjs`、`src/core/registry.mjs` 通过。
- 全套测试 144/144 通过，其中新增：
  - 改名成功、落盘、面板快照同步；重名拒绝；非 lead 拒绝。
  - 成员全量替换成功；lead 入列拒绝；被移除成员 guard 立即恢复普通权限。
  - 被移除成员有在途工单时拒绝并报 requestId，名单不变。
- 客户端是独立 bundle，本进程内无法热更；需要重启宿主/刷新页面后才能看到「编辑」按钮。文档不宣称真机通过。

## 4. 重启后验收点

1. 打开面板，任选一个整体卡片，点「编辑」。
2. 改整体名并保存：卡片标题、`groups.json` 里的 name、刷新后的面板快照三处应一致。
3. 勾选/取消一个执行会话并保存：卡片成员列表、`groups.json` 的 members 应同步；被移除的会话在别处再次触发工具时不应再被当作该整体成员。
4. 给一个有在途工单的成员取消勾选并保存：卡片内应显示 `GROUP_MEMBER_IN_FLIGHT` 和 requestId，名单不变。
